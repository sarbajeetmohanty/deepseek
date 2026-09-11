

// Active batches lock to prevent multiple workers from running simultaneously on the same batch
const activeBatches = new Set<string>();

// Cross-batch in-memory solution cache to prevent duplicate DeepSeek API billing for identical questions
const persistentQuestionCache = new Map<string, string>();

// Solve MCQ exclusively using the ultra-fast Google Gemini multi-key pool (100% free, ~2s per question).
async function solveBatchQuestion(opts: {
  raw: string;
  idx: number;
  subjectType: "math" | "gk_english";
  solutionLength: "normal" | "long";
  signal?: AbortSignal;
}): Promise<string> {
  const { formatQuestionWithGemini } = await import("./gemini.server");
  return await formatQuestionWithGemini(opts);
}

export async function processBatchInternal(batchId: string): Promise<void> {
  if (activeBatches.has(batchId)) {
    console.log(`[BatchProcessor] Batch ${batchId} is already actively processing. Skipping duplicate worker.`);
    return;
  }
  activeBatches.add(batchId);

  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: batchRow } = await supabaseAdmin
      .from("batches")
      .select("subject_type, solution_length, user_id")
      .eq("id", batchId)
      .maybeSingle();
    const subjectType = (batchRow?.subject_type === "math" ? "math" : "gk_english") as "math" | "gk_english";
    const solutionLength = (batchRow?.solution_length === "long" ? "long" : "normal") as "long" | "normal";
    const ownerId = batchRow?.user_id as string | undefined;

    // Preload the owner's API-call limit once. If null, no runtime cap.
    let apiCallLimit: number | null = null;
    let apiCallsUsed = 0;
    if (ownerId) {
      const { data: q } = await supabaseAdmin
        .from("user_quotas")
        .select("api_call_limit, api_calls_used")
        .eq("user_id", ownerId)
        .maybeSingle();
      apiCallLimit = (q?.api_call_limit as number | null) ?? null;
      apiCallsUsed = Number(q?.api_calls_used ?? 0);
    }

    const { data: pending, error } = await supabaseAdmin
      .from("questions")
      .select("id, idx, raw_text")
      .eq("batch_id", batchId)
      .in("status", ["pending", "failed"])
      .order("idx", { ascending: true });
    if (error) throw new Error(`Load questions failed: ${error.message}`);
    if (!pending || pending.length === 0) {
      await finalize(batchId).catch((e) => console.error("finalize error", e));
      return;
    }

    // Set concurrency to 10 parallel workers across the 18 Gemini keys pool for ultra-fast throughput
    const CONCURRENCY = Math.min(10, pending.length);
    const ACTUAL_CONCURRENCY = Math.min(CONCURRENCY, pending.length);
    // Flush UI counters every 3 questions for responsive UI progress updates.
    const COUNTER_FLUSH_EVERY = 3;

    // Chunk the IN(...) list — one giant IN on 2000 ids can exceed URL/statement limits.
    for (let i = 0; i < pending.length; i += 400) {
      const ids = pending.slice(i, i + 400).map((q) => q.id);
      const { error: mErr } = await supabaseAdmin
        .from("questions")
        .update({ status: "processing", error: null })
        .in("id", ids);
      if (mErr) console.error("mark processing failed", mErr.message);
    }
    // Reset counters and status now that we've begun.
    await supabaseAdmin
      .from("batches")
      .update({ status: "processing", completed: 0, failed: 0 })
      .eq("id", batchId);

    const queue = [...pending];
    const workers: Promise<void>[] = [];
    const providerBlock: { message?: string } = {};
    // In-batch dedupe: identical raw_text reuses the in-flight promise instead of re-calling the API.
    const dedupe = new Map<string, Promise<string>>();
    
    type QuestionPatch = {
      status?: string;
      formatted_output?: string | null;
      error?: string | null;
    };
    const pendingUpdates: any[] = [];
    
    let doneSinceFlush = 0;
    let failedSinceFlush = 0;
    let apiCallsSinceFlush = 0;
    const flushCounters = async () => {
      if (doneSinceFlush === 0 && failedSinceFlush === 0 && apiCallsSinceFlush === 0 && pendingUpdates.length === 0) return;
      const d = doneSinceFlush, f = failedSinceFlush;
      const c = apiCallsSinceFlush;
      const updatesToFlush = [...pendingUpdates];
      doneSinceFlush = 0; failedSinceFlush = 0; apiCallsSinceFlush = 0; pendingUpdates.length = 0;
      try {
        if (updatesToFlush.length > 0) {
          const { error: uErr } = await supabaseAdmin.from("questions").upsert(updatesToFlush);
          if (uErr) console.error("bulk upsert failed", uErr.message);
        }

        // Recount authoritatively (cheap with idx_questions_batch_status index).
        const [done, failed] = await Promise.all([
          countStatus(batchId, "done"),
          countStatus(batchId, "failed"),
        ]);
        await supabaseAdmin
          .from("batches")
          .update({ completed: done, failed })
          .eq("id", batchId);
        if (ownerId && c > 0) {
          const { error: rpcErr } = await supabaseAdmin.rpc("increment_user_usage", {
            _user_id: ownerId,
            _add_questions: 0,
            _add_calls: c,
          });
          if (rpcErr) console.error("api_calls flush failed", rpcErr.message);
        }
      } catch (e) {
        console.error("counter flush failed", e);
        doneSinceFlush += d; failedSinceFlush += f; apiCallsSinceFlush += c; // put back
        pendingUpdates.push(...updatesToFlush);
      }
    };

    const updateRow = (q: any, patch: QuestionPatch) => {
      pendingUpdates.push({
        id: q.id,
        batch_id: batchId,
        idx: q.idx,
        raw_text: q.raw_text,
        ...patch,
      });
    };

    const worker = async () => {
      while (queue.length > 0) {
        if (providerBlock.message) return;
        // Enforce API-call limit mid-batch (coarse: may overrun by up to CONCURRENCY).
        if (apiCallLimit !== null && apiCallsUsed + apiCallsSinceFlush >= apiCallLimit) {
          providerBlock.message = `API-call limit reached (${apiCallLimit.toLocaleString()}). Ask the admin to raise your limit and retry.`;
          queue.length = 0;
          return;
        }
        const q = queue.shift();
        if (!q) return;

        try {
          const key = `${subjectType}:${solutionLength}:${q.raw_text.trim().replace(/\s+/g, " ")}`;
          let output: string;

          // 1. Check cross-batch session persistent cache (0 tokens / $0.00 cost)
          if (persistentQuestionCache.has(key)) {
            output = persistentQuestionCache.get(key)!;
          } else {
            // 2. Check in-flight batch deduplication
            let job = dedupe.get(key);
            const wasNew = !job;
            if (!job) {
              job = solveBatchQuestion({ raw: q.raw_text, idx: q.idx, subjectType, solutionLength });
              dedupe.set(key, job);
            }
            output = await job;
            if (wasNew) {
              apiCallsSinceFlush++;
              persistentQuestionCache.set(key, output);
            }
          }

          // Re-run the idx replacement so the question number matches this specific row.
          output = output.replace(/^\s*(?:Q\.?\s*)?\d{1,4}[.:)\-–—]?\s+/i, `${q.idx}. `);
          updateRow(q, { status: "done", formatted_output: output, error: null });
          doneSinceFlush++;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // Count failed API attempts too
          apiCallsSinceFlush++;
          updateRow(q, { status: "failed", error: msg.slice(0, 500) });
          failedSinceFlush++;
        }
        if (doneSinceFlush + failedSinceFlush >= COUNTER_FLUSH_EVERY) {
          await flushCounters();
        }
      }
    };

    // Launch all workers immediately in parallel across the multi-key pool

    for (let i = 0; i < ACTUAL_CONCURRENCY; i++) workers.push(worker());
    await Promise.allSettled(workers);
    await flushCounters();

    if (providerBlock.message) {
      const { error: bulkErr } = await supabaseAdmin
        .from("questions")
        .update({ status: "failed", error: providerBlock.message.slice(0, 500) })
        .eq("batch_id", batchId)
        .in("status", ["pending", "processing"]);
      if (bulkErr) console.error("bulk-fail update error", bulkErr.message);
    }

    await finalize(batchId);
  } catch (e) {
    console.error("processBatchInternal fatal", e);
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const msg = e instanceof Error ? e.message : String(e);
      await supabaseAdmin
        .from("batches")
        .update({ status: "failed" })
        .eq("id", batchId);
      await supabaseAdmin
        .from("questions")
        .update({ status: "failed", error: msg.slice(0, 500) })
        .eq("batch_id", batchId)
        .in("status", ["pending", "processing"]);
    } catch (inner) {
      console.error("fatal recovery failed", inner);
    }
  } finally {
    activeBatches.delete(batchId);
  }
}

async function countStatus(batchId: string, status: string): Promise<number> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { count } = await supabaseAdmin
    .from("questions")
    .select("*", { count: "exact", head: true })
    .eq("batch_id", batchId)
    .eq("status", status);
  return count ?? 0;
}

async function finalize(batchId: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  try {
    const done = await countStatus(batchId, "done");
    const failed = await countStatus(batchId, "failed");
    const { data: batch } = await supabaseAdmin.from("batches").select("total").eq("id", batchId).maybeSingle();
    const total = batch?.total ?? 0;
    const status = done + failed >= total ? (failed === 0 ? "completed" : "completed_with_errors") : "processing";
    const { error } = await supabaseAdmin.from("batches").update({ completed: done, failed, status }).eq("id", batchId);
    if (error) console.error("finalize update failed", error.message);
  } catch (e) {
    console.error("finalize threw", e);
  }
}
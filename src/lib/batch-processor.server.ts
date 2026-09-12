

// Active batches lock to prevent multiple workers from running simultaneously on the same batch
const activeBatches = new Set<string>();

// Cross-batch in-memory solution cache for identical questions
const persistentQuestionCache = new Map<string, string>();

// Solve MCQ 100% via the ultra-fast Google Gemini multi-key/multi-model pool (100% free)
async function solveBatchQuestion(opts: {
  raw: string;
  idx: number;
  subjectType: "math" | "gk_english";
  solutionLength: "normal" | "long";
  workerIdx?: number;
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
    const { supabaseAdmin } = await import("../integrations/supabase/client.server");

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

    const initialDone = await countStatus(batchId, "done");

    const { data: pending, error } = await supabaseAdmin
      .from("questions")
      .select("id, idx, raw_text")
      .eq("batch_id", batchId)
      .neq("status", "done")
      .order("idx", { ascending: true });
    if (error) throw new Error(`Load questions failed: ${error.message}`);
    if (!pending || pending.length === 0) {
      await finalize(batchId).catch((e) => console.error("finalize error", e));
      return;
    }

    // 3 dedicated worker streams matching the 3 independent flash-lite quota pools
    const CONCURRENCY = Math.min(3, pending.length);
    const ACTUAL_CONCURRENCY = Math.min(CONCURRENCY, pending.length);

    // Chunk the IN(...) list — one giant IN on 2000 ids can exceed URL/statement limits.
    for (let i = 0; i < pending.length; i += 400) {
      const ids = pending.slice(i, i + 400).map((q) => q.id);
      const { error: mErr } = await supabaseAdmin
        .from("questions")
        .update({ status: "processing", error: null })
        .in("id", ids)
        .neq("status", "done");
      if (mErr) console.error("mark processing chunk failed", mErr.message);
    }

    await supabaseAdmin
      .from("batches")
      .update({ status: "processing" })
      .eq("id", batchId);

    const queue = [...pending];
    const workers: Promise<void>[] = [];
    // In-batch dedupe: identical raw_text reuses the in-flight promise instead of re-calling the API.
    const dedupe = new Map<string, Promise<string>>();
    let completedCount = initialDone;
    let failedCount = await countStatus(batchId, "failed");
    let apiCallsSinceFlush = 0;
    const providerBlock = { message: null as string | null };
    
    type QuestionPatch = {
      status?: string;
      formatted_output?: string | null;
      error?: string | null;
    };
    const pendingUpdates: any[] = [];
    let isFlushing = false;

    const flushCounters = async () => {
      if (isFlushing) return;
      isFlushing = true;
      const updatesToFlush = pendingUpdates.splice(0, pendingUpdates.length);
      const callsToFlush = apiCallsSinceFlush;
      apiCallsSinceFlush = 0;

      try {
        if (updatesToFlush.length > 0) {
          for (let i = 0; i < updatesToFlush.length; i += 200) {
            const chunk = updatesToFlush.slice(i, i + 200);
            const { error: upErr } = await supabaseAdmin
              .from("questions")
              .upsert(chunk, { onConflict: "id" });
            if (upErr) console.error("question upsert chunk failed", upErr.message);
          }
        }

        const { error: bErr } = await supabaseAdmin
          .from("batches")
          .update({
            completed: completedCount,
            failed: failedCount,
            status: "processing",
          })
          .eq("id", batchId);
        if (bErr) console.error("batch counter flush failed", bErr.message);

        if (ownerId && callsToFlush > 0) {
          const { error: rpcErr } = await supabaseAdmin.rpc("increment_user_quota_calls", {
            p_user_id: ownerId,
            p_count: callsToFlush,
          });
          if (rpcErr) console.error("api_calls flush failed", rpcErr.message);
        }
      } catch (e) {
        console.error("counter flush failed", e);
        pendingUpdates.unshift(...updatesToFlush);
        apiCallsSinceFlush += callsToFlush;
      } finally {
        isFlushing = false;
      }
    };

    // Non-blocking background periodic flush timer so workers NEVER pause on DB round-trips!
    const flushTimer = setInterval(() => {
      flushCounters().catch(() => {});
    }, 1200);

    const updateRow = (q: any, patch: QuestionPatch) => {
      pendingUpdates.push({
        id: q.id,
        batch_id: batchId,
        idx: q.idx,
        raw_text: q.raw_text,
        ...patch,
      });
    };

    const worker = async (workerId: number) => {
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

        const key = `${subjectType}:${solutionLength}:${q.raw_text.trim().replace(/\s+/g, " ")}`;
        let output: string | null = null;

        // 1. Check cross-batch session persistent cache (0 tokens / $0.00 cost)
        if (persistentQuestionCache.has(key)) {
          output = persistentQuestionCache.get(key)!;
        } else {
          const MAX_QUESTION_RETRIES = 4;
          let lastErr: any = null;

          for (let retry = 0; retry < MAX_QUESTION_RETRIES; retry++) {
            try {
              output = await solveBatchQuestion({
                raw: q.raw_text,
                idx: q.idx,
                subjectType,
                solutionLength,
                workerIdx: (workerId + retry) % 3,
              });
              if (output && output.trim().length > 0) {
                break;
              }
            } catch (err: any) {
              lastErr = err;
              const msg = (err?.message || "").toLowerCase();
              const isTransient =
                msg.includes("429") ||
                msg.includes("503") ||
                msg.includes("quota") ||
                msg.includes("resource") ||
                msg.includes("demand") ||
                msg.includes("fetch failed") ||
                msg.includes("network");

              if (isTransient && retry < MAX_QUESTION_RETRIES - 1) {
                // Short backoff before worker retries with the next model stream
                await new Promise((r) => setTimeout(r, 1000 * (retry + 1)));
                continue;
              }
              break;
            }
          }

          if (output && output.trim().length > 0) {
            apiCallsSinceFlush++;
            persistentQuestionCache.set(key, output);
          } else {
            const errMsg = lastErr instanceof Error ? lastErr.message : String(lastErr || "Failed to solve question");
            apiCallsSinceFlush++;
            updateRow(q, { status: "failed", error: errMsg.slice(0, 500) });
            failedCount++;
            continue;
          }
        }

        // Re-run the idx replacement so the question number matches this specific row.
        output = output.replace(/^\s*(?:Q\.?\s*)?\d{1,4}[.:)\-–—]?\s+/i, `${q.idx}. `);
        updateRow(q, { status: "done", formatted_output: output, error: null });
        completedCount++;
      }
    };

    // Launch all workers immediately in parallel across dedicated model streams
    for (let i = 0; i < ACTUAL_CONCURRENCY; i++) workers.push(worker(i));
    await Promise.allSettled(workers);
    clearInterval(flushTimer);
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
      const { supabaseAdmin } = await import("../integrations/supabase/client.server");
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
  const { supabaseAdmin } = await import("../integrations/supabase/client.server");
  const { count } = await supabaseAdmin
    .from("questions")
    .select("*", { count: "exact", head: true })
    .eq("batch_id", batchId)
    .eq("status", status);
  return count ?? 0;
}

async function finalize(batchId: string): Promise<void> {
  const { supabaseAdmin } = await import("../integrations/supabase/client.server");
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
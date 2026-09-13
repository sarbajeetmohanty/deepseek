// Server-only batch processor for solving MCQs concurrently across the Gemini multi-key pool

// Active batches lock to prevent multiple workers from running simultaneously on the same batch in this process
const activeBatches = new Set<string>();

// Distributed DB lease parameters (prevents concurrent execution across multiple server instances)
const LEASE_DURATION_MS = 45_000;
const workerInstanceId = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

async function acquireDbBatchLease(supabaseAdmin: any, batchId: string): Promise<boolean> {
  const leaseKey = `batch_lease_${batchId}`;
  const now = Date.now();
  try {
    const { data } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", leaseKey)
      .maybeSingle();

    if (data?.value) {
      try {
        const parsed = JSON.parse(data.value);
        if (parsed.expiresAt && parsed.expiresAt > now && parsed.workerId !== workerInstanceId) {
          console.log(
            `[BatchProcessor] Batch ${batchId} is locked by worker ${parsed.workerId} until ${new Date(parsed.expiresAt).toISOString()}`,
          );
          return false;
        }
      } catch {}
    }

    const { error } = await supabaseAdmin.from("app_settings").upsert(
      {
        key: leaseKey,
        value: JSON.stringify({ workerId: workerInstanceId, expiresAt: now + LEASE_DURATION_MS }),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    );
    return !error;
  } catch (e) {
    console.error("acquireDbBatchLease error", e);
    return true; // Fallback to local memory lock if DB lease table is unavailable
  }
}

async function renewDbBatchLease(supabaseAdmin: any, batchId: string): Promise<void> {
  const leaseKey = `batch_lease_${batchId}`;
  try {
    await supabaseAdmin.from("app_settings").upsert(
      {
        key: leaseKey,
        value: JSON.stringify({
          workerId: workerInstanceId,
          expiresAt: Date.now() + LEASE_DURATION_MS,
        }),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    );
  } catch {}
}

async function releaseDbBatchLease(supabaseAdmin: any, batchId: string): Promise<void> {
  const leaseKey = `batch_lease_${batchId}`;
  try {
    await supabaseAdmin.from("app_settings").delete().eq("key", leaseKey);
  } catch {}
}

// Cross-batch in-memory solution cache for identical questions (capped to prevent memory growth)
const persistentQuestionCache = new Map<string, string>();
const MAX_CACHE_SIZE = 2000;

function setInCache(key: string, value: string) {
  if (persistentQuestionCache.size >= MAX_CACHE_SIZE) {
    const firstKey = persistentQuestionCache.keys().next().value;
    if (firstKey) persistentQuestionCache.delete(firstKey);
  }
  persistentQuestionCache.set(key, value);
}

// Solve MCQ via the ultra-fast Google Gemini multi-key/multi-model pool
async function solveBatchQuestion(opts: {
  raw: string;
  idx: number;
  subjectType: "math" | "gk_english";
  solutionLength: "normal" | "long";
  workerIdx?: number;
}): Promise<string> {
  const { formatQuestionWithGemini } = await import("./gemini.server");
  return await formatQuestionWithGemini(opts);
}

export async function processBatchInternal(batchId: string): Promise<void> {
  if (activeBatches.has(batchId)) {
    console.log(
      `[BatchProcessor] Batch ${batchId} is already actively processing. Skipping duplicate worker.`,
    );
    return;
  }
  activeBatches.add(batchId);

  let supabaseAdminClient: any = null;
  try {
    const { supabaseAdmin } = await import("../integrations/supabase/client.server");
    supabaseAdminClient = supabaseAdmin;

    const hasLease = await acquireDbBatchLease(supabaseAdmin, batchId);
    if (!hasLease) {
      return;
    }

    const { data: batchRow } = await supabaseAdmin
      .from("batches")
      .select("subject_type, solution_length, user_id")
      .eq("id", batchId)
      .maybeSingle();
    const subjectType = (batchRow?.subject_type === "math" ? "math" : "gk_english") as
      "math" | "gk_english";
    const solutionLength = (batchRow?.solution_length === "long" ? "long" : "normal") as
      "long" | "normal";
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
      .neq("status", "done")
      .order("idx", { ascending: true });
    if (error) throw new Error(`Load questions failed: ${error.message}`);
    if (!pending || pending.length === 0) {
      await finalize(batchId).catch((e) => console.error("finalize error", e));
      return;
    }

    // Dynamic concurrency: scale worker fan-out with the number of active API keys (e.g. 17 keys -> 12-16 workers)
    const { getGeminiApiKeys } = await import("./settings.functions");
    const configuredKeys = await getGeminiApiKeys().catch(() => []);
    const keyCount = Math.max(1, configuredKeys.length);
    const CONCURRENCY = Math.min(16, Math.max(4, keyCount * 2), pending.length);

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

    await supabaseAdmin.from("batches").update({ status: "processing" }).eq("id", batchId);

    const queue = [...pending];
    const workers: Promise<void>[] = [];
    // In-batch dedupe: identical raw_text reuses the in-flight promise
    const inFlightDedupe = new Map<string, Promise<string>>();
    let apiCallsSinceFlush = 0;
    const providerBlock = { message: null as string | null };

    type QuestionPatch = {
      status?: string;
      formatted_output?: string | null;
      error?: string | null;
    };
    const pendingUpdates: any[] = [];
    let inFlightFlush: Promise<void> | null = null;

    const flushCounters = async () => {
      while (inFlightFlush) {
        await inFlightFlush;
      }

      const updatesToFlush = pendingUpdates.splice(0, pendingUpdates.length);
      const callsToFlush = apiCallsSinceFlush;
      apiCallsSinceFlush = 0;

      if (updatesToFlush.length === 0 && callsToFlush === 0) return;

      const doFlush = async () => {
        if (updatesToFlush.length > 0) {
          for (let i = 0; i < updatesToFlush.length; i += 200) {
            const chunk = updatesToFlush.slice(i, i + 200);
            const { error: upErr } = await supabaseAdmin
              .from("questions")
              .upsert(chunk, { onConflict: "id" });
            if (upErr) console.error("question upsert chunk failed", upErr.message);
          }
        }

        const doneCount = await countStatus(batchId, "done");
        const failedCount = await countStatus(batchId, "failed");

        const { error: bErr } = await supabaseAdmin
          .from("batches")
          .update({
            completed: doneCount,
            failed: failedCount,
            status: "processing",
          })
          .eq("id", batchId);
        if (bErr) console.error("batch counter flush failed", bErr.message);

        if (ownerId && callsToFlush > 0) {
          apiCallsUsed += callsToFlush;
          const { error: rpcErr } = await supabaseAdmin.rpc("increment_user_usage", {
            _user_id: ownerId,
            _add_questions: 0,
            _add_calls: callsToFlush,
          });
          if (rpcErr) console.error("api_calls flush failed", rpcErr.message);
        }

        // Keep distributed DB lease active
        await renewDbBatchLease(supabaseAdmin, batchId);
      };

      inFlightFlush = doFlush()
        .catch((e) => {
          console.error("counter flush failed", e);
          pendingUpdates.unshift(...updatesToFlush);
          apiCallsSinceFlush += callsToFlush;
        })
        .finally(() => {
          inFlightFlush = null;
        });

      await inFlightFlush;
    };

    // Periodic flush timer so questions stream to DB smoothly every 1200ms
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
        // Enforce API-call limit mid-batch
        if (apiCallLimit !== null && apiCallsUsed + apiCallsSinceFlush >= apiCallLimit) {
          providerBlock.message = `API-call limit reached (${apiCallLimit.toLocaleString()}). Ask the admin to raise your limit and retry.`;
          queue.length = 0;
          return;
        }
        const q = queue.shift();
        if (!q) return;

        const key = `${subjectType}:${solutionLength}:${q.raw_text.trim().replace(/\s+/g, " ")}`;
        let output: string | null = null;

        // 1. Check cross-batch in-memory cache (0 tokens / $0.00 cost)
        if (persistentQuestionCache.has(key)) {
          output = persistentQuestionCache.get(key)!;
        } else if (inFlightDedupe.has(key)) {
          // 2. In-batch identical question in-flight dedupe
          try {
            output = await inFlightDedupe.get(key)!;
          } catch {
            output = null;
          }
        }

        if (!output) {
          const solvePromise = (async () => {
            const MAX_QUESTION_RETRIES = 3;
            let lastErr: any = null;

            for (let retry = 0; retry < MAX_QUESTION_RETRIES; retry++) {
              try {
                const res = await solveBatchQuestion({
                  raw: q.raw_text,
                  idx: q.idx,
                  subjectType,
                  solutionLength,
                  workerIdx: (workerId + retry) % 3,
                });
                if (res && res.trim().length > 0) {
                  return res;
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
                  await new Promise((r) => setTimeout(r, 600 * (retry + 1)));
                  continue;
                }
                break;
              }
            }

            throw lastErr || new Error("Failed to solve question");
          })();

          inFlightDedupe.set(key, solvePromise);

          try {
            output = await solvePromise;
            apiCallsSinceFlush++;
            setInCache(key, output);
          } catch (solveErr: any) {
            const errMsg =
              solveErr instanceof Error
                ? solveErr.message
                : String(solveErr || "Failed to solve question");
            apiCallsSinceFlush++;
            updateRow(q, { status: "failed", error: errMsg.slice(0, 500) });
            inFlightDedupe.delete(key);
            continue;
          } finally {
            inFlightDedupe.delete(key);
          }
        }

        // Re-run the idx replacement so the question number matches this specific row.
        output = output.replace(/^\s*(?:Q\.?\s*)?\d{1,4}[.:)\-–—]?\s+/i, `${q.idx}. `);
        updateRow(q, { status: "done", formatted_output: output, error: null });
      }
    };

    // Launch all workers in parallel across key streams
    for (let i = 0; i < CONCURRENCY; i++) workers.push(worker(i));
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
      await supabaseAdmin.from("batches").update({ status: "failed" }).eq("id", batchId);
      await supabaseAdmin
        .from("questions")
        .update({ status: "failed", error: msg.slice(0, 500) })
        .eq("batch_id", batchId)
        .in("status", ["pending", "processing"]);
    } catch (inner) {
      console.error("fatal recovery failed", inner);
    }
  } finally {
    if (supabaseAdminClient) {
      await releaseDbBatchLease(supabaseAdminClient, batchId).catch(() => {});
    }
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
    const { data: batch } = await supabaseAdmin
      .from("batches")
      .select("total")
      .eq("id", batchId)
      .maybeSingle();
    const total = batch?.total ?? 0;
    const status =
      done + failed >= total
        ? failed === 0
          ? "completed"
          : "completed_with_errors"
        : "processing";
    const { error } = await supabaseAdmin
      .from("batches")
      .update({ completed: done, failed, status })
      .eq("id", batchId);
    if (error) console.error("finalize update failed", error.message);
  } catch (e) {
    console.error("finalize threw", e);
  }
}

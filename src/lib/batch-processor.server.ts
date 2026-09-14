// Server-only batch processor for solving MCQs concurrently across the Gemini multi-key pool

// Active batches lock to prevent multiple workers from running simultaneously on the same batch in this process
const activeBatches = new Set<string>();

// Distributed DB lease parameters (prevents concurrent execution across multiple server instances)
const LEASE_DURATION_MS = 45_000;
const workerInstanceId = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

/**
 * Claim the batch for this worker, atomically.
 *
 * This used to be a SELECT followed by an UPSERT. Two instances could both read
 * "no live owner" and both write, so two workers processed one batch and
 * double-spent the shared Gemini pool. try_acquire_batch_lease does the read and
 * the write in one statement, so exactly one caller wins.
 *
 * Falls back to the old read-then-write if the migration has not been applied
 * yet, so deploying this file before the migration degrades rather than breaks.
 */
async function acquireDbBatchLease(supabaseAdmin: any, batchId: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin.rpc("try_acquire_batch_lease", {
      _batch_id: batchId,
      _worker_id: workerInstanceId,
      _duration_ms: LEASE_DURATION_MS,
    });
    if (!error) {
      if (data !== true) {
        console.log(`[BatchProcessor] Batch ${batchId} is leased by another live worker.`);
      }
      return data === true;
    }
    console.warn(
      `[BatchProcessor] try_acquire_batch_lease unavailable (${error.message}); using non-atomic fallback.`,
    );
  } catch (e) {
    console.error("acquireDbBatchLease rpc threw", e);
  }
  return acquireDbBatchLeaseFallback(supabaseAdmin, batchId);
}

async function acquireDbBatchLeaseFallback(supabaseAdmin: any, batchId: string): Promise<boolean> {
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
    return true; // Fall back to the local memory lock if app_settings is unavailable
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

// Upper bound on workers for one batch, regardless of how large the key pool
// gets. Beyond this the bottleneck stops being the Gemini pool and becomes
// Supabase write throughput and this process's event loop.
const WORKER_CEILING = 64;

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

// Question -> solution runs on DeepSeek ONLY.
//
// Gemini is deliberately NOT a fallback here. It remains the engine for PDF/OCR
// (see ocr.functions.ts), but its free tier grants 500 requests per project per
// day, and mixing a rate-limited free pool into this path was measured making
// batches slower rather than cheaper: questions queued behind saturated Gemini
// buckets while paid capacity sat idle. One provider, one predictable clock.
const USD_TO_INR = Number(process.env.USD_TO_INR ?? 95.72);

// Hard spend ceiling per 100 questions, in rupees. Not best-effort: when this is
// reached the run stops buying capacity, because a surprise bill is worse than a
// late batch.
const MAX_RUPEES_PER_100 = Number(process.env.DEEPSEEK_MAX_RUPEES_PER_100 ?? 1.5);

// Concurrency. DeepSeek answers in ~2.5s for English and ~5s for Hindi (the
// Hindi path adds two free translation hops), so ~24 in flight comfortably
// clears 100 questions inside the 30-40s target without stressing the account.
const DEEPSEEK_WORKERS = Number(process.env.DEEPSEEK_WORKERS ?? 24);

async function solveBatchQuestion(opts: {
  raw: string;
  idx: number;
  subjectType: "math" | "gk_english";
  solutionLength: "normal" | "long";
}): Promise<{ text: string; apiCalls: number }> {
  const { solveWithDeepSeek } = await import("./deepseek.server");
  return await solveWithDeepSeek(opts);
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
      .select("subject_type, solution_length, user_id, total")
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

    const { getGeminiApiKeys } = await import("./settings.functions");
    const configuredKeys = await getGeminiApiKeys().catch(() => []);
    const keyCount = Math.max(1, configuredKeys.length);

    // Solving no longer touches the Gemini key pool, so fan-out is simply the
    // DeepSeek worker count, bounded by how much work there is.
    const CONCURRENCY = Math.min(DEEPSEEK_WORKERS, Math.max(1, pending.length));
    console.log(
      `[BatchProcessor] ${batchId}: DeepSeek solving ${pending.length} question(s) with ${CONCURRENCY} workers, budget Rs ${((pending.length / 100) * MAX_RUPEES_PER_100).toFixed(2)}`,
    );

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

    // Rows already finished before this run started - a resumed batch keeps them.
    // Tracked in memory so the 1.2s flush does not have to COUNT(*) twice.
    const baselineDone = Math.max(0, (batchRow?.total ?? 0) - pending.length);
    let baselineFailed = 0;
    {
      const { count } = await supabaseAdmin
        .from("questions")
        .select("*", { count: "exact", head: true })
        .eq("batch_id", batchId)
        .eq("status", "failed");
      baselineFailed = count ?? 0;
    }
    let doneInThisRun = 0;
    let failedInThisRun = 0;

    const queue = [...pending];
    const workers: Promise<void>[] = [];
    // In-batch dedupe: identical raw_text reuses the in-flight promise
    const inFlightDedupe = new Map<string, Promise<{ text: string; apiCalls: number }>>();
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

        // Counters come from memory, not from two COUNT(*) round-trips per tick.
        // At a 1.2s cadence those were ~100 extra queries per minute for the
        // whole life of the batch; on a 2,000-question run that is thousands of
        // scans of the same table the workers are actively writing to. The
        // authoritative recount still happens once, in finalize().
        const { error: bErr } = await supabaseAdmin
          .from("batches")
          .update({
            completed: baselineDone + doneInThisRun,
            failed: baselineFailed + failedInThisRun,
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

    // Lease heartbeat, on its OWN timer.
    //
    // Renewal used to live inside the flush, which returns early when there is
    // nothing to write. So a batch making no progress - every worker sleeping up
    // to 70s waiting for a free bucket, which is exactly when the pool is busy -
    // renewed nothing, the 45s lease lapsed, and the batch looked abandoned to
    // the sweeper and to other instances while its workers were very much alive.
    const leaseTimer = setInterval(() => {
      void renewDbBatchLease(supabaseAdmin, batchId);
    }, LEASE_DURATION_MS / 3);

    // Every queued row carries the SAME key set. A bulk upsert whose objects
    // have differing keys makes PostgREST pad the gaps, so a row that only meant
    // to set `error` would also blank out `formatted_output` for its neighbours'
    // columns. Writing all three fields explicitly every time removes that whole
    // class of surprise.
    const updateRow = (q: any, patch: QuestionPatch) => {
      pendingUpdates.push({
        id: q.id,
        batch_id: batchId,
        idx: q.idx,
        raw_text: q.raw_text,
        status: patch.status ?? "processing",
        formatted_output: patch.formatted_output ?? null,
        error: patch.error ?? null,
      });
    };

    const worker = async () => {
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
          // 2. In-batch identical question in-flight dedupe. No API cost is
          // billed here - the worker that actually made the calls bills them.
          try {
            output = (await inFlightDedupe.get(key)!).text;
          } catch {
            output = null;
          }
        }

        if (!output) {
          const solvePromise = (async () => {
            const MAX_QUESTION_RETRIES = 3;
            let lastErr: any = null;
            // Real provider requests spent on this question across every retry.
            // Billing one call per question under-counted by up to 36x (12
            // in-solver attempts x 3 outer retries), which made api_call_limit
            // meaningless.
            let spent = 0;

            for (let retry = 0; retry < MAX_QUESTION_RETRIES; retry++) {
              try {
                const res = await solveBatchQuestion({
                  raw: q.raw_text,
                  idx: q.idx,
                  subjectType,
                  solutionLength,
                });
                spent += res.apiCalls;
                if (res.text && res.text.trim().length > 0) {
                  return { text: res.text, apiCalls: spent };
                }
              } catch (err: any) {
                lastErr = err;
                spent += Number(err?.apiCalls ?? 0);
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

            throw Object.assign(lastErr || new Error("Failed to solve question"), {
              apiCalls: spent,
            });
          })();

          inFlightDedupe.set(key, solvePromise);

          try {
            const solved = await solvePromise;
            output = solved.text;
            apiCallsSinceFlush += solved.apiCalls;
            setInCache(key, output);
          } catch (solveErr: any) {
            const errMsg =
              solveErr instanceof Error
                ? solveErr.message
                : String(solveErr || "Failed to solve question");
            apiCallsSinceFlush += Math.max(1, Number(solveErr?.apiCalls ?? 0));
            updateRow(q, { status: "failed", error: errMsg.slice(0, 500) });
            failedInThisRun++;
            continue;
          } finally {
            inFlightDedupe.delete(key);
          }
        }

        // Re-run the idx replacement so the question number matches this specific row.
        output = output.replace(/^\s*(?:Q\.?\s*)?\d{1,4}[.:)\-–—]?\s+/i, `${q.idx}. `);
        updateRow(q, { status: "done", formatted_output: output, error: null });
        doneInThisRun++;
      }
    };

    // Launch all workers in parallel across key streams
    // Budget watchdog. DeepSeek reports exact usage per call, so spend is known
    // rather than estimated; when the ceiling is reached the queue is drained so
    // in-flight work finishes and nothing new is bought.
    const budgetRupees = (pending.length / 100) * MAX_RUPEES_PER_100;
    let spentUsd: () => number = () => 0;
    try {
      const ds = await import("./deepseek.server");
      spentUsd = () => ds.getDeepSeekSpend().costUsd;
    } catch {
      /* module unavailable; spend stays zero */
    }
    let budgetReported = false;
    const budgetWatch = setInterval(() => {
      if (spentUsd() * USD_TO_INR < budgetRupees || budgetReported) return;
      budgetReported = true;
      providerBlock.message = `DeepSeek budget of Rs ${budgetRupees.toFixed(2)} for this batch was reached. Raise DEEPSEEK_MAX_RUPEES_PER_100 or run off-peak, then use "Retry failed".`;
      queue.length = 0;
      console.warn(`[BatchProcessor] ${batchId}: ${providerBlock.message}`);
    }, 1000);
    (budgetWatch as unknown as { unref?: () => void }).unref?.();

    for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
    await Promise.allSettled(workers);
    clearInterval(budgetWatch);
    clearInterval(flushTimer);
    clearInterval(leaseTimer);
    await flushCounters();

    {
      const { getDeepSeekSpend } = await import("./deepseek.server");
      const sp = getDeepSeekSpend();
      console.log(
        `[BatchProcessor] ${batchId}: DeepSeek spend $${sp.costUsd.toFixed(4)} (~Rs ${(sp.costUsd * USD_TO_INR).toFixed(2)}) over ${sp.calls} call(s); ${sp.cacheHitTokens} prompt tokens served from cache.`,
      );
    }

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

    // Came out clean, so drop the auto-retry counter. Without this a batch that
    // needed a retry once would keep its used-up allowance forever and could not
    // be auto-retried again if it were ever re-run.
    if (status === "completed") {
      const { error: clearErr } = await supabaseAdmin
        .from("app_settings")
        .delete()
        .eq("key", `batch_autoretry_${batchId}`);
      if (clearErr) console.error("auto-retry counter cleanup failed", clearErr.message);
    }
  } catch (e) {
    console.error("finalize threw", e);
  }
}

// ===========================================================================
// STUCK-BATCH SWEEPER
//
// A batch can be abandoned mid-flight when the server process is restarted or
// redeployed: its questions stay at status "processing" with no output and no
// error, and batches.status stays "processing" forever. The UI has a stall
// watchdog, but it only fires while somebody has that batch page open, so a
// batch abandoned overnight simply sits there (observed: several stuck since
// 2026-09-09, most of them one question short of finishing).
//
// The DB lease already tells us whether a live worker owns a batch. Anything
// still "processing" with no unexpired lease has no owner, so it is safe to
// pick back up. processBatchInternal already selects every row that is not
// "done", so re-running it finishes exactly the missing questions.
// ===========================================================================

const SWEEP_INTERVAL_MS = 120_000;
// Recover strictly one batch at a time. CONCURRENCY is enforced per batch, so
// two recovered batches running together mean 2x the workers against the same
// key pool. Measured: resuming four at once put all 17 keys into rate-limiting
// and every batch then made zero progress. The API pool - not worker count - is
// the bottleneck, so serialising recovery is strictly faster than parallelising.
const MAX_RESUMES_PER_SWEEP = 1;
let sweeperStarted = false;

async function isBatchOwnedByLiveWorker(supabaseAdmin: any, batchId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", `batch_lease_${batchId}`)
    .maybeSingle();
  if (!data?.value) return false;
  try {
    const parsed = JSON.parse(data.value);
    return Boolean(parsed.expiresAt && parsed.expiresAt > Date.now());
  } catch {
    return false;
  }
}

// How many times a finished batch may be automatically re-run to clear failures
// that were only ever rate-limiting, and how long to leave the pool alone first.
const MAX_AUTO_RETRIES = 3;
const AUTO_RETRY_DELAY_MS = 6 * 60 * 1000;

/**
 * Re-queue questions that failed purely because the key pool was rate-limited.
 *
 * Those failures are transient by definition: the same question succeeds once the
 * per-minute window rolls over. Leaving them sitting in "failed" means a batch
 * finishes at, say, 90/100 and waits for somebody to notice and press "Retry
 * failed". Retrying automatically - a few times, spaced out - turns that into
 * 100/100 without anyone watching.
 *
 * Deliberately narrow: only rate-limit errors qualify. A question that failed for
 * any other reason (safety filter, malformed input) would fail again, so retrying
 * it would just burn quota. The attempt count is kept in app_settings so a batch
 * cannot loop forever, and is cleared once the batch comes out clean.
 */
async function retryRateLimitedFailures(supabaseAdmin: any): Promise<boolean> {
  const { data: batches } = await supabaseAdmin
    .from("batches")
    .select("id, total, completed, failed")
    .eq("status", "completed_with_errors")
    .gt("failed", 0)
    .order("created_at", { ascending: false })
    .limit(20);

  for (const b of batches ?? []) {
    if (activeBatches.size > 0) return false;
    const counterKey = `batch_autoretry_${b.id}`;
    const { data: row } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", counterKey)
      .maybeSingle();

    let tries = 0;
    let lastAt = 0;
    if (row?.value) {
      try {
        const p = JSON.parse(row.value);
        tries = Number(p.tries ?? 0);
        lastAt = Number(p.lastAt ?? 0);
      } catch {}
    }
    if (tries >= MAX_AUTO_RETRIES) continue;
    if (Date.now() - lastAt < AUTO_RETRY_DELAY_MS) continue;

    // Only re-queue the ones that hit rate limiting.
    const { data: failedRows } = await supabaseAdmin
      .from("questions")
      .select("id, error")
      .eq("batch_id", b.id)
      .eq("status", "failed")
      .limit(2000);
    const transient = (failedRows ?? [])
      .filter((q: any) =>
        /429|quota|resource has been exhausted|rate|saturated|gave up after/i.test(
          String(q.error ?? ""),
        ),
      )
      .map((q: any) => q.id);
    if (transient.length === 0) continue;

    for (let i = 0; i < transient.length; i += 200) {
      await supabaseAdmin
        .from("questions")
        .update({ status: "pending", error: null })
        .in("id", transient.slice(i, i + 200));
    }
    await supabaseAdmin.from("batches").update({ status: "processing" }).eq("id", b.id);
    await supabaseAdmin.from("app_settings").upsert(
      {
        key: counterKey,
        value: JSON.stringify({ tries: tries + 1, lastAt: Date.now() }),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    );
    console.log(
      `[Sweeper] Auto-retry ${tries + 1}/${MAX_AUTO_RETRIES} for batch ${b.id}: re-queued ${transient.length} rate-limited question(s)`,
    );
    return true;
  }
  return false;
}

export async function sweepStuckBatches(): Promise<number> {
  const { supabaseAdmin } = await import("../integrations/supabase/client.server");
  let resumed = 0;
  try {
    const { data: candidates, error } = await supabaseAdmin
      .from("batches")
      .select("id, total, completed, failed")
      .eq("status", "processing")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) {
      console.error("[Sweeper] could not list processing batches", error.message);
      return 0;
    }

    for (const b of candidates ?? []) {
      // Already finished but never finalised: correcting the status costs no API
      // calls, so do it regardless of what else is running.
      if ((b.completed ?? 0) + (b.failed ?? 0) >= (b.total ?? 0)) {
        await finalize(b.id).catch((e) => console.error("[Sweeper] finalize failed", e));
        continue;
      }
      if (resumed >= MAX_RESUMES_PER_SWEEP) break;
      // Never start recovery work alongside a batch that is already running -
      // whether a user started it or an earlier sweep did. Workers are capped per
      // batch, so overlapping batches multiply the load on one shared key pool.
      if (activeBatches.size > 0) break;
      if (await isBatchOwnedByLiveWorker(supabaseAdmin, b.id)) continue;

      console.log(
        `[Sweeper] Resuming abandoned batch ${b.id} (${b.completed}/${b.total} done, ${b.failed} failed)`,
      );
      resumed++;
      void processBatchInternal(b.id).catch((e) =>
        console.error(`[Sweeper] resume of ${b.id} failed`, e),
      );
    }

    // Nothing abandoned to pick up, so use the idle pass to clear failures that
    // were only ever rate-limiting. Kept behind the same one-batch-at-a-time rule.
    if (resumed === 0 && activeBatches.size === 0) {
      await retryRateLimitedFailures(supabaseAdmin).catch((e) =>
        console.error("[Sweeper] auto-retry failed", e),
      );
    }
  } catch (e) {
    console.error("[Sweeper] sweep threw", e);
  }
  return resumed;
}

// Called once from the server entry so recovery does not depend on a browser
// being open, or on anyone starting a new batch first.
export function startStuckBatchSweeper(): void {
  if (sweeperStarted) return;
  sweeperStarted = true;
  const timer = setInterval(() => {
    void sweepStuckBatches().catch(() => {});
  }, SWEEP_INTERVAL_MS);
  // Never hold the process open just for the sweeper.
  (timer as unknown as { unref?: () => void }).unref?.();
  // First pass shortly after boot, once the server has settled.
  setTimeout(() => {
    void sweepStuckBatches().catch(() => {});
  }, 15_000).unref?.();
}

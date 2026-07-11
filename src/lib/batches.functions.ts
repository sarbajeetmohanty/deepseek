import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { parseQuestions } from "./parse-questions";
import { assertWithinQuota } from "./quotas.functions";

type SubjectType = "gk_english" | "math";
type SolutionLength = "normal" | "long";

export const createBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { title: string; rawText: string; subjectType?: SubjectType; solutionLength?: SolutionLength }) => {
    if (!data?.rawText || typeof data.rawText !== "string") throw new Error("rawText required");
    if (data.rawText.trim().length === 0) throw new Error("Paste at least one question before starting a batch.");
    if (data.rawText.length > 2_000_000) throw new Error("Input too large");
    const subjectType: SubjectType = data.subjectType === "math" ? "math" : "gk_english";
    const solutionLength: SolutionLength = data.solutionLength === "long" ? "long" : "normal";
    return { title: (data.title || "Untitled batch").slice(0, 200), rawText: data.rawText, subjectType, solutionLength };
  })
  .handler(async ({ data, context }) => {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error(
        "Missing SUPABASE_SERVICE_ROLE_KEY in your local .env file. " +
        "Please add the service_role key from your Supabase Dashboard (Settings -> API) to your .env file to enable processing."
      );
    }
    const { supabase, userId } = context;
    let parsed: ReturnType<typeof parseQuestions>;
    try {
      parsed = parseQuestions(data.rawText);
    } catch (e) {
      throw new Error(`Could not parse questions: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (parsed.length === 0) throw new Error("No questions found. Each question must start with a number followed by '. ' (e.g. '374. ').");
    if (parsed.length > 2000) throw new Error(`Too many questions (${parsed.length}). Split into batches of 2000 or fewer.`);

    // Enforce per-user question quota (if the admin has set one).
    await assertWithinQuota(supabase, userId, parsed.length);

    const { data: batch, error: batchErr } = await supabase
      .from("batches")
      .insert({
        user_id: userId,
        title: data.title,
        total: parsed.length,
        status: "processing",
        subject_type: data.subjectType,
        solution_length: data.solutionLength,
      })
      .select()
      .maybeSingle();
    if (batchErr) throw new Error(`Could not create batch: ${batchErr.message}`);
    if (!batch) throw new Error("Batch creation returned no row. Please try again.");

    const rows = parsed.map((q) => ({
      batch_id: batch.id,
      idx: q.idx,
      raw_text: q.text,
      status: "pending" as const,
    }));
    // Chunk inserts to avoid payload limits; roll back the batch on failure so
    // the user isn't left with an empty stuck batch.
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await supabase.from("questions").insert(chunk);
      if (error) {
        await supabase.from("batches").delete().eq("id", batch.id);
        throw new Error(`Failed to insert questions: ${error.message}`);
      }
    }

    // Increment the user's question counter atomically. API-call counter is
    // incremented by the batch processor as each call completes.
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin.rpc("increment_user_usage", {
        _user_id: userId,
        _add_questions: parsed.length,
        _add_calls: 0,
      });
    } catch (e) {
      console.error("increment_user_usage (questions) failed", e);
    }

    // Kick off processing in the background (fire and forget).
    try {
      const { processBatchInternal } = await import("./batch-processor.server");
      void processBatchInternal(batch.id).catch((e) => console.error("processBatch failed", e));
    } catch (e) {
      console.error("failed to start batch processing", e);
      // Batch is created; user can hit "Retry failed" to resume.
    }

    return { batchId: batch.id, total: parsed.length };
  });

// Called by the UI to (re)start processing pending/failed items.
export const resumeBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { batchId: string }) => {
    if (!data?.batchId) throw new Error("batchId required");
    return data;
  })
  .handler(async ({ data, context }) => {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error(
        "Missing SUPABASE_SERVICE_ROLE_KEY in your local .env file. " +
        "Please add the service_role key from your Supabase Dashboard to your .env file to enable processing."
      );
    }
    const { supabase, userId } = context;
    const { data: batch, error } = await supabase
      .from("batches")
      .select("id,user_id")
      .eq("id", data.batchId)
      .maybeSingle();
    if (error) throw new Error(`Could not load batch: ${error.message}`);
    if (!batch) throw new Error("Batch not found. It may have been deleted.");
    if (batch.user_id !== userId) throw new Error("You don't have access to this batch.");
    try {
      const { processBatchInternal } = await import("./batch-processor.server");
      void processBatchInternal(batch.id).catch((e) => console.error("resumeBatch failed", e));
    } catch (e) {
      throw new Error(`Could not start processing: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { ok: true };
  });

// Delete a batch (and, via ON DELETE CASCADE, its questions and download logs).
// Owner or an admin can delete. Admins are allowed so they can clean up team data.
export const deleteBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { batchId: string }) => {
    if (!data?.batchId || typeof data.batchId !== "string") throw new Error("batchId required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: batch, error } = await supabase
      .from("batches")
      .select("id,user_id")
      .eq("id", data.batchId)
      .maybeSingle();
    if (error) throw new Error(`Could not load batch: ${error.message}`);
    if (!batch) throw new Error("Batch not found.");
    if (batch.user_id !== userId) {
      const { data: isAdmin, error: rErr } = await supabase.rpc("has_role", {
        _user_id: userId,
        _role: "admin",
      });
      if (rErr) throw new Error(`Could not verify permissions: ${rErr.message}`);
      if (!isAdmin) throw new Error("You don't have access to this batch.");
    }
    const { error: delErr } = await supabase.from("batches").delete().eq("id", data.batchId);
    if (delErr) throw new Error(`Could not delete batch: ${delErr.message}`);
    return { ok: true };
  });
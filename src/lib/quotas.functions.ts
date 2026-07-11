import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SupabaseClient } from "@supabase/supabase-js";

async function ensureAdmin(supabase: SupabaseClient, userId: string) {
  const { data, error } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (error) throw new Error(`Could not verify role: ${error.message}`);
  if (!data) throw new Error("Forbidden: admin only");
}

// O(1) — reads a single denormalized row. Counters are kept up-to-date by
// createBatch and the batch processor via increment_user_usage.
async function usageForUser(supabase: SupabaseClient, userId: string) {
  const { data, error } = await supabase
    .from("user_quotas")
    .select("question_limit, api_call_limit, questions_used, api_calls_used")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`Could not read quota: ${error.message}`);
  return {
    used: Number(data?.questions_used ?? 0),
    limit: (data?.question_limit ?? null) as number | null,
    apiUsed: Number(data?.api_calls_used ?? 0),
    apiLimit: (data?.api_call_limit ?? null) as number | null,
  };
}

// Signed-in user asks about their own quota (for the dashboard header).
export const getMyQuota = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    return usageForUser(context.supabase, context.userId);
  });

// Admin: list every member's quotas + current usage in a single tiny read.
export const listQuotas = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("user_quotas")
      .select("user_id,question_limit,api_call_limit,questions_used,api_calls_used,updated_at");
    if (error) throw new Error(error.message);
    return (data ?? []).map((q) => ({
      user_id: q.user_id,
      question_limit: q.question_limit,
      api_call_limit: (q as any).api_call_limit ?? null,
      used: Number((q as any).questions_used ?? 0),
      api_used: Number((q as any).api_calls_used ?? 0),
      updated_at: q.updated_at,
    }));
  });

// Admin: set (or clear) a member's question limit and/or API-call limit.
// Any field left `undefined` is not touched. Pass `null` to make unlimited.
export const setUserQuota = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { userId: string; questionLimit?: number | null; apiCallLimit?: number | null }) => {
    if (!data?.userId || typeof data.userId !== "string") throw new Error("userId required");
    const check = (label: string, v: number | null | undefined) => {
      if (v === undefined || v === null) return;
      if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0 || v > 10_000_000) {
        throw new Error(`${label} must be a non-negative integer up to 10,000,000, or null`);
      }
    };
    check("questionLimit", data.questionLimit);
    check("apiCallLimit", data.apiCallLimit);
    return { userId: data.userId, questionLimit: data.questionLimit, apiCallLimit: data.apiCallLimit };
  })
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const { data: target, error: tErr } = await context.supabase
      .from("profiles")
      .select("id")
      .eq("id", data.userId)
      .maybeSingle();
    if (tErr) throw new Error(tErr.message);
    if (!target) throw new Error("Target user not found");

    const patch = {
      user_id: data.userId,
      updated_by: context.userId,
      updated_at: new Date().toISOString(),
      ...(data.questionLimit !== undefined ? { question_limit: data.questionLimit } : {}),
      ...(data.apiCallLimit !== undefined ? { api_call_limit: data.apiCallLimit } : {}),
    };
    const { error } = await context.supabase
      .from("user_quotas")
      .upsert(patch, { onConflict: "user_id" });
    if (error) throw new Error(`Could not save quota: ${error.message}`);
    return { ok: true };
  });

// Server-side helper used by createBatch. Rejects if adding `incoming`
// questions (each ≈ 1 API call) would push either counter over the limit.
export async function assertWithinQuota(
  supabase: SupabaseClient,
  userId: string,
  incoming: number,
) {
  const { used, limit, apiUsed, apiLimit } = await usageForUser(supabase, userId);
  if (limit !== null) {
    const remaining = Math.max(0, limit - used);
    if (incoming > remaining) {
      throw new Error(
        `Question limit reached: ${used.toLocaleString()} / ${limit.toLocaleString()} used, only ${remaining.toLocaleString()} left. Ask the admin to raise your limit.`,
      );
    }
  }
  if (apiLimit !== null) {
    const remainingCalls = Math.max(0, apiLimit - apiUsed);
    if (incoming > remainingCalls) {
      throw new Error(
        `API-call limit reached: ${apiUsed.toLocaleString()} / ${apiLimit.toLocaleString()} calls used, only ${remainingCalls.toLocaleString()} left. Ask the admin to raise your API limit.`,
      );
    }
  }
  return { used, limit, apiUsed, apiLimit };
}
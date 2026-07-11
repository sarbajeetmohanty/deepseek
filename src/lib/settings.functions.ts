import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SupabaseClient } from "@supabase/supabase-js";

// Admin-only settings surface. The raw value never leaves the server:
// - Writes go through supabaseAdmin (service role) after we verify the caller
//   is an admin, so RLS on app_settings is defence in depth.
// - Reads for the UI return a masked preview (last 4 chars) + metadata only,
//   never the raw key.
// - Server code that actually needs the key uses getDeepseekApiKey() below,
//   which caches the value in-memory for 60s so we don't hit the DB per
//   DeepSeek call during a 2000-question batch.

const DEEPSEEK_KEY = "deepseek_api_key";

async function ensureAdmin(supabase: SupabaseClient, userId: string) {
  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) throw new Error(`Could not verify admin role: ${error.message}`);
  if (!data) throw new Error("Forbidden: admin only");
}

// --- In-memory cache used by the batch processor ------------------------
// Cleared on every successful write so a rotated key takes effect within one
// DeepSeek call (the very next attempt sees the new key).
let cached: { value: string; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

export async function getDeepseekApiKey(): Promise<string> {
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.value;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", DEEPSEEK_KEY)
    .maybeSingle();
  if (error) throw new Error(`Could not load DeepSeek key: ${error.message}`);
  const stored = data?.value?.trim();
  const fallback = process.env.DEEPSEEK_API_KEY?.trim();
  const value = stored || fallback;
  if (!value) {
    throw new Error(
      "No DeepSeek API key is configured. An admin can paste one on the Team page.",
    );
  }
  cached = { value, fetchedAt: Date.now() };
  return value;
}

function invalidateCache() {
  cached = null;
}

function mask(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

// Admin UI: what key is active, who set it, when. Never returns the raw value.
export const getDeepseekKeyStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("app_settings")
      .select("value, updated_at, updated_by")
      .eq("key", DEEPSEEK_KEY)
      .maybeSingle();
    if (error) throw new Error(`Could not load key status: ${error.message}`);
    if (!data) {
      const envConfigured = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
      return {
        configured: envConfigured,
        source: envConfigured ? ("env" as const) : ("none" as const),
        preview: null as string | null,
        updatedAt: null as string | null,
        updatedByEmail: null as string | null,
      };
    }
    let updatedByEmail: string | null = null;
    if (data.updated_by) {
      const { data: p } = await supabaseAdmin
        .from("profiles")
        .select("email")
        .eq("id", data.updated_by)
        .maybeSingle();
      updatedByEmail = p?.email ?? null;
    }
    return {
      configured: true,
      source: "database" as const,
      preview: mask(data.value),
      updatedAt: data.updated_at as string,
      updatedByEmail,
    };
  });

// Admin UI: paste a new key. Old value is REPLACED (upsert on the same row),
// so there is only ever one active key. Cache is cleared immediately so the
// next DeepSeek call uses the new key.
export const setDeepseekApiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { apiKey: string }) => {
    const apiKey = String(data?.apiKey ?? "").trim();
    if (!apiKey) throw new Error("API key is required");
    if (apiKey.length < 20) throw new Error("That doesn't look like a valid DeepSeek key");
    if (apiKey.length > 512) throw new Error("Key value is too long");
    // DeepSeek keys start with `sk-`, but be forgiving in case that changes.
    if (!/^[A-Za-z0-9_\-]+$/.test(apiKey)) throw new Error("Key contains invalid characters");
    return { apiKey };
  })
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("app_settings")
      .upsert(
        {
          key: DEEPSEEK_KEY,
          value: data.apiKey,
          updated_by: context.userId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" },
      );
    if (error) throw new Error(`Could not save key: ${error.message}`);
    console.log(`[DeepSeek] API key successfully updated in app_settings by user ${context.userId}. In-memory cache invalidated.`);
    invalidateCache();
    return { ok: true, preview: mask(data.apiKey) };
  });

export const clearDeepseekApiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("app_settings")
      .delete()
      .eq("key", DEEPSEEK_KEY);
    if (error) throw new Error(`Could not clear key: ${error.message}`);
    invalidateCache();
    return { ok: true };
  });

// Admin-only: temporarily reveal the raw key so an admin can copy it.
// The value is transmitted over the authenticated server-fn channel
// (same origin, TLS, bearer token) and NEVER cached in React Query.
export const revealDeepseekApiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", DEEPSEEK_KEY)
      .maybeSingle();
    if (error) throw new Error(`Could not read key: ${error.message}`);
    const stored = data?.value?.trim();
    if (!stored) {
      const envKey = process.env.DEEPSEEK_API_KEY?.trim();
      if (envKey) return { source: "env" as const, value: envKey };
      throw new Error("No key is configured");
    }
    return { source: "database" as const, value: stored };
  });
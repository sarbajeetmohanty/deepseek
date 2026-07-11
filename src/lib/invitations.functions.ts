import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SupabaseClient } from "@supabase/supabase-js";

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

export const inviteUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { email: string }) => {
    const email = String(data?.email ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Valid email required");
    if (email.length > 320) throw new Error("Email address is too long");
    return { email };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await ensureAdmin(supabase, userId);
    const { error } = await supabase
      .from("invitations")
      .insert({ email: data.email, invited_by: userId, status: "pending" });
    if (error) {
      if (/duplicate|unique/i.test(error.message)) return { ok: true, duplicate: true };
      throw new Error(`Could not create invitation: ${error.message}`);
    }
    return { ok: true };
  });

export const revokeInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { id: string }) => {
    if (!data?.id) throw new Error("id required");
    return data;
  })
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const { error } = await context.supabase.from("invitations").delete().eq("id", data.id);
    if (error) throw new Error(`Could not remove invitation: ${error.message}`);
    return { ok: true };
  });

export const listInvitations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("invitations")
      .select("id,email,status,created_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error(`Could not load invitations: ${error.message}`);
    return data ?? [];
  });

export const listTeam = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("profiles")
      .select("id,email,full_name,avatar_url,created_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error(`Could not load team: ${error.message}`);
    const { data: roles, error: rolesErr } = await context.supabase
      .from("user_roles")
      .select("user_id,role");
    if (rolesErr) console.error("could not load roles", rolesErr.message);
    const rolesByUser = new Map<string, string[]>();
    for (const r of roles ?? []) {
      const arr = rolesByUser.get(r.user_id) ?? [];
      arr.push(r.role);
      rolesByUser.set(r.user_id, arr);
    }
    return (data ?? []).map((p) => ({ ...p, roles: rolesByUser.get(p.id) ?? [] }));
  });

export const getMyRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (error) console.error("getMyRole load error", error.message);
    return { roles: (data ?? []).map((r) => r.role as string), userId: context.userId };
  });

// Admin-only: grant or revoke the 'admin' role for another user.
// Uses supabaseAdmin (service role) because user_roles denies INSERT/DELETE via RLS.
// Guards: (1) caller must be admin, (2) targetUserId must be a real profile,
// (3) cannot demote the LAST remaining admin (would lock the workspace).
export const setUserAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { targetUserId: string; makeAdmin: boolean }) => {
    if (!data?.targetUserId || typeof data.targetUserId !== "string") {
      throw new Error("targetUserId required");
    }
    if (typeof data.makeAdmin !== "boolean") throw new Error("makeAdmin required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await ensureAdmin(supabase, userId);

    // Confirm the target exists (avoid orphan role rows for random UUIDs).
    const { data: target, error: tErr } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", data.targetUserId)
      .maybeSingle();
    if (tErr) throw new Error(`Could not verify target: ${tErr.message}`);
    if (!target) throw new Error("Target user not found");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    if (data.makeAdmin) {
      const { error } = await supabaseAdmin
        .from("user_roles")
        .upsert({ user_id: data.targetUserId, role: "admin" }, { onConflict: "user_id,role" });
      if (error) throw new Error(`Could not promote: ${error.message}`);
      return { ok: true, promoted: true };
    }

    // Demote — refuse if this would remove the last admin.
    const { count, error: cErr } = await supabaseAdmin
      .from("user_roles")
      .select("user_id", { count: "exact", head: true })
      .eq("role", "admin");
    if (cErr) throw new Error(`Could not count admins: ${cErr.message}`);
    if ((count ?? 0) <= 1) throw new Error("Cannot demote the last remaining admin.");

    const { error } = await supabaseAdmin
      .from("user_roles")
      .delete()
      .eq("user_id", data.targetUserId)
      .eq("role", "admin");
    if (error) throw new Error(`Could not demote: ${error.message}`);
    return { ok: true, demoted: true };
  });

// Log a document download. Unique constraint (user_id, batch_id, kind) means
// repeat downloads of the same doc/kind by the same user do NOT inflate the
// per-member "documents downloaded" counter shown to admins.
export const logDownload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { batchId: string; kind: "original" | "translated" }) => {
    if (!data?.batchId) throw new Error("batchId required");
    if (data.kind !== "original" && data.kind !== "translated") throw new Error("invalid kind");
    return data;
  })
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("document_downloads")
      .insert({ user_id: context.userId, batch_id: data.batchId, kind: data.kind });
    // Duplicate = success (already counted). Any other error is silently
    // ignored so a stats-logging hiccup never blocks the actual download.
    if (error && !/duplicate|unique/i.test(error.message)) {
      console.warn("logDownload failed", error.message);
    }
    return { ok: true };
  });

// Per-team-member work stats for the admin dashboard. Wraps the
// SECURITY DEFINER SQL function `public.get_team_stats` which self-gates
// on has_role(admin) so a non-admin authenticated caller gets a clear
// "forbidden" error even if they hit this fn directly.
export const listTeamStats = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const { data, error } = await context.supabase.rpc("get_team_stats");
    if (error) throw new Error(`Could not load team stats: ${error.message}`);
    return (data ?? []) as Array<{
      user_id: string;
      questions_done: number;
      unique_questions: number;
      batches_total: number;
      documents_downloaded: number;
      last_active: string | null;
    }>;
  });

// Admin-only: fully remove a team member from the workspace.
// Deletes the auth user via the Admin API; profile/roles/quota/invitation
// rows cascade or are cleaned up explicitly so the same email can be
// re-invited and sign up again cleanly.
// Guards: caller must be admin, cannot remove self, cannot remove the last admin.
export const removeTeamMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { targetUserId: string }) => {
    if (!data?.targetUserId || typeof data.targetUserId !== "string") {
      throw new Error("targetUserId required");
    }
    return data;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await ensureAdmin(supabase, userId);
    if (data.targetUserId === userId) throw new Error("You cannot remove yourself.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Look up target profile (for email + existence check).
    const { data: target, error: tErr } = await supabaseAdmin
      .from("profiles")
      .select("id,email")
      .eq("id", data.targetUserId)
      .maybeSingle();
    if (tErr) throw new Error(`Could not verify target: ${tErr.message}`);
    if (!target) throw new Error("Target user not found");

    // If target is admin, ensure at least one other admin remains.
    const { data: targetRoles, error: rErr } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", data.targetUserId)
      .eq("role", "admin");
    if (rErr) throw new Error(`Could not check target roles: ${rErr.message}`);
    if ((targetRoles ?? []).length > 0) {
      const { count, error: cErr } = await supabaseAdmin
        .from("user_roles")
        .select("user_id", { count: "exact", head: true })
        .eq("role", "admin");
      if (cErr) throw new Error(`Could not count admins: ${cErr.message}`);
      if ((count ?? 0) <= 1) throw new Error("Cannot remove the last remaining admin.");
    }

    // Clean up app-owned rows explicitly (in case FK cascades aren't set).
    await supabaseAdmin.from("user_roles").delete().eq("user_id", data.targetUserId);
    await supabaseAdmin.from("user_quotas").delete().eq("user_id", data.targetUserId);
    await supabaseAdmin.from("profiles").delete().eq("id", data.targetUserId);
    if (target.email) {
      await supabaseAdmin.from("invitations").delete().eq("email", target.email);
    }

    // Finally, delete the auth user so the email can be re-invited & re-signup.
    const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(data.targetUserId);
    if (delErr) throw new Error(`Could not delete user: ${delErr.message}`);

    return { ok: true, email: target.email };
  });

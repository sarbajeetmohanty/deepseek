import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { inviteUser, listInvitations, listTeam, revokeInvite, setUserAdmin, getMyRole, listTeamStats, removeTeamMember } from "@/lib/invitations.functions";
import { getDeepseekKeyStatus, setDeepseekApiKey, clearDeepseekApiKey, revealDeepseekApiKey } from "@/lib/settings.functions";
import { listQuotas, setUserQuota } from "@/lib/quotas.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { UserAvatar } from "@/components/user-avatar";
import { useEffect } from "react";

type LimitKind = "questionLimit" | "apiCallLimit";

function LimitInput({
  label,
  used,
  limit,
  pending,
  onSave,
}: {
  label: string;
  used: number;
  limit: number | null;
  pending: boolean;
  onSave: (v: number | null) => void;
}) {
  const [val, setVal] = useState<string>(limit === null ? "" : String(limit));
  useEffect(() => { setVal(limit === null ? "" : String(limit)); }, [limit]);

  const parsed = val.trim() === "" ? null : Number(val);
  const invalid = parsed !== null && (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0);
  const dirty = (limit ?? null) !== (invalid ? limit : parsed);
  const over = limit !== null && used >= limit;
  const labelText = limit === null ? "unlimited" : `${used.toLocaleString()} / ${limit.toLocaleString()}`;

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 min-w-0 ${over ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}>
        {label}: <span className="font-medium text-foreground">{labelText}</span>
      </span>
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        placeholder="Unlimited"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        className="h-6 w-24 text-[11px] px-2"
        aria-label={`${label} limit`}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-6 px-2 text-[11px]"
        disabled={pending || invalid || !dirty}
        onClick={() => onSave(invalid ? null : parsed)}
      >{pending ? "…" : "Save"}</Button>
      {limit !== null && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px]"
          disabled={pending}
          onClick={() => { setVal(""); onSave(null); }}
          title="Remove the limit (unlimited)"
        >Unlimited</Button>
      )}
    </div>
  );
}

function QuotaEditor({
  current,
  pending,
  onSave,
}: {
  current: { question_limit: number | null; api_call_limit: number | null; used: number; api_used: number };
  pending: boolean;
  onSave: (kind: LimitKind, value: number | null) => void;
}) {
  return (
    <div className="mt-1.5 flex flex-col gap-1">
      <LimitInput
        label="Qs"
        used={current.used}
        limit={current.question_limit}
        pending={pending}
        onSave={(v) => onSave("questionLimit", v)}
      />
      <LimitInput
        label="API calls"
        used={current.api_used}
        limit={current.api_call_limit}
        pending={pending}
        onSave={(v) => onSave("apiCallLimit", v)}
      />
    </div>
  );
}

export const Route = createFileRoute("/_authenticated/admin")({
  component: AdminPage,
  errorComponent: AdminError,
  notFoundComponent: () => (
    <div className="max-w-md mx-auto text-center py-16 space-y-4">
      <h2 className="text-lg font-semibold">Not found</h2>
      <Link to="/"><Button>Back to dashboard</Button></Link>
    </div>
  ),
});

function AdminError({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return (
    <div className="max-w-md mx-auto text-center py-16 space-y-4">
      <h2 className="text-lg font-semibold">Team page failed to load</h2>
      <p className="text-sm text-muted-foreground">{error.message}</p>
      <Button onClick={() => { router.invalidate(); reset(); }}>Try again</Button>
    </div>
  );
}

function AdminPage() {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [apiKey, setApiKey] = useState("");

  const { data: me } = useQuery({
    queryKey: ["my-role"],
    queryFn: () => getMyRole({ data: {} } as any),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const myUserId = me?.userId;

  const { data: invites, error: invErr } = useQuery({
    queryKey: ["invitations"],
    queryFn: () => listInvitations({ data: {} } as any),
    staleTime: 30_000,
    retry: 1,
  });
  const { data: team, error: teamErr } = useQuery({
    queryKey: ["team"],
    queryFn: () => listTeam({ data: {} } as any),
    staleTime: 30_000,
    retry: 1,
  });

  // Per-member work stats (questions processed with duplicates removed,
  // batches, documents downloaded, last active). Admin-only server fn.
  const { data: stats } = useQuery({
    queryKey: ["team-stats"],
    queryFn: () => listTeamStats({ data: {} } as any),
    staleTime: 60_000,
    retry: 1,
  });

  const { data: quotas } = useQuery({
    queryKey: ["team-quotas"],
    queryFn: () => listQuotas({ data: {} } as any),
    staleTime: 30_000,
    retry: 1,
  });
  type QuotaRow = { question_limit: number | null; api_call_limit: number | null; used: number; api_used: number };
  const quotaByUser = new Map<string, QuotaRow>();
  for (const q of quotas ?? []) quotaByUser.set(q.user_id, {
    question_limit: q.question_limit,
    api_call_limit: (q as any).api_call_limit ?? null,
    used: q.used,
    api_used: (q as any).api_used ?? 0,
  });

  const saveQuota = useMutation({
    mutationFn: (v: { userId: string; questionLimit?: number | null; apiCallLimit?: number | null }) => setUserQuota({ data: v }),
    onSuccess: () => {
      toast.success("Limit updated");
      qc.invalidateQueries({ queryKey: ["team-quotas"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Could not save limit"),
  });
  const statsByUser = new Map<string, {
    questions_done: number;
    unique_questions: number;
    batches_total: number;
    documents_downloaded: number;
    last_active: string | null;
  }>();
  for (const s of stats ?? []) statsByUser.set(s.user_id, s);

  const invite = useMutation({
    mutationFn: (e: string) => inviteUser({ data: { email: e } }),
    onSuccess: (res) => {
      toast.success(
        res?.duplicate
          ? "Already invited — no changes made."
          : "Invitation added. Ask them to sign up with this email.",
      );
      setEmail("");
      qc.invalidateQueries({ queryKey: ["invitations"] });
    },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : "Could not invite"),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeInvite({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invitations"] }),
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : "Could not remove"),
  });

  const roleMutation = useMutation({
    mutationFn: (v: { targetUserId: string; makeAdmin: boolean }) => setUserAdmin({ data: v }),
    onSuccess: (res) => {
      toast.success(res?.promoted ? "Promoted to admin" : "Admin access removed");
      qc.invalidateQueries({ queryKey: ["team"] });
    },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : "Could not update role"),
  });

  const removeMember = useMutation({
    mutationFn: (v: { targetUserId: string }) => removeTeamMember({ data: v }),
    onSuccess: (res) => {
      toast.success(res?.email ? `Removed ${res.email}. They can be re-invited any time.` : "Team member removed.");
      qc.invalidateQueries({ queryKey: ["team"] });
      qc.invalidateQueries({ queryKey: ["team-stats"] });
      qc.invalidateQueries({ queryKey: ["team-quotas"] });
      qc.invalidateQueries({ queryKey: ["invitations"] });
    },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : "Could not remove member"),
  });

  const { data: keyStatus, error: keyErr } = useQuery({
    queryKey: ["deepseek-key-status"],
    queryFn: () => getDeepseekKeyStatus({ data: {} } as any),
    staleTime: 30_000,
    retry: 1,
  });

  const saveKey = useMutation({
    mutationFn: (v: string) => setDeepseekApiKey({ data: { apiKey: v } }),
    onSuccess: () => {
      toast.success("DeepSeek API key updated. Previous key removed.");
      setApiKey("");
      qc.invalidateQueries({ queryKey: ["deepseek-key-status"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Could not save key"),
  });

  const clearKey = useMutation({
    mutationFn: () => clearDeepseekApiKey({ data: {} } as any),
    onSuccess: () => {
      toast.success("API key cleared");
      qc.invalidateQueries({ queryKey: ["deepseek-key-status"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Could not clear key"),
  });

  const [revealed, setRevealed] = useState<string | null>(null);
  const revealKey = useMutation({
    mutationFn: () => revealDeepseekApiKey({ data: {} } as any),
    onSuccess: async (res) => {
      setRevealed(res.value);
      try {
        await navigator.clipboard.writeText(res.value);
        toast.success("Key copied to clipboard — hides in 20s");
      } catch {
        toast.success("Key revealed — hides in 20s");
      }
      setTimeout(() => setRevealed(null), 20_000);
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Could not reveal key"),
  });

  const adminCount = (team ?? []).filter((p: any) => (p.roles ?? []).includes("admin")).length;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Team management</h1>
        <p className="text-muted-foreground mt-1">Invite team members by email. They can then sign up on the sign-in page with that email.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>DeepSeek API key</CardTitle>
          <CardDescription>
            Saving a new key replaces the previous one instantly. Only admins can view or change this. The key is stored server-side and never sent to the browser.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {keyErr && (
            <p className="text-sm text-destructive">Could not load status: {keyErr instanceof Error ? keyErr.message : String(keyErr)}</p>
          )}
          <div className="text-sm">
            {keyStatus?.configured ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  <span className="font-medium">Active</span>
                </span>
                {keyStatus.preview && (
                  <span className="font-mono text-xs bg-muted px-2 py-0.5 rounded">{keyStatus.preview}</span>
                )}
                {keyStatus.source === "env" && (
                  <span className="text-xs text-muted-foreground">(from server secret — save one below to override)</span>
                )}
                {keyStatus.updatedAt && (
                  <span className="text-xs text-muted-foreground">
                    updated {new Date(keyStatus.updatedAt).toLocaleString()}
                    {keyStatus.updatedByEmail ? ` by ${keyStatus.updatedByEmail}` : ""}
                  </span>
                )}
              </div>
            ) : (
              <div className="inline-flex items-center gap-1.5 text-destructive">
                <span className="h-2 w-2 rounded-full bg-destructive" />
                <span className="font-medium">No key configured</span>
              </div>
            )}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = apiKey.trim();
              if (!trimmed) return toast.error("Paste a key first");
              if (!window.confirm("Replace the current DeepSeek API key with this new one?")) return;
              saveKey.mutate(trimmed);
            }}
            className="flex flex-col sm:flex-row gap-2"
          >
            <Input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              placeholder="Paste new DeepSeek key (sk-…)"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="font-mono text-sm"
            />
            <div className="flex gap-2">
              <Button type="submit" disabled={saveKey.isPending || !apiKey.trim()}>
                {saveKey.isPending ? "Saving…" : "Save & replace"}
              </Button>
              {keyStatus?.source === "database" && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={clearKey.isPending}
                  onClick={() => {
                    if (!window.confirm("Remove the saved DeepSeek key? Processing will stop until a new key is saved.")) return;
                    clearKey.mutate();
                  }}
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                >{clearKey.isPending ? "…" : "Clear"}</Button>
              )}
            </div>
          </form>
          {keyStatus?.configured && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={revealKey.isPending}
                onClick={() => {
                  if (!window.confirm("Reveal the current DeepSeek key? It will be shown here and copied to your clipboard for 20 seconds.")) return;
                  revealKey.mutate();
                }}
              >{revealKey.isPending ? "…" : revealed ? "Re-copy" : "Reveal & copy current key"}</Button>
              {revealed && (
                <code className="font-mono text-xs bg-muted px-2 py-1 rounded break-all max-w-full">{revealed}</code>
              )}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Get a key at platform.deepseek.com → API Keys. Any batch already running uses whichever key was active when it started; new batches use the latest saved key.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invite a member</CardTitle>
          <CardDescription>Add an email to the allow-list.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => { e.preventDefault(); if (email) invite.mutate(email); }}
            className="flex gap-2"
          >
            <Input type="email" placeholder="teammate@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <Button type="submit" disabled={invite.isPending}>Invite</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Invitations</CardTitle></CardHeader>
        <CardContent>
          {invErr && <p className="text-sm text-destructive mb-2">Could not load invitations: {invErr instanceof Error ? invErr.message : String(invErr)}</p>}
          {invites && invites.length > 0 ? (
            <ul className="divide-y">
              {invites.map((i: any) => (
                <li key={i.id} className="py-2 flex items-center justify-between">
                  <div>
                    <div className="font-medium text-sm">{i.email}</div>
                    <div className="text-xs text-muted-foreground">{i.status}</div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => revoke.mutate(i.id)}>Remove</Button>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted-foreground">No invitations yet.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Team members</CardTitle></CardHeader>
        <CardContent>
          {teamErr && <p className="text-sm text-destructive mb-2">Could not load team: {teamErr instanceof Error ? teamErr.message : String(teamErr)}</p>}
          {team && team.length > 0 ? (
            <ul className="divide-y">
              {team.map((p: any) => {
                const isAdmin = (p.roles ?? []).includes("admin");
                const isSelf = p.id === myUserId;
                const isLastAdmin = isAdmin && adminCount <= 1;
                const busy = roleMutation.isPending && roleMutation.variables?.targetUserId === p.id;
                return (
                  <li key={p.id} className="py-2 flex items-center justify-between gap-3">
                    <div className="min-w-0 flex items-start gap-3">
                      <UserAvatar path={p.avatar_url} name={p.full_name} email={p.email} size={40} />
                      <div className="min-w-0">
                        <div className="font-medium text-sm truncate">
                          {p.full_name || p.email}{isSelf && <span className="text-muted-foreground"> (you)</span>}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">{p.email}</div>
                      {(() => {
                        const s = statsByUser.get(p.id);
                        if (!s) return null;
                        const last = s.last_active ? new Date(s.last_active) : null;
                        return (
                          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                            <span title="Unique questions solved (duplicates removed)">
                              <span className="font-medium text-foreground">{s.unique_questions.toLocaleString()}</span> unique Qs
                            </span>
                            <span title="Total questions processed including duplicates">
                              · {s.questions_done.toLocaleString()} total
                            </span>
                            <span>· {s.batches_total.toLocaleString()} batches</span>
                            <span title="Downloaded documents (each doc counted once per format)">
                              · {s.documents_downloaded.toLocaleString()} downloads
                            </span>
                            {last && <span>· active {last.toLocaleDateString()}</span>}
                          </div>
                        );
                      })()}
                      <QuotaEditor
                        current={quotaByUser.get(p.id) ?? { question_limit: null, api_call_limit: null, used: 0, api_used: 0 }}
                        pending={saveQuota.isPending && saveQuota.variables?.userId === p.id}
                        onSave={(kind, value) => saveQuota.mutate({ userId: p.id, [kind]: value })}
                      />
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <div className="flex gap-1">
                        {(p.roles ?? []).map((r: string) => (
                          <span key={r} className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded">{r}</span>
                        ))}
                      </div>
                      {isAdmin ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || isLastAdmin}
                          title={isLastAdmin ? "Cannot demote the last admin" : "Remove admin access"}
                          onClick={() => {
                            if (!window.confirm(`Remove admin access from ${p.email}?`)) return;
                            roleMutation.mutate({ targetUserId: p.id, makeAdmin: false });
                          }}
                        >{busy ? "…" : "Demote"}</Button>
                      ) : (
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => roleMutation.mutate({ targetUserId: p.id, makeAdmin: true })}
                        >{busy ? "…" : "Make admin"}</Button>
                      )}
                      {!isSelf && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive hover:bg-destructive/10"
                          disabled={
                            (removeMember.isPending && removeMember.variables?.targetUserId === p.id) ||
                            (isAdmin && isLastAdmin)
                          }
                          title={isAdmin && isLastAdmin ? "Cannot remove the last admin" : "Remove from workspace"}
                          onClick={() => {
                            if (!window.confirm(
                              `Remove ${p.email} from the workspace?\n\nThis deletes their account, quotas and history. They can be re-invited any time.`,
                            )) return;
                            removeMember.mutate({ targetUserId: p.id });
                          }}
                        >{removeMember.isPending && removeMember.variables?.targetUserId === p.id ? "…" : "Remove"}</Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : <p className="text-sm text-muted-foreground">No team members yet.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
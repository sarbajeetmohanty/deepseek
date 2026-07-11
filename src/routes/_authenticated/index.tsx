import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { createBatch, deleteBatch } from "@/lib/batches.functions";
import { getMyQuota } from "@/lib/quotas.functions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";

export const Route = createFileRoute("/_authenticated/")({
  component: Dashboard,
  errorComponent: DashboardError,
  notFoundComponent: () => (
    <div className="max-w-md mx-auto text-center py-16 space-y-4">
      <h2 className="text-lg font-semibold">Not found</h2>
      <Link to="/"><Button>Back to dashboard</Button></Link>
    </div>
  ),
});

function DashboardError({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return (
    <div className="max-w-md mx-auto text-center py-16 space-y-4">
      <h2 className="text-lg font-semibold">Dashboard failed to load</h2>
      <p className="text-sm text-muted-foreground">{error.message}</p>
      <Button onClick={() => { router.invalidate(); reset(); }}>Try again</Button>
    </div>
  );
}

function Dashboard() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { userId } = Route.useRouteContext();
  const [title, setTitle] = useState("");
  const [rawText, setRawText] = useState("");
  const [subjectType, setSubjectType] = useState<"gk_english" | "math">("gk_english");
  const [solutionLength, setSolutionLength] = useState<"normal" | "long">("normal");

  const { data: batches, error: batchesErr } = useQuery({
    queryKey: ["batches", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("batches")
        .select("id,title,total,completed,failed,status,created_at")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw new Error(error.message);
      return data ?? [];
    },
    // Only poll while at least one batch is still processing.
    refetchInterval: (query) => {
      const list = query.state.data as { status?: string }[] | undefined;
      const active = list?.some((b) => b.status === "processing");
      return active ? 3000 : false;
    },
    retry: 1,
  });

  const create = useMutation({
    mutationFn: () => createBatch({ data: {
      title: title || `Batch ${new Date().toLocaleString()}`,
      rawText,
      subjectType,
      solutionLength,
    } }),
    onSuccess: (res) => {
      toast.success(`Started processing ${res.total} questions`);
      setRawText("");
      setTitle("");
      qc.invalidateQueries({ queryKey: ["batches"] });
      qc.invalidateQueries({ queryKey: ["my-quota"] });
      nav({ to: "/batch/$id", params: { id: res.batchId } });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Could not start batch"),
  });

  const remove = useMutation({
    mutationFn: (batchId: string) => deleteBatch({ data: { batchId } }),
    onSuccess: () => {
      toast.success("Batch deleted");
      qc.invalidateQueries({ queryKey: ["batches"] });
      qc.invalidateQueries({ queryKey: ["my-quota"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Could not delete batch"),
  });

  const { data: quota } = useQuery({
    queryKey: ["my-quota", userId],
    queryFn: () => getMyQuota({ data: {} } as any),
    staleTime: 30_000,
    retry: 1,
  });
  const detected = rawText.trim() ? (rawText.match(/^\s*\d{1,4}\.\s+/gm) || []).length : 0;
  const remaining = quota?.limit === null || quota?.limit === undefined
    ? null
    : Math.max(0, quota.limit - quota.used);
  const apiRemaining = quota?.apiLimit === null || quota?.apiLimit === undefined
    ? null
    : Math.max(0, quota.apiLimit - (quota.apiUsed ?? 0));
  const overLimit =
    (remaining !== null && detected > remaining) ||
    (apiRemaining !== null && detected > apiRemaining);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground mt-1">Paste raw MCQs. Get perfectly formatted questions & step-by-step solutions.</p>
        {quota && (
          <div className={`mt-3 flex flex-wrap items-center gap-2 text-xs`}>
            <div className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 ${remaining !== null && detected > remaining ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}>
              <span className="font-medium text-foreground">Questions:</span>
              {quota.limit === null
                ? <span>{quota.used.toLocaleString()} · unlimited</span>
                : <span>{quota.used.toLocaleString()} / {quota.limit.toLocaleString()} <span className="opacity-70">({(remaining ?? 0).toLocaleString()} left)</span></span>}
            </div>
            <div className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 ${apiRemaining !== null && detected > apiRemaining ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}>
              <span className="font-medium text-foreground">API calls:</span>
              {quota.apiLimit === null || quota.apiLimit === undefined
                ? <span>{(quota.apiUsed ?? 0).toLocaleString()} · unlimited</span>
                : <span>{(quota.apiUsed ?? 0).toLocaleString()} / {quota.apiLimit.toLocaleString()} <span className="opacity-70">({(apiRemaining ?? 0).toLocaleString()} left)</span></span>}
            </div>
          </div>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New batch</CardTitle>
          <CardDescription>Paste any number of questions (numbered like "374.", "375.", etc.) — we'll split, solve, and format them.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input placeholder="Batch title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label className="text-xs font-medium">Subject type</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={subjectType === "gk_english" ? "default" : "outline"}
                  onClick={() => setSubjectType("gk_english")}
                  className="flex-1"
                >General (any language)</Button>
                <Button
                  type="button"
                  size="sm"
                  variant={subjectType === "math" ? "default" : "outline"}
                  onClick={() => setSubjectType("math")}
                  className="flex-1"
                >Math</Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-xs font-medium">Solution length</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={solutionLength === "normal" ? "default" : "outline"}
                  onClick={() => setSolutionLength("normal")}
                  className="flex-1"
                >Normal</Button>
                <Button
                  type="button"
                  size="sm"
                  variant={solutionLength === "long" ? "default" : "outline"}
                  onClick={() => setSolutionLength("long")}
                  className="flex-1"
                >Long (detailed)</Button>
              </div>
            </div>
          </div>
          <Textarea
            className="min-h-[300px] font-mono text-sm"
            placeholder="Paste MCQs here…"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
          />
          <div className="flex justify-between items-center">
            <div className="text-xs text-muted-foreground">
              {rawText.trim()
                ? <>
                    {detected} questions detected
                    {overLimit && <span className="ml-1 text-destructive">· exceeds your remaining quota ({(remaining ?? 0).toLocaleString()} left)</span>}
                  </>
                : "Waiting for input…"}
            </div>
            <Button
              size="lg"
              disabled={!rawText.trim() || create.isPending || overLimit}
              onClick={() => create.mutate()}
            >
              {create.isPending ? "Starting…" : "Process batch"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Recent batches</h2>
        {batchesErr && (
          <p className="text-sm text-destructive">Could not load batches: {batchesErr instanceof Error ? batchesErr.message : String(batchesErr)}</p>
        )}
        {batches && batches.length > 0 ? (
          <div className="grid gap-3">
            {batches.map((b) => {
              const busy = remove.isPending && remove.variables === b.id;
              return (
                <Card key={b.id} className="hover:border-primary/50 transition-colors">
                  <CardContent className="py-4 flex items-center justify-between gap-4">
                    <Link
                      to="/batch/$id"
                      params={{ id: b.id }}
                      className="min-w-0 flex-1 block"
                    >
                      <div className="font-medium truncate">{b.title}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {formatDistanceToNow(new Date(b.created_at), { addSuffix: true })} · {b.completed}/{b.total} done{b.failed > 0 ? ` · ${b.failed} failed` : ""} · {b.status}
                      </div>
                    </Link>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!window.confirm(`Delete "${b.title}"? This removes all its questions and cannot be undone.`)) return;
                        remove.mutate(b.id);
                      }}
                      className="shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                    >{busy ? "…" : "Delete"}</Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No batches yet.</p>
        )}
      </div>
    </div>
  );
}
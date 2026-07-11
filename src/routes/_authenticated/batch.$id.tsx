import { createFileRoute, Link, useRouter, useNavigate, notFound } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, memo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { resumeBatch, deleteBatch } from "@/lib/batches.functions";
import { translateBatchToOpposite } from "@/lib/translate.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { downloadBatchAsDocx } from "@/lib/docx-export";
import { logDownload } from "@/lib/invitations.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/batch/$id")({
  component: BatchView,
  errorComponent: BatchError,
  notFoundComponent: BatchNotFound,
});

function BatchError({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return (
    <div className="max-w-md mx-auto text-center py-16 space-y-4">
      <h2 className="text-lg font-semibold">Could not load this batch</h2>
      <p className="text-sm text-muted-foreground">{error.message}</p>
      <div className="flex justify-center gap-2">
        <Button onClick={() => { router.invalidate(); reset(); }}>Try again</Button>
        <Link to="/"><Button variant="outline">Back to dashboard</Button></Link>
      </div>
    </div>
  );
}

function BatchNotFound() {
  return (
    <div className="max-w-md mx-auto text-center py-16 space-y-4">
      <h2 className="text-lg font-semibold">Batch not found</h2>
      <p className="text-sm text-muted-foreground">It may have been deleted, or the link is wrong.</p>
      <Link to="/"><Button>Back to dashboard</Button></Link>
    </div>
  );
}

function BatchView() {
  const { id } = Route.useParams();
  const [downloading, setDownloading] = useState<"original" | "translated" | null>(null);
  const [viewLang, setViewLang] = useState<"original" | "translated">("original");
  const qc = useQueryClient();

  const { data: batch, isLoading: batchLoading, error: batchErr } = useQuery({
    queryKey: ["batch", id],
    queryFn: async () => {
      const { data, error } = await supabase.from("batches").select("*").eq("id", id).maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw notFound();
      return data;
    },
    // Realtime handles live updates; use a slow safety-net poll only while
    // processing (in case the realtime socket dropped). Terminal → stop.
    refetchInterval: (query) => {
      const b = query.state.data as { status?: string } | undefined;
      return b && b.status !== "processing" ? false : 2000;
    },
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const { data: questions, error: qErr } = useQuery({
    queryKey: ["questions", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("questions")
        // Skip raw_text — it's large and never rendered here.
        .select("id, idx, status, error, formatted_output")
        .eq("batch_id", id)
        .order("idx", { ascending: true });
      if (error) throw new Error(error.message);
      return data ?? [];
    },
    // Realtime pushes UPDATEs → invalidates this query. Slow safety poll only.
    refetchInterval: () => {
      const b = qc.getQueryData<{ status?: string }>(["batch", id]);
      return b && b.status !== "processing" ? false : 2000;
    },
    refetchOnWindowFocus: false,
    retry: 1,
  });

  // Realtime: react to per-row status changes instantly, so UI updates without polling delay.
  useEffect(() => {
    const channel = supabase
      .channel(`batch-${id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "questions", filter: `batch_id=eq.${id}` },
        () => qc.invalidateQueries({ queryKey: ["questions", id] }),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "batches", filter: `id=eq.${id}` },
        () => qc.invalidateQueries({ queryKey: ["batch", id] }),
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [id, qc]);

  const resume = useMutation({
    mutationFn: () => resumeBatch({ data: { batchId: id } }),
    onSuccess: () => toast.success("Retrying failed questions"),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Could not retry"),
  });

  const nav = useNavigate();
  const remove = useMutation({
    mutationFn: () => deleteBatch({ data: { batchId: id } }),
    onSuccess: () => {
      toast.success("Batch deleted");
      qc.invalidateQueries({ queryKey: ["batches"] });
      nav({ to: "/" });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Could not delete batch"),
  });

  // Derive done-count safely even before batch/questions have loaded, so the
  // useQuery below is called unconditionally (Rules of Hooks).
  const doneCountForToggle = (questions ?? []).filter((q) => q.status === "done").length;

  // Fetch translated versions on demand (free Google Translate — no API key),
  // cached by react-query so the toggle is instant after the first fetch.
  const translatedQ = useQuery({
    queryKey: ["batch-translated", id],
    enabled: viewLang === "translated" && doneCountForToggle > 0,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: async () => {
      const { questions: rows, targetLang } = await translateBatchToOpposite({ data: { batchId: id } });
      const byIdx = new Map<number, string>();
      for (const r of rows) byIdx.set(r.idx, r.formatted_output ?? "");
      return { byIdx, targetLang };
    },
  });

  if (batchLoading) return <p className="text-sm text-muted-foreground">Loading batch…</p>;
  if (batchErr) throw batchErr;
  if (!batch) throw notFound();

  const pct = batch.total > 0 ? Math.round(((batch.completed + batch.failed) / batch.total) * 100) : 0;
  const doneQs = (questions ?? []).filter((q) => q.status === "done");
  const failedQs = (questions ?? []).filter((q) => q.status === "failed");
  const combinedText = doneQs.map((q) => q.formatted_output).filter(Boolean).join("\n\n");
  const providerBlocked = failedQs.some((q) => isProviderBlockedError(q.error));
  const translatedByIdx = translatedQ.data?.byIdx;
  const translatedTargetLabel = translatedQ.data?.targetLang === "hi" ? "Hindi" : "English";

  async function copyAll() {
    if (!combinedText) return toast.error("Nothing to copy yet.");
    try {
      if (!navigator.clipboard) throw new Error("Clipboard is unavailable in this browser.");
      await navigator.clipboard.writeText(combinedText);
      toast.success("Copied to clipboard — paste into Google Docs or Word");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not copy to clipboard");
    }
  }

  async function downloadOriginal() {
    if (!batch) return;
    setDownloading("original");
    try {
      await downloadBatchAsDocx(batch.title, doneQs, batch.subject_type as "gk_english" | "math" | undefined);
      // Fire-and-forget usage log; don't block the download UX on it.
      void logDownload({ data: { batchId: id, kind: "original" } }).catch(() => {});
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not download .docx");
    } finally {
      setDownloading(null);
    }
  }

  async function downloadTranslated() {
    if (!batch) return;
    setDownloading("translated");
    try {
      const { questions: translated, targetLang } = await translateBatchToOpposite({ data: { batchId: id } });
      const suffix = targetLang === "en" ? "English" : "Hindi";
      await downloadBatchAsDocx(`${batch.title} (${suffix})`, translated, batch.subject_type as "gk_english" | "math" | undefined);
      void logDownload({ data: { batchId: id, kind: "translated" } }).catch(() => {});
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not translate & download .docx");
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <Link to="/" className="text-sm text-muted-foreground hover:underline">← Back</Link>
        <div className="mt-2 flex items-start justify-between gap-3">
          <h1 className="text-2xl font-bold tracking-tight">{batch.title}</h1>
          <Button
            size="sm"
            variant="ghost"
            disabled={remove.isPending}
            onClick={() => {
              if (!window.confirm(`Delete "${batch.title}"? This removes all its questions and cannot be undone.`)) return;
              remove.mutate();
            }}
            className="text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
          >{remove.isPending ? "Deleting…" : "Delete batch"}</Button>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          {batch.completed} / {batch.total} done{batch.failed > 0 && ` · ${batch.failed} failed`} · status: {batch.status}
        </p>
        {qErr && (
          <p className="text-xs text-destructive mt-1">Could not refresh questions: {qErr instanceof Error ? qErr.message : String(qErr)}</p>
        )}
      </div>

      <Card>
        <CardContent className="py-4 space-y-3">
          <Progress value={pct} />
          {providerBlocked && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              DeepSeek balance/API access is blocking this batch. Add funds to DeepSeek or save a funded API key, then use retry.
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={copyAll} disabled={doneQs.length === 0}>Copy all ({doneQs.length})</Button>
            <Button
              variant="secondary"
              disabled={doneQs.length === 0 || downloading !== null}
              onClick={downloadOriginal}
            >
              {downloading === "original" ? "Building .docx…" : "Download .docx"}
            </Button>
            <Button
              variant="secondary"
              disabled={doneQs.length === 0 || downloading !== null}
              onClick={downloadTranslated}
            >
              {downloading === "translated" ? "Translating & building…" : "Download translated .docx"}
            </Button>
            {failedQs.length > 0 && (
              <Button variant="outline" onClick={() => resume.mutate()} disabled={resume.isPending}>
                {providerBlocked ? `I topped up — retry ${failedQs.length}` : `Retry ${failedQs.length} failed`}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="space-y-3">
        {doneQs.length > 0 && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">View:</span>
            <div className="inline-flex rounded-md border overflow-hidden">
              <button
                type="button"
                onClick={() => setViewLang("original")}
                className={`px-3 py-1 ${viewLang === "original" ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted"}`}
              >Original</button>
              <button
                type="button"
                onClick={() => setViewLang("translated")}
                className={`px-3 py-1 border-l ${viewLang === "translated" ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted"}`}
              >{viewLang === "translated" && translatedQ.data ? `Translated (${translatedTargetLabel})` : "Translated"}</button>
            </div>
            {viewLang === "translated" && translatedQ.isFetching && (
              <span className="text-muted-foreground italic">translating…</span>
            )}
            {viewLang === "translated" && translatedQ.error && (
              <span className="text-destructive">Could not translate: {translatedQ.error instanceof Error ? translatedQ.error.message : String(translatedQ.error)}</span>
            )}
          </div>
        )}
        {(questions ?? []).map((q) => (
          <Card key={q.id} className={q.status === "failed" ? "border-destructive/40" : ""}>
            <CardHeader className="py-3 flex-row items-center justify-between">
              <span className="text-xs font-mono text-muted-foreground">Q{q.idx}</span>
              <span className={`text-xs px-2 py-0.5 rounded ${
                q.status === "done" ? "bg-primary/10 text-primary" :
                q.status === "processing" ? "bg-secondary" :
                q.status === "failed" ? "bg-destructive/10 text-destructive" : "bg-muted"
              }`}>{q.status}</span>
            </CardHeader>
            <CardContent className="pt-0">
              {q.formatted_output ? (
                <FormattedOutput
                  text={
                    viewLang === "translated" && translatedByIdx?.get(q.idx)
                      ? (translatedByIdx.get(q.idx) as string)
                      : q.formatted_output
                  }
                  subjectType={batch.subject_type as "gk_english" | "math" | undefined}
                />
              ) : q.error ? (
                <p className="text-sm text-destructive">{formatQuestionError(q.error)}</p>
              ) : (
                <p className="text-sm text-muted-foreground italic">Processing…</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function isProviderBlockedError(error: string | null): boolean {
  if (!error) return false;
  return /balance is exhausted|insufficient balance|api key was rejected/i.test(error);
}

function formatQuestionError(error: string): string {
  if (/insufficient balance/i.test(error)) {
    return "DeepSeek account balance is exhausted. Add funds to DeepSeek or save a funded API key, then retry this batch.";
  }

  return error;
}

const FormattedOutput = memo(function FormattedOutput({ text, subjectType }: { text: string; subjectType?: "gk_english" | "math" }) {
  const isMath = subjectType === "math";
  const lines = text.split("\n").map((l) => l.replace(/\s+$/g, "")).filter((l) => l.trim().length > 0);
  const blocks: React.ReactNode[] = [];
  let seenQuestion = false;
  let inSolution = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const q = line.match(/^(\d{1,4})\.\s+(.*)$/);
    if (q && !seenQuestion) {
      seenQuestion = true;
      inSolution = false;
      blocks.push(
        <p key={i} className="text-[15px] leading-7 font-semibold mb-3">
          <span>{q[1]}. {q[2]}</span>
        </p>,
      );
      continue;
    }
    if (/^Column\s+A:/i.test(line)) {
      inSolution = false;
      const colA: string[] = [];
      const colB: string[] = [];
      let j = i + 1;
      while (j < lines.length && !/^Column\s+B:/i.test(lines[j])) {
        colA.push(lines[j]);
        j++;
      }
      if (j < lines.length && /^Column\s+B:/i.test(lines[j])) {
        j++; // skip Column B:
        while (j < lines.length && !/^[A-D]\.\s/.test(lines[j]) && !/^Answer:/i.test(lines[j])) {
          colB.push(lines[j]);
          j++;
        }
      }
      blocks.push(
        <div key={i} className="flex flex-row gap-8 w-full my-3 px-4">
          <div className="flex-1 space-y-1">
            <div className="font-semibold underline mb-1">Column A</div>
            {colA.map((c, idx) => {
              const m = c.match(/^([1-9]|[a-h])[.)]?\s+(.*)$/);
              return m 
                ? <div key={idx} className="text-[15px] leading-7"><span className="font-semibold">{m[1]} </span>{m[2]}</div>
                : <div key={idx} className="text-[15px] leading-7">{c}</div>;
            })}
          </div>
          <div className="flex-1 space-y-1">
            <div className="font-semibold underline mb-1">Column B</div>
            {colB.map((c, idx) => {
              const m = c.match(/^([1-9]|[a-h])[.)]?\s+(.*)$/);
              return m 
                ? <div key={idx} className="text-[15px] leading-7"><span className="font-semibold">{m[1]} </span>{m[2]}</div>
                : <div key={idx} className="text-[15px] leading-7">{c}</div>;
            })}
          </div>
        </div>
      );
      i = j - 1;
      continue;
    }
    const opt = line.match(/^([A-D])\.\s+(.*)$/);
    if (opt) {
      inSolution = false;
      blocks.push(
        <p key={i} className="text-[15px] leading-7 pl-4 my-1.5 font-semibold">
          {opt[1]}. {opt[2]}
        </p>,
      );
      continue;
    }
    if (/^Answer:/i.test(line)) {
      inSolution = false;
      blocks.push(
        <p key={i} className="text-[15px] leading-7 mt-4">
          <span className="font-semibold">Answer:</span> {line.replace(/^Answer:\s*/i, "")}
        </p>,
      );
      return;
    }
    if (/^Solution:/i.test(line)) {
      inSolution = true;
      const rest = line.replace(/^Solution:\s*/i, "");
      blocks.push(
        <p key={i} className="text-[15px] leading-7 mt-2">
          <span className="font-semibold">Solution:</span>{rest ? ` ${rest}` : ""}
        </p>,
      );
      return;
    }
    const step = inSolution ? line.match(/^(\d{1,2})\.\s+(.*)$/) : null;
    if (step) {
      if (isMath) {
        // Retroactively render math numbered steps as red-dash bullets.
        blocks.push(
          <div key={i} className="flex gap-2 text-[15px] leading-7 pl-4 my-1">
            <span className="text-red-600 font-bold select-none">-</span>
            <span>{step[2]}</span>
          </div>,
        );
        return;
      }
      blocks.push(
        <p key={i} className="text-[15px] leading-7 pl-6 my-1">
          <span className="font-semibold">{step[1]}.</span> {step[2]}
        </p>,
      );
      return;
    }
    const dashStep = inSolution ? line.match(/^-\s+(.*)$/) : null;
    if (dashStep) {
      blocks.push(
        <div key={i} className="flex gap-2 text-[15px] leading-7 pl-4 my-1">
          <span className="text-red-600 font-bold select-none">-</span>
          <span>{dashStep[1]}</span>
        </div>,
      );
      return;
    }
    const b = line.match(/^\*\s+(.*)$/);
    if (b) {
      inSolution = false;
      blocks.push(
        <div key={i} className="flex gap-2 text-[15px] leading-7 pl-1 mt-1">
          <span className="text-muted-foreground select-none">•</span>
          <span>{b[1]}</span>
        </div>,
      );
      return;
    }
    blocks.push(<p key={i} className="text-[15px] leading-7">{line}</p>);
  });

  return <div className="font-sans">{blocks}</div>;
});
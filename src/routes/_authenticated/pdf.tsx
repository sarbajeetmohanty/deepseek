import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { createBatch, deleteBatch } from "@/lib/batches.functions";
import { getMyQuota } from "@/lib/quotas.functions";
import { extractTextFromImage, generateFromContext } from "@/lib/ocr.functions";
import { getUserPrompts, saveUserPrompt, deleteUserPrompt, updateUserPrompt } from "@/lib/prompts.functions";
import { parseQuestions } from "@/lib/parse-questions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";

export const Route = createFileRoute("/_authenticated/pdf")({
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

  // --- PDF Engine State ---
  const pdfjsRef = useRef<any>(null);
  const [pdfStatus, setPdfStatus] = useState<"idle" | "working_phase1" | "working_phase2" | "done" | "error">("idle");
  const [pdfProgress, setPdfProgress] = useState({ done: 0, total: 0 });
  const [pdfError, setPdfError] = useState<string | null>(null);

  const { data: prompts = [] } = useQuery({
    queryKey: ["prompts", userId],
    queryFn: () => getUserPrompts({ data: { userId } }),
  });
  
  const [selectedPromptId, setSelectedPromptId] = useState<string>("default");
  const [isAddingPrompt, setIsAddingPrompt] = useState(false);
  const [isEditingPrompt, setIsEditingPrompt] = useState(false);
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [newPromptName, setNewPromptName] = useState("");
  const [newPromptText, setNewPromptText] = useState("");

  useEffect(() => {
    let isMounted = true;
    const initEngine = async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
        pdfjsRef.current = pdfjs;
      } catch (err) {
        console.error("Failed to initialize PDF engine", err);
      }
    };
    initEngine();
    return () => { isMounted = false; };
  }, []);

  const savePromptMut = useMutation({
    mutationFn: () => saveUserPrompt({ data: { userId, name: newPromptName.trim(), text: newPromptText.trim() } }),
    onSuccess: (newPrompt) => {
      qc.invalidateQueries({ queryKey: ["prompts", userId] });
      setSelectedPromptId(newPrompt.id);
      setIsAddingPrompt(false);
      setNewPromptName("");
      setNewPromptText("");
      toast.success("Prompt saved!");
    },
    onError: (e) => toast.error(e.message)
  });

  const deletePromptMut = useMutation({
    mutationFn: (id: string) => deleteUserPrompt({ data: { id, userId } }),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["prompts", userId] });
      if (selectedPromptId === id) setSelectedPromptId("default");
      toast.success("Prompt deleted");
    },
    onError: (e) => toast.error(e.message)
  });

  const editPromptMut = useMutation({
    mutationFn: (data: { id: string, name: string, text: string }) => updateUserPrompt({ data: { ...data, userId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["prompts", userId] });
      setIsEditingPrompt(false);
      setEditingPromptId(null);
      setNewPromptName("");
      setNewPromptText("");
      toast.success("Prompt updated!");
    },
    onError: (e) => toast.error(e.message)
  });

  function saveNewPrompt() {
    if (!newPromptName.trim() || !newPromptText.trim()) return;
    savePromptMut.mutate();
  }

  function deletePrompt(id: string) {
    deletePromptMut.mutate(id);
  }

  async function handlePdfUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setPdfError(null);
    setPdfStatus("working_phase1");
    
    try {
      if (!pdfjsRef.current) throw new Error("PDF Library is still loading...");
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsRef.current.getDocument({ data: arrayBuffer }).promise;
      const totalPages = pdf.numPages;
      setPdfProgress({ done: 0, total: totalPages });

      const activePrompt = prompts.find(p => p.id === selectedPromptId)?.text;
      const isTwoPhase = selectedPromptId !== "default" && !!activePrompt;

      const images: { pageNum: number, url: string }[] = [];
      for (let i = 1; i <= totalPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1.5 }); 
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Could not create canvas context");
        canvas.height = viewport.height;
        canvas.width = viewport.width;

        await page.render({ canvasContext: context, viewport }).promise;
        images.push({ pageNum: i, url: canvas.toDataURL("image/jpeg", 0.7) }); 
        page.cleanup();
      }

      const MAX_CONCURRENCY = 15; 
      let queueIndex = 0;
      let phase1Pages: { pageNumber: number, text: string }[] = [];

      const worker = async () => {
        while (queueIndex < images.length) {
          const currentIndex = queueIndex++;
          const { pageNum, url } = images[currentIndex]!;
          
          const responseText = await extractTextFromImage({ 
            data: { data: url, customPrompt: undefined }
          });
          
          const text = typeof responseText === 'string' ? responseText : JSON.stringify(responseText);
          phase1Pages.push({ pageNumber: pageNum, text: text.trim() });

          setPdfProgress(prev => ({ ...prev, done: prev.done + 1 }));
        }
      };

      const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, images.length) }, () => worker());
      await Promise.all(workers);

      let finalOutput = "";

      if (isTwoPhase) {
        setPdfStatus("working_phase2");
        const fullContext = phase1Pages
          .sort((a, b) => a.pageNumber - b.pageNumber)
          .map(p => `--- PAGE ${p.pageNumber} ---\n${p.text}`)
          .join("\n\n");
          
        const strictPrompt = activePrompt + `
          
CRITICAL FORMATTING INSTRUCTION: 
You MUST number every single generated question sequentially using the exact prefix 'Q1.', 'Q2.', 'Q3.', etc. (e.g. Q1. What is...). Do NOT use any other numbering format like '1.' or just 'Q.'. You must include the 'Q' followed by the number and a dot. Do NOT use markdown bold/italics for the question numbering (e.g. do NOT write **Q1.**, just write plain Q1.). This is strictly required for our parser to detect the questions.

CRITICAL ACCURACY INSTRUCTION:
1. You MUST extract the options (A, B, C, D) exactly as they appear in the source text. DO NOT alter, swap, or rephrase them.
2. You MUST provide the 100% correct Answer. Look for the answer key in the text and match it perfectly. Do NOT hallucinate or guess the answer.
3. If you are generating new questions based on the text, the facts, options, and answers MUST be 100% logically sound and strictly derived from the provided context.`;
        
        const responseText = await generateFromContext({
          data: { contextText: fullContext, customPrompt: strictPrompt }
        });
        
        finalOutput = typeof responseText === 'string' ? responseText : JSON.stringify(responseText);
      } else {
        finalOutput = phase1Pages
          .sort((a, b) => a.pageNumber - b.pageNumber)
          .map(p => p.text)
          .join("\n\n---\n\n");
      }

      setRawText(finalOutput);
      const finalTitle = title || file.name.replace(/\.[^/.]+$/, "");
      if (!title) setTitle(finalTitle);
      setPdfStatus("done");
      toast.success("PDF extracted! Starting batch processing...");
      
      create.mutate({ title: finalTitle, rawText: finalOutput });
      
    } catch (cause) {
      console.error(cause);
      setPdfError(cause instanceof Error ? cause.message : "Something went wrong while extracting.");
      setPdfStatus("error");
    }
  }
  // --- End PDF Engine State ---

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
    mutationFn: (variables?: { title?: string, rawText?: string }) => createBatch({ data: {
      title: variables?.title || title || `Batch ${new Date().toLocaleString()}`,
      rawText: variables?.rawText ?? rawText,
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
  const detected = rawText.trim() ? parseQuestions(rawText).length : 0;
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
            
            <div className="space-y-3 col-span-full border-t border-border/50 pt-4 mt-2">
              <Label className="text-sm font-medium">Custom Prompt (Optional)</Label>
              <div className="flex flex-wrap gap-2 items-center">
                <Button 
                  type="button" 
                  size="sm" 
                  variant={selectedPromptId === "default" ? "default" : "outline"}
                  onClick={() => setSelectedPromptId("default")}
                >
                  Default (No extra prompt)
                </Button>
                {prompts.map(p => (
                  <div key={p.id} className="relative group flex items-center">
                    <Button 
                      type="button" 
                      size="sm" 
                      variant={selectedPromptId === p.id ? "default" : "outline"}
                      onClick={() => setSelectedPromptId(p.id)}
                      className="pr-8"
                    >
                      {p.name}
                    </Button>
                    <button 
                      type="button"
                      onClick={(e) => { 
                        e.stopPropagation(); 
                        setIsEditingPrompt(true);
                        setIsAddingPrompt(false);
                        setEditingPromptId(p.id);
                        setNewPromptName(p.name);
                        setNewPromptText(p.text);
                        setSelectedPromptId(p.id);
                      }}
                      className="absolute right-6 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity rounded-full hover:bg-primary/10"
                      title="Edit prompt"
                    >
                      <svg width="12" height="12" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11.8536 1.14645C11.6583 0.951184 11.3417 0.951184 11.1465 1.14645L3.71455 8.57836C3.62459 8.66832 3.55263 8.77461 3.50251 8.89155L2.04044 12.303C1.9599 12.491 2.00189 12.709 2.14646 12.8536C2.29103 12.9981 2.50905 13.0401 2.69697 12.9596L6.10847 11.4975C6.2254 11.4474 6.3317 11.3754 6.42166 11.2855L13.8536 3.85355C14.0488 3.65829 14.0488 3.34171 13.8536 3.14645L11.8536 1.14645ZM4.42166 9.28547L11.5 2.20711L12.7929 3.5L5.71455 10.5784L4.21924 11.2192L3.78081 10.7808L4.42166 9.28547Z" fill="currentColor" fillRule="evenodd" clipRule="evenodd"></path></svg>
                    </button>
                    <button 
                      type="button"
                      onClick={(e) => { e.stopPropagation(); deletePrompt(p.id); }}
                      className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity rounded-full hover:bg-destructive/10"
                      title="Delete prompt"
                    >
                      <svg width="12" height="12" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.5 1C5.22386 1 5 1.22386 5 1.5C5 1.77614 5.22386 2 5.5 2H9.5C9.77614 2 10 1.77614 10 1.5C10 1.22386 9.77614 1 9.5 1H5.5ZM3 3.5C3 3.22386 3.22386 3 3.5 3H11.5C11.7761 3 12 3.22386 12 3.5C12 3.77614 11.7761 4 11.5 4H11V12C11 12.5523 10.5523 13 10 13H5C4.44772 13 4 12.5523 4 12V4H3.5C3.22386 4 3 3.77614 3 3.5ZM5 4V12H10V4H5Z" fill="currentColor" fillRule="evenodd" clipRule="evenodd"></path></svg>
                    </button>
                  </div>
                ))}
                <Button type="button" size="sm" variant="outline" className="border-dashed" onClick={() => { setIsAddingPrompt(true); setIsEditingPrompt(false); setNewPromptName(""); setNewPromptText(""); }}>
                  + New Prompt
                </Button>
              </div>
              
              {(isAddingPrompt || isEditingPrompt) && (
                <div className="rounded-md border border-border p-4 space-y-3 bg-secondary/10 mt-2">
                  <Input placeholder="Prompt Name (e.g. History Translation)" value={newPromptName} onChange={(e) => setNewPromptName(e.target.value)} />
                  <Textarea placeholder="Write your prompt instruction here..." value={newPromptText} onChange={(e) => setNewPromptText(e.target.value)} />
                  <div className="flex gap-2 justify-end">
                    <Button type="button" size="sm" variant="ghost" onClick={() => { setIsAddingPrompt(false); setIsEditingPrompt(false); setEditingPromptId(null); }}>Cancel</Button>
                    <Button type="button" size="sm" disabled={savePromptMut.isPending || editPromptMut.isPending} onClick={() => {
                      if (!newPromptName.trim() || !newPromptText.trim()) return;
                      if (isEditingPrompt && editingPromptId) {
                        editPromptMut.mutate({ id: editingPromptId, name: newPromptName.trim(), text: newPromptText.trim() });
                      } else {
                        savePromptMut.mutate();
                      }
                    }}>
                      {(savePromptMut.isPending || editPromptMut.isPending) ? "Saving..." : (isEditingPrompt ? "Update Prompt" : "Save Prompt")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
            
            <div className="space-y-3 col-span-full mb-4">
              <Label className="text-sm font-medium">Auto-Extract from PDF</Label>
              <div className="relative group border-2 border-dashed border-border/60 hover:border-primary/50 rounded-xl p-8 flex flex-col items-center justify-center text-center bg-secondary/5 hover:bg-secondary/10 transition-all">
                <input
                  type="file"
                  accept="application/pdf"
                  onChange={handlePdfUpload}
                  disabled={pdfStatus.startsWith("working")}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
                />
                <div className="flex flex-col items-center gap-3 pointer-events-none">
                  <div className="p-3 bg-background rounded-full shadow-sm border border-border/50 group-hover:scale-105 transition-transform">
                    <svg width="24" height="24" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-muted-foreground group-hover:text-primary transition-colors"><path d="M4.5 1C3.67157 1 3 1.67157 3 2.5V12.5C3 13.3284 3.67157 14 4.5 14H10.5C11.3284 14 12 13.3284 12 12.5V5.5L7.5 1H4.5ZM8 1.5V5H11.5L8 1.5ZM2 2.5C2 1.11929 3.11929 0 4.5 0H7.5C7.76522 0 8.01957 0.105357 8.20711 0.292893L12.7071 4.79289C12.8946 4.98043 13 5.23478 13 5.5V12.5C13 13.8807 11.8807 15 10.5 15H4.5C3.11929 15 2 13.8807 2 12.5V2.5Z" fill="currentColor" fillRule="evenodd" clipRule="evenodd"></path></svg>
                  </div>
                  <div>
                    <p className="text-sm font-medium">Click or drag a PDF file here</p>
                    <p className="text-xs text-muted-foreground mt-1">We'll automatically extract the text using the selected prompt</p>
                  </div>
                </div>
              </div>
              {pdfStatus.startsWith("working") && (
                <div className="mt-2 text-xs">
                  {pdfStatus === "working_phase1" ? (
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 bg-secondary rounded-full overflow-hidden">
                        <div className="h-full bg-primary transition-all duration-300" style={{ width: `${(pdfProgress.done / Math.max(1, pdfProgress.total)) * 100}%` }} />
                      </div>
                      <span className="tabular-nums">Extracting {pdfProgress.done} / {pdfProgress.total}</span>
                    </div>
                  ) : (
                    <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden">
                      <div className="h-full bg-primary w-full animate-[pulse_2s_ease-in-out_infinite]" />
                    </div>
                  )}
                  {pdfStatus === "working_phase2" && <p className="mt-1 text-muted-foreground">Applying global context prompt...</p>}
                </div>
              )}
              {pdfError && <p className="text-sm text-destructive mt-1">{pdfError}</p>}
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
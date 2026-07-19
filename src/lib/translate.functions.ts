import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Free Google Translate endpoint — no API key. Preserves \n between segments.
// `source` can be "auto" so Google detects the language for us.
async function gtranslate(text: string, source: string, target: string): Promise<string> {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${source}&tl=${target}&dt=t&q=${encodeURIComponent(text)}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`Google Translate ${res.status}`);
    const json = (await res.json()) as unknown;
    // Response is [[[segment, ...], ...], ...]
    if (!Array.isArray(json) || !Array.isArray(json[0])) return text;
    return (json[0] as unknown[])
      .map((seg) => (Array.isArray(seg) && typeof seg[0] === "string" ? (seg[0] as string) : ""))
      .join("");
  } finally {
    clearTimeout(timer);
  }
}



// Re-force canonical labels + question number after translation. Google Translate
// sometimes reorders/renames "Answer:", "Solution:", "Column A:" — restore them.
function normalizeTranslated(text: string, idx: number): string {
  let s = text.replace(/\r\n?/g, "\n");
  s = s.replace(/^\s*\d{1,4}\s*[\.\)]\s+/, `${idx}. `);
  s = s.replace(/^\s*(Ans(?:wer)?|उत्तर)\s*[:.-]\s*/gim, "Answer: ");
  s = s.replace(/^\s*(Sol(?:ution)?|समाधान|हल)\s*[:.-]\s*/gim, "Solution: ");
  s = s.replace(/^\s*(?:Column|कॉलम|स्तंभ)\s*([AB])\s*[:.-]?\s*$/gim, "Column $1:");
  // Normalize step labels emitted by translation ("Step 1:" etc.) back to "1. "
  s = s.replace(/(?:^|\n)\s*(?:Step|Chran|Pad)\s*(\d+)\s*[:.\-)]\s*/gi, "\n$1. ");
  // Break inline numbered steps onto their own line ("... .  2. ..." -> newline)
  s = s.replace(/(\.\s+)(?=\d{1,2}\.\s)/g, ".\n");
  // Some translations rewrite bullets — restore leading "* " for lines that start with a bullet char.
  s = s.replace(/^\s*[•·●○◦]\s+/gm, "* ");
  // Collapse 3+ blank lines
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

// Simple concurrency-limited map.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const runWorker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  };
  for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(runWorker());
  await Promise.all(workers);
  return results;
}

export const translateBatchToOpposite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { batchId: string }) => {
    if (!data?.batchId) throw new Error("batchId required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: rows, error } = await supabase
      .from("questions")
      .select("id, idx, formatted_output")
      .eq("batch_id", data.batchId)
      .eq("status", "done")
      .order("idx", { ascending: true });
    if (error) throw new Error(`Could not load questions: ${error.message}`);
    if (!rows || rows.length === 0) throw new Error("Nothing to translate — no completed questions.");

    // The target language is always English now since the original solution is always in Hindi.
    const majorityTarget = "en";

    const translated = await mapLimit(rows, 8, async (r) => {
      const src = (r.formatted_output ?? "").trim();
      if (!src) return { idx: r.idx, formatted_output: "" };
      try {
        const out = await gtranslate(src, "auto", "en");
        return { idx: r.idx, formatted_output: normalizeTranslated(out, r.idx) };
      } catch (e) {
        console.error("translate failed for idx", r.idx, e);
        // Fall back to the original so the download never fully fails.
        return { idx: r.idx, formatted_output: src };
      }
    });
    return { questions: translated, targetLang: majorityTarget };
  });
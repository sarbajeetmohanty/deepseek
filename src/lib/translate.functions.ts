import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  normalizeOptionsInText,
  normalizeAnswerInText,
  protectOptionsForTranslation,
} from "./normalize-options";

// Free Google Translate endpoint — no API key. Preserves \n between segments.
// `source` can be "auto" so Google detects the language for us.
export async function gtranslate(text: string, source: string, target: string): Promise<string> {
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
export function normalizeTranslated(text: string, idx: number): string {
  let s = text.replace(/\r\n?/g, "\n");
  s = s.replace(/^\s*(?:(?:[Qq]\.?(?:uestion|ue|ues)?|Problem|Prob|MCQ|Item|Task|Case)(?:[ \t]*(?:No|Num|Number|#)\.?)?|प्रश्न(?:[ \t]*(?:संख्या|सं\.?|क्र\.?|क्रमांक))?|प्र\.?[ \t]*(?:संख्या|सं\.?|क्र\.?|क्रमांक)?|सवाल(?:[ \t]*(?:संख्या|सं\.?|क्र\.?|क्रमांक))?|क्र\.?[ \t]*(?:सं\.?|संख्या)?|[?¿\uFFFD]+)?[ \t]*[:.-]?[ \t]*\d{1,4}\s*[:.\-)\s]\s*/i, `${idx}. `);

  // Reunite orphaned numbers that are on a line by themselves: "1\nText..." -> "1 Text..."
  s = s.replace(/(?:^|\n)\s*(\((?:[1-9]|10|i{1,3}|iv|v)\)|[1-9]|10)[.)]?\s*\n\s*(?=\S)/g, "\n$1 ");

  // Break inline numbered statements inside question body before options (protect decimal numbers!)
  s = s.replace(/([:：])\s*(?=(?:[1-9]|10|\((?:[1-9]|10|i{1,3}|iv|v)\))\s*[.,):\-–—]?\s+)/g, "$1\n");
  s = s.replace(/([।\?!;]|(?<!\d)\.(?!\d))\s*(?=(?:[2-9]|10|\((?:[2-9]|10|i{1,3}|iv|v)\))\s*[.,):\-–—]?\s+[^\s\d])/g, "$1\n");
  s = s.replace(/([।\?!;]|(?<!\d)\.(?!\d))\s*(?=(?:उपर्युक्त|उपरोक्त|इनमें|निम्न|Which of the|Of the above)[^\n]*[\?？:])/gi, "$1\n");

  s = s.replace(/^\s*(Ans(?:wer)?|उत्तर)\s*[:.-]\s*/gim, "Answer: ");
  s = s.replace(/^\s*(Sol(?:ution)?|समाधान|हल)\s*[:.-]\s*/gim, "Solution: ");
  s = s.replace(/^\s*(?:Column|कॉलम|स्तंभ|List|सूची|[?¿\uFFFD]+)[\s\-]*\(?([ABI12]|II)\)?(?:\([^\)\n]+\))?\s*[:.-]?\s*$/gim, (m, p1) => {
    return `Column ${/A|I|1/i.test(p1) ? 'A' : 'B'}:`;
  });

  s = s.replace(/(?<=\S)[^\S\r\n]*(?=Solution:)/gi, "\n\n");
  s = s.replace(/^(Solution:\s*)(\S)/gim, "$1\n$2");
  
  // Fix "Code:" / "कूट :" glued to previous text or to options
  s = s.replace(/(?<=\S)[^\S\r\n]+((?:उत्तर\s*)?(?:कूट|कोड|Code|Codes)\s*(?::|:-|[-–—]|(?=\s*(?:[A-Ha-h]\.|\([a-hA-H1-8]\)|[A-Ha-h]\)))))/gim, "\n$1");
  s = s.replace(/^((?:उत्तर\s*)?(?:कूट|कोड|Code|Codes)\s*[:.\-]*)[^\S\r\n]+(?=(?:[A-Ha-h]\.|\([a-hA-H1-8]\)|[A-Ha-h]\)))/gim, "$1\n");
  // Only add space after option label if at line start or after 2+ spaces, and NOT followed by an abbreviation like B.C., A.D., C.E.
  s = s.replace(/(?:^|[^\S\r\n]{2,})([A-Ha-h]\.)(?!\s*[A-Za-z]\.)([^\s.])/gm, (m, g1, g2) => {
    return m.slice(0, m.length - g1.length - g2.length) + g1 + " " + g2;
  });
  s = s.replace(/(?<![A-Za-z0-9])(\([a-hA-H1-8]\)|[A-Ha-h]\))(?=[^\s:.\-])/g, "$1 ");
  s = s.replace(/(?<=\S)[^\S\r\n]{2,}(?=\((?:[1-9]|10|i{1,3}|iv|v|vi)\)\s+)/gi, "\n");
  s = s.replace(/(?<!Answer:)(?<=\S)\s+(?=(?:[B-Db-d][.)](?!\s*[A-Za-z]\.)|\([b-dB-D]\)|[B-Db-d]\))\s+)/g, "\n");
  s = s.replace(/(?<=\S)\s+(?=(?:Answer|Ans)\s*[:.-])/gi, "\n");
  s = s.replace(/^((?:[A-Ha-h]\.)|(?:\([a-h1-8]\)))\s*\n\s*/gm, "$1 ");

  // Normalize step labels emitted by translation ("Step 1:", "चरण 1:", etc.) to "1 "
  s = s.replace(/(?:^|\n)\s*(?:Step|Chran|Pad|चरण|पद)\s*(\d+)\s*[:.\-)]\s*/gi, "\n$1 ");
  // Break inline numbered steps onto their own line ("... .  2. ..." -> newline, never splitting decimals)
  s = s.replace(/((?<!\d)\.\s+)(?=\d{1,2}\s+[^\s\d])/g, ".\n");
  // Some translations rewrite bullets — restore leading "* " for lines that start with a bullet char.
  s = s.replace(/^\s*[•·●○◦]\s+/gm, "* ");

  s = normalizeAnswerInText(s);
  s = normalizeOptionsInText(s);
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

    // Extract the question/options portion (before Solution:) to detect whether the source question is English or Hindi.
    // DeepSeek solution is in Hindi by default, so we only evaluate the question body to detect the original language.
    let devanagariCount = 0;
    let latinCount = 0;
    for (const r of rows) {
      const text = r.formatted_output ?? "";
      const match = text.match(/\b(?:Solution|हल|समाधान)\s*:/i);
      const questionPrefix = match ? text.slice(0, match.index) : text;
      devanagariCount += (questionPrefix.match(/[\u0900-\u097F]/g) || []).length;
      latinCount += (questionPrefix.match(/[a-zA-Z]/g) || []).length;
    }

    // If question body is predominantly Hindi (Devanagari), translate to English ("en").
    // If question body is predominantly English (Latin), translate to Hindi ("hi").
    const isHindiSource = devanagariCount > latinCount;
    const majorityTarget: "en" | "hi" = isHindiSource ? "en" : "hi";

    const translated = await mapLimit(rows, 8, async (r) => {
      const src = (r.formatted_output ?? "").trim();
      if (!src) return { idx: r.idx, formatted_output: "" };
      try {
        const textToTranslate = majorityTarget === "hi" ? protectOptionsForTranslation(src) : src;
        const out = await gtranslate(textToTranslate, "auto", majorityTarget);
        return { idx: r.idx, formatted_output: normalizeTranslated(out, r.idx) };
      } catch (e) {
        console.error("translate failed for idx", r.idx, e);
        // Fall back to the original so the download never fully fails.
        return { idx: r.idx, formatted_output: src };
      }
    });
    return { questions: translated, targetLang: majorityTarget };
  });
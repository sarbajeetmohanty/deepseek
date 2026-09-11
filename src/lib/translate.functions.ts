import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  normalizeOptionsInText,
  normalizeAnswerInText,
  protectOptionsForTranslation,
  splitHorizontalOptions,
} from "./normalize-options";

// Robust Google Translate endpoint using HTTP POST with retry and fallback to GET.
// Eliminates URL query length limits (preventing HTTP 400 Bad Request on large texts).
export async function gtranslate(text: string, source: string, target: string): Promise<string> {
  if (!text || !text.trim()) return text;

  // Split very long texts into chunks (<= 3500 chars) preserving double newlines
  if (text.length > 3500) {
    const paragraphs = text.split("\n\n");
    const chunks: string[] = [];
    let current = "";
    for (const p of paragraphs) {
      if (current.length + p.length + 2 > 3500 && current.length > 0) {
        chunks.push(current);
        current = p;
      } else {
        current = current ? `${current}\n\n${p}` : p;
      }
    }
    if (current) chunks.push(current);
    if (chunks.length > 1) {
      const translatedChunks = await Promise.all(
        chunks.map((chunk) => gtranslateChunk(chunk, source, target))
      );
      return translatedChunks.join("\n\n");
    }
  }

  return gtranslateChunk(text, source, target);
}

async function gtranslateChunk(text: string, source: string, target: string): Promise<string> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20_000);
    try {
      // 1. Try HTTP POST first (no URL query length limits)
      const postRes = await fetch(
        `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${source}&tl=${target}&dt=t`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
          body: new URLSearchParams({ q: text }),
          signal: ctl.signal,
        }
      );
      if (postRes.ok) {
        const json = (await postRes.json()) as unknown;
        if (Array.isArray(json) && Array.isArray(json[0])) {
          return (json[0] as unknown[])
            .map((seg) => (Array.isArray(seg) && typeof seg[0] === "string" ? (seg[0] as string) : ""))
            .join("");
        }
      }

      // 2. Fallback to GET if POST returned an unexpected status
      const getUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${source}&tl=${target}&dt=t&q=${encodeURIComponent(text)}`;
      const getRes = await fetch(getUrl, { signal: ctl.signal });
      if (getRes.ok) {
        const json = (await getRes.json()) as unknown;
        if (Array.isArray(json) && Array.isArray(json[0])) {
          return (json[0] as unknown[])
            .map((seg) => (Array.isArray(seg) && typeof seg[0] === "string" ? (seg[0] as string) : ""))
            .join("");
        }
      }

      throw new Error(`Google Translate POST failed (${postRes.status}), GET failed (${getRes.status})`);
    } catch (e) {
      if (attempt === MAX_ATTEMPTS) {
        console.error(`Google Translate exhausted ${MAX_ATTEMPTS} attempts for chunk:`, e);
        return text;
      }
      await new Promise((r) => setTimeout(r, 400 * Math.pow(1.5, attempt) + Math.random() * 200));
    } finally {
      clearTimeout(timer);
    }
  }
  return text;
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

  // Remove dots/commas from sub-statements (e.g. "1. Text" -> "1 Text")
  s = s.replace(/(?<=\n)\s*(?:\(([1-9]|10)\)|([1-9]|10))\s*[.,):\-–—]?\s+(?=\S)/g, (m, g1, g2) => `${g2 || g1.replace(/[\(\)]/g, "")} `);

  // Strictly enforce Column B numbers with NO dot (e.g., "1 Item", "2 Item")
  const colBMatch = s.match(/(Column\s*B:[\s\S]*)/i);
  if (colBMatch) {
    const colBPart = colBMatch[1];
    const cleanedColB = colBPart.replace(/(?:^|\n)\s*([1-5])\s*[.,):\-–—]\s*(?=\S)/g, "\n$1 ");
    s = s.slice(0, colBMatch.index) + cleanedColB;
  }

  s = splitHorizontalOptions(s);
  s = s.replace(/(?<=\S)\s+(?=(?:Answer|Ans)\s*[:.-])/gi, "\n");
  s = s.replace(/^((?:[A-Ha-h]\.)|(?:\([a-h1-8]\)))\s*\n\s*/gm, "$1 ");

  // Normalize step labels emitted by translation ("Step 1:", "चरण 1:", etc.) to "1 "
  s = s.replace(/(?:^|\n)\s*(?:Step|Chran|Pad|चरण|पद)\s*(\d+)\s*[:.\-)]\s*/gi, "\n$1 ");
  // Break inline numbered steps onto their own line ("... .  2. ..." -> newline, never splitting decimals)
  s = s.replace(/((?<!\d)\.\s+)(?=\d{1,2}\s+[^\s\d])/g, ".\n");
  // Clean dots after step numbers in Solution
  const solMatch = s.match(/(Solution:[\s\S]*)/i);
  if (solMatch) {
    let solText = solMatch[1];
    solText = solText.replace(/^([ \t]*)(?:\((\d+)\)|(\d+))\s*[.,):\-–—]?\s+/gm, (m, indent, g1, g2) => `${indent}${g2 || g1} `);
    s = s.slice(0, solMatch.index) + solText;
  }
  // Some translations rewrite bullets — restore leading "* " for lines that start with a bullet char.
  s = s.replace(/^\s*[•·●○◦]\s+/gm, "* ");

  s = normalizeAnswerInText(s);
  s = normalizeOptionsInText(s);

  // Guarantee the question begins with canonical idx. prefix
  if (!/^\s*\d{1,4}\.\s+/.test(s)) {
    s = s.replace(/^\s*\d{1,4}[.:\-)\]\s]+/, `${idx}. `);
  }

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
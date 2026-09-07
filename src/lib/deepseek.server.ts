// Server-only DeepSeek client used to format a single MCQ.
import { latexToText } from "./latex-to-text";
import {
  normalizeOptionsInText,
  normalizeAnswerInText,
  protectOptionsForTranslation,
} from "./normalize-options";

// LANGUAGE RULE: Original language for question/options; Hindi for solution; English for labels.
export const LANG_RULE = `\nLANGUAGE RULE (STRICT):
- Question text and options MUST remain in their original language.
- Solution steps MUST always be in pure Hindi (preserve digits 0-9, math symbols).
- "Answer:" and "Solution:" labels MUST be English.`;

export const PROMPT_GK = `Expert competitive-exam MCQ solver. Output clean plain text ONLY (no markdown, no blank lines, no greetings):

<number>. <Question text in clean Unicode - no LaTeX/$. Superscripts ²,³, fractions (a)/(b), √x>
[If statements: 1 <text> ... 2 <text> ... on separate lines]
[If code header: 'कूट :' or 'Code:' on separate line]
[If Match Column: You MUST output two separate lists: "Column A:" followed by items (a., b., c., d.), and "Column B:" followed by items (1., 2., 3., 4.). NEVER put Column B items on the same line as Column A (do NOT use '-' or '|' between columns).]
A. <option 1>
B. <option 2>
C. <option 3>
D. <option 4>

Answer: <matching option label>
Solution:
1 <direct key fact / reason for correct answer>
2 <additional context / elimination of other options>

Rules:
1. 100% accurate facts. Solve and match options.
2. Clean Unicode formulas (², ³, √x, θ, α, π).
3. ALWAYS prefix the options exactly with A., B., C., D. on separate lines (never use Hindi letters like क, ख, ग, घ, उ or Roman numerals for options).
4. Sub-statements must have a space after their number (e.g., "1 <text>").
5. Output ONLY the required format above.`;

export const PROMPT_MATH = `Expert Math MCQ solver. Output clean plain text ONLY (no markdown, no greetings):

<number>. <Question in clean Unicode - no LaTeX/$, superscripts ², ³, fractions (a)/(b), √x>
A. <option 1>
B. <option 2>
C. <option 3>
D. <option 4>

Answer: <matching option label>
Solution:
- <step 1 - given / formula>
- <step 2 - calculation>
- <final step - final answer>

Rules:
1. 100% accurate math. Solve first, then match options.
2. Clean Unicode formulas (², ³, √x).
3. ALWAYS prefix the options exactly with A., B., C., D. on separate lines (never use Hindi letters like क, ख, ग, घ, उ or Roman numerals for options).
4. Sub-statements must have a space after their number (e.g., "1 <text>").
5. Output ONLY the required format above.`;

export const GK_LENGTH_NORMAL = `\nSolution Rule: The solution MUST contain 8 to 10 detailed points in pure Hindi, numbered "1 ", "2 " (never paragraph). Keep points informative, direct, and factual.`;
export const GK_LENGTH_LONG = `\nSolution Rule: The solution MUST contain 8 to 10 detailed points in pure Hindi, numbered "1 ", "2 " covering comprehensive background and related facts.`;

export const MATH_LENGTH_NORMAL = `\nSolution Rule: Dash-bulleted steps starting with "- " in pure Hindi. Complete calculation steps.`;
export const MATH_LENGTH_LONG = `\nSolution Rule: Dash-bulleted steps starting with "- " in pure Hindi. Detailed step-by-step calculation.`;

export const LENGTH_NORMAL = MATH_LENGTH_NORMAL;
export const LENGTH_LONG = MATH_LENGTH_LONG;

// English prompt templates: Processing in English cuts token consumption by 60-70% compared to Hindi Devanagari,
// allowing the full 8-10 points detailed solution to be generated at minimum token cost.
export const PROMPT_GK_EN = `Expert competitive-exam MCQ solver. Output clean plain text ONLY in English (no markdown, no blank lines, no greetings):

<number>. <Question text in clean Unicode - no LaTeX/$. Superscripts ²,³, fractions (a)/(b), √x>
[If statements: 1 <text> ... 2 <text> ... on separate lines]
[If code header: 'Code:' on separate line]
[If Match Column: You MUST output two separate lists: "Column A:" followed by items (a., b., c., d.), and "Column B:" followed by items (1., 2., 3., 4.). NEVER put Column B items on the same line as Column A.]
A. <option 1>
B. <option 2>
C. <option 3>
D. <option 4>

Answer: <matching option label>
Solution:
1 <point 1>
2 <point 2>
3 <point 3>
4 <point 4>
5 <point 5>
6 <point 6>
7 <point 7>
8 <point 8>

Rules:
1. 100% accurate facts. Solve and match options.
2. Clean Unicode formulas (², ³, √x, θ, α, π).
3. ALWAYS prefix the options exactly with A., B., C., D. on separate lines (never use Hindi letters or Roman numerals for options).
4. Sub-statements must have a space after their number (e.g., "1 <text>").
5. The solution MUST contain 8 to 10 detailed points in English, numbered "1 ", "2 " (never paragraph). Keep points informative, direct, and factual.
6. Output ONLY the required format above.`;

export const PROMPT_MATH_EN = `Expert Math MCQ solver. Output clean plain text ONLY in English (no markdown, no greetings):

<number>. <Question in clean Unicode - no LaTeX/$, superscripts ², ³, fractions (a)/(b), √x>
A. <option 1>
B. <option 2>
C. <option 3>
D. <option 4>

Answer: <matching option label>
Solution:
- <step 1 - given / formula>
- <step 2 - calculation>
- <final step - final answer>

Rules:
1. 100% accurate math. Solve first, then match options.
2. Clean Unicode formulas (², ³, √x).
3. ALWAYS prefix the options exactly with A., B., C., D. on separate lines (never use Hindi letters or Roman numerals for options).
4. Sub-statements must have a space after their number (e.g., "1 <text>").
5. Solution MUST be dash-bulleted steps starting with "- " in English. Complete step-by-step calculation.
6. Output ONLY the required format above.`;

export interface DeepSeekOptions {
  raw: string;
  idx: number;
  signal?: AbortSignal;
  subjectType?: "gk_english" | "math";
  solutionLength?: "normal" | "long";
}

// Post-process AI output so it matches the strict target format even if the
// model slips in markdown, wrong numbering, or squashed lines.
export function sanitizeAiOutput(text: string, idx: number, subjectType?: "gk_english" | "math"): string {
  let s = text;
  // Clean up OCR spacing glitches in labels and options (e.g., "A nswer:" -> "Answer:", "A . " -> "A. ")
  s = s.replace(/\bA\s+nswer:/gi, "Answer:");
  s = s.replace(/\bS\s+olution:/gi, "Solution:");
  s = s.replace(/(?<![A-Za-z0-9])([A-Ha-h])\s+\./g, "$1.");
  s = normalizeAnswerInText(s);

  // Strip markdown bold/italics that the model sometimes emits despite the prompt.
  s = s.replace(/\*\*(.+?)\*\*/g, "$1");
  s = s.replace(/__(.+?)__/g, "$1");
  // Normalize line endings.
  s = s.replace(/\r\n?/g, "\n");
  // Re-insert breaks before canonical anchors (Answer:, Solution:) in case they got 
  // glued to previous text or have messy leading whitespace.
  s = s.replace(/(?<=\S)[^\S\r\n]*(?=Answer:)/gi, "\n\n");
  s = s.replace(/(?<=\S)[^\S\r\n]*(?=Solution:)/gi, "\n\n");
  s = s.replace(/^(Answer:.*)$/gim, "\n$1");
  s = s.replace(/^(Solution:.*)$/gim, "\n$1");

  // Reunite orphaned numbers that are on a line by themselves: "1\nText..." -> "1 Text..."
  s = s.replace(/(?:^|\n)\s*(\((?:[1-9]|10|i{1,3}|iv|v)\)|[1-9]|10)[.)]?\s*\n\s*(?=\S)/g, "\n$1 ");

  // Break inline numbered statements inside question body before options
  s = s.replace(/([:：])\s*(?=(?:[1-9]|10|\((?:[1-9]|10|i{1,3}|iv|v)\))[.)]?\s+)/g, "$1\n");
  s = s.replace(/([।\.\?!;]\s*)(?=(?:[2-9]|10|\((?:[2-9]|10|i{1,3}|iv|v)\))[.)]?\s+)/g, "$1\n");
  s = s.replace(/([।\.\?!;]\s*)(?=(?:उपर्युक्त|उपरोक्त|इनमें|निम्न|Which of the|Of the above)[^\n]*[\?？:])/gi, "$1\n");

  // Fix column headers glued to the end of a line or to their first item
  s = s.replace(/(?<=\S)[^\S\r\n]+((?:Column|कॉलम|स्तंभ|List|सूची|[?¿\uFFFD]+)[\s\-]*\(?(?:A|B|I{1,3}|1|2)\)?(?:\([^\)\n]+\))?(?:[\s.:\-]+(?=\(?[a-zA-Z1-9]\)?[\s.)])|[\s.:\-]*$))/gim, "\n$1");
  s = s.replace(/^((?:Column|कॉलम|स्तंभ|List|सूची|[?¿\uFFFD]+)[\s\-]*\(?(?:A|B|I{1,3}|1|2)\)?(?:\([^\)\n]+\))?[\s.:\-]*)[^\S\r\n]+(?=\(?[a-zA-Z1-9]\)?[\s.)])/gim, "$1\n");

  // Fix dash/hyphen/colon separated match-the-column items on the same line (e.g. "a Item - 1 Item")
  const dashSplitRegex = /\s*(?:[-–—:;]|\t+)\s*(?=\(?(?:[1-9]|10|[a-hA-H]|i{1,3}|iv|v)\)?[.)]?\s+)/i;
  const leftItemRegex = /^\s*(?:[a-hA-H][.)]?|\([a-hA-H]\)|[ivxIVX]{1,4}[.)]?|\([ivxIVX]{1,4}\))\s+/i;
  const linesArr = s.split("\n");
  for (let i = 0; i < linesArr.length; i++) {
    const line = linesArr[i].trim();
    if (!/^\s*(?:Answer|Ans|उत्तर|Solution|Sol|हल|समाधान|Code|Codes|कूट|कोड)/i.test(line)) {
      const parts = line.split(dashSplitRegex);
      if (parts.length >= 2 && leftItemRegex.test(parts[0])) {
        let startIndex = i;
        while (startIndex > 0) {
          const prev = linesArr[startIndex - 1].trim();
          if (/^\s*(?:Column|कॉलम|स्तंभ|List|सूची|[?¿\uFFFD]+)[\s\-]*\(?(?:A|I|1)\)?[:.\-]?/i.test(prev)) {
            startIndex--;
            break;
          }
          if (prev === "" || /^\s*(?:Column|कॉलम|स्तंभ|List|सूची|[?¿\uFFFD]+)[\s\-]*\(?(?:B|II|2)\)?[:.\-]?/i.test(prev)) {
            startIndex--;
            continue;
          }
          break;
        }

        let j = i;
        const colAItems: string[] = [];
        const colBItems: string[] = [];
        while (j < linesArr.length) {
          const curr = linesArr[j].trim();
          if (/^\s*(?:उत्तर\s*|सही\s*)?(?:कूट|कोड|Code|Codes)\s*[:.\-]?/i.test(curr) || /^\s*(?:Answer|Ans|उत्तर|Solution|Sol|हल|समाधान)[:.\-]/i.test(curr)) {
            break;
          }
          if (/^\s*(?:Column|कॉलम|स्तंभ|List|सूची|[?¿\uFFFD]+)[\s\-]*\(?(?:B|II|2)\)?/i.test(curr)) {
            j++;
            continue;
          }
          const p = curr.split(dashSplitRegex);
          if (p.length >= 2 && leftItemRegex.test(p[0])) {
            colAItems.push(p[0].trim());
            colBItems.push(p.slice(1).join(" - ").trim());
          } else if (p.length === 1 && p[0] === "") {
            j++;
            continue;
          } else {
            break;
          }
          j++;
        }

        if (colAItems.length > 0) {
          const precedingText = linesArr.slice(0, startIndex).join(" ");
          const m1 = precedingText.match(/((?:सूची|कॉलम|स्तंभ|List|Column)[\s\-]*(?:I|A|1)(?:\s*\([^\)\n]+\))?)/i);
          const m2 = precedingText.match(/((?:सूची|कॉलम|स्तंभ|List|Column)[\s\-]*(?:II|B|2)(?:\s*\([^\)\n]+\))?)/i);
          const headerA = m1 ? `${m1[1]}:` : "Column A:";
          const headerB = m2 ? `${m2[1]}:` : "Column B:";

          const replacement = [headerA, ...colAItems, headerB, ...colBItems];
          linesArr.splice(startIndex, j - startIndex, ...replacement);
          i = startIndex + replacement.length - 1;
        }
      }
    }
  }
  s = linesArr.join("\n");

  // Fix "कूट :" / "Code:" glued to previous text or to options
  s = s.replace(/(?<=\S)[^\S\r\n]+((?:उत्तर\s*|सही\s*)?(?:कूट|कोड|Code|Codes)\s*(?::|:-|[-–—]|(?=\s*(?:[A-Ha-h]\.|\([a-hA-H1-8]\)|[A-Ha-h]\)))))/gim, "\n$1");
  s = s.replace(/^((?:उत्तर\s*|सही\s*)?(?:कूट|कोड|Code|Codes)\s*[:.\-]*)[^\S\r\n]+(?=(?:[A-Ha-h]\.|\([a-hA-H1-8]\)|[A-Ha-h]\)))/gim, "$1\n");

  // Only add space after option label if at line start or after 2+ spaces, and NOT followed by an abbreviation like B.C., A.D., C.E.
  s = s.replace(/(?:^|[^\S\r\n]{2,})([A-Ha-h]\.)(?!\s*[A-Za-z]\.)([^\s.])/gm, (m, g1, g2) => {
    return m.slice(0, m.length - g1.length - g2.length) + g1 + " " + g2;
  });
  s = s.replace(/(?<![A-Za-z0-9])(\([a-hA-H1-8]\)|[A-Ha-h]\))(?=[^\s:.\-])/g, "$1 ");

  // Add missing space after sub-statement number if stuck directly to content (e.g. "1वैगनर" -> "1 वैगनर")
  s = s.replace(/^([1-9]|10)(?=[^\s\d.\)])/gm, "$1 ");

  // Remove dots from sub-statement numbers (e.g., "1. वैगनर" -> "1 वैगनर"), skipping the first line (question number)
  s = s.replace(/(?<=\n)\s*([1-9]|10)\.\s+/g, "$1 ");

  // Also split sub-statements like (1), (2), (3), (4) or (i), (ii), (iii), (iv) if on same line
  s = s.replace(/(?<=\S)[^\S\r\n]{2,}(?=\((?:[1-9]|10|i{1,3}|iv|v|vi)\)\s+)/gi, "\n");

  // Split options (A-H) if they were output on the same line horizontally (require 2+ spaces, with negative lookahead to never split abbreviations like B.C., A.D., C.E.).
  s = s.replace(/(?<!Answer:)(?<=\S)[^\S\r\n]{2,}(?=[A-Ha-h][.)](?!\s*[A-Za-z]\.)(?:\s+|$))/g, "\n");
  // For bracketed options like (a) or (1), require at least 2 spaces to avoid splitting normal text like "केवल (1) और (2)".
  s = s.replace(/(?<!Answer:)(?<=\S)[^\S\r\n]{2,}(?=(?:[A-Ha-h1-8]\.|\([a-hA-H1-8]\))(?:\s+|$))/g, "\n");

  // Fix detached options (e.g. "A.\n4:9" -> "A. 4:9" or "(1)\nValue" -> "(1) Value")
  s = s.replace(/^((?:[A-Ha-h]\.)|(?:\([a-h1-8]\)))\s*\n\s*/gm, "$1 ");

  // Normalize options to canonical A., B., C., D. format (never Hindi letters like उ., ख., क., etc.)
  s = normalizeOptionsInText(s);

  // Normalize "Step 1:" / "चरण 1:" inside Solution to new line
  s = s.replace(/(?<=\S)[^\S\r\n]+(?=(?:Step|चरण|पद)\s*\d+\s*[:.\-)])/gi, "\n");
  s = s.replace(/(?:^|\n)\s*(?:Step|चरण|पद)\s*(\d+)\s*[:.\-)]\s*/g, "\n$1 ");

  // Split inline numbered solution steps e.g. "Solution: 1 Point A 2 Point B" and clean step dots in Solution
  const solMatch = s.match(/(Solution:[\s\S]*)/i);
  if (solMatch) {
    let solText = solMatch[1];
    solText = solText.replace(/^(Solution:\s*)(?=[1-9]\s+|-\s+)/i, "Solution:\n");
    solText = solText.replace(/(?<=\S)[^\S\r\n]{2,}(?=(?:[1-9]|10)\s+)/g, "\n");
    solText = solText.replace(/^([ \t]*\d+)\.\s+/gm, "$1 ");
    s = s.slice(0, solMatch.index) + solText;
  }

  // Force the main question number to the caller-supplied idx with a dot,
  // matching the first occurrence of a number at the top, or prepending if missing.
  const prefixRegex = /^\s*(?:#+\s*)?(?:(?:[Qq]\.?(?:uestion|ue|ues)?|Problem|Prob|MCQ|Item|Task|Case)(?:[ \t]*(?:No|Num|Number|#)\.?)?|प्रश्न(?:[ \t]*(?:संख्या|सं\.?|क्र\.?|क्रमांक))?|प्र\.?[ \t]*(?:संख्या|सं\.?|क्र\.?|क्रमांक)?|सवाल(?:[ \t]*(?:संख्या|सं\.?|क्र\.?|क्रमांक))?|क्र\.?[ \t]*(?:सं\.?|संख्या)?|[?¿\uFFFD]+)?[ \t]*[:.-]?[ \t]*\d{1,4}[.:\-)\]\s]+/i;
  if (!prefixRegex.test(s)) {
    s = `${idx}. ` + s.trim();
  } else {
    s = s.replace(prefixRegex, `${idx}. `);
  }

  // For math, convert numbered solution steps into dash bullets so they
  // render as red "- " markers instead of "1. 2. 3.".
  if (subjectType === "math") {
    const lines = s.split("\n");
    let inSol = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^Solution:/i.test(line)) { inSol = true; continue; }
      if (!inSol) continue;
      if (/^Answer:/i.test(line)) { inSol = false; continue; }
      // Convert "1. text" or "1) text" or "1 text" step lines to "- text"; keep bullets "* ..." untouched.
      const m = line.match(/^\s*\d{1,2}[.)]?\s+(.*)$/);
      if (m) lines[i] = `- ${m[1]}`;
    }
    s = lines.join("\n");
  }
  // Collapse 3+ blank lines.
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

export class DeepSeekProviderError extends Error {
  status: number;
  providerCode?: string;
  nonRetryable: boolean;

  constructor(message: string, options: { status: number; providerCode?: string; nonRetryable?: boolean }) {
    super(message);
    this.name = "DeepSeekProviderError";
    this.status = options.status;
    this.providerCode = options.providerCode;
    this.nonRetryable = options.nonRetryable ?? false;
  }
}

export function isNonRetryableDeepSeekError(error: unknown): boolean {
  return error instanceof DeepSeekProviderError && error.nonRetryable;
}

function parseDeepSeekError(status: number, text: string): DeepSeekProviderError {
  let providerMessage = text;
  let providerCode: string | undefined;

  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; code?: string; type?: string } };
    providerMessage = parsed.error?.message || text;
    providerCode = parsed.error?.code || parsed.error?.type;
  } catch {
    // Keep the raw text when DeepSeek returns a non-JSON body.
  }

  const lowerMessage = providerMessage.toLowerCase();
  if (status === 402 || lowerMessage.includes("insufficient balance")) {
    return new DeepSeekProviderError(
      "DeepSeek account balance is exhausted. Add funds to DeepSeek or save a funded API key, then retry this batch.",
      { status, providerCode, nonRetryable: true },
    );
  }

  if (status === 401 || status === 403) {
    return new DeepSeekProviderError(
      "DeepSeek API key was rejected. Save a valid DeepSeek API key, then retry this batch.",
      { status, providerCode, nonRetryable: true },
    );
  }

  return new DeepSeekProviderError(`DeepSeek ${status}: ${providerMessage.slice(0, 220)}`, {
    status,
    providerCode,
    nonRetryable: false,
  });
}

// DeepSeek API Configuration
// - Model: deepseek-chat (DeepSeek-V3) is the cheapest and fastest flagship model ($0.14/1M input, $0.014 on cache hit, $0.28/1M output).
// - DeepSeek Context Caching: By keeping the system prompt static and user prompt structure standardized, prompt tokens achieve a 90% discount on cache hits.
const DEEPSEEK_MODEL = "deepseek-chat";
const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";

export async function formatQuestionWithDeepSeek({ raw, idx, signal, subjectType, solutionLength }: DeepSeekOptions): Promise<string> {
  // Prefer the admin-managed key from app_settings; falls back to the env
  // secret. Cached in-memory (60s) so this is not a DB round-trip per call.
  const { getDeepseekApiKey } = await import("./settings.functions");
  const { gtranslate, normalizeTranslated } = await import("./translate.functions");
  const apiKey = await getDeepseekApiKey();

  let cleaned: string;
  try {
    cleaned = latexToText(raw);
  } catch {
    cleaned = raw;
  }
  if (!cleaned.trim()) throw new Error("Empty question text");

  // Free English translation pipeline:
  // If the input question contains Hindi, convert it to English for FREE via Google Translate (0 AI cost).
  // DeepSeek solves in English (English tokens are 3-4x cheaper than Hindi Devanagari tokens),
  // generating the full 8-10 points detailed solution without token bloat, then converts back to pure Hindi for free.
  const hasHindi = /[\u0900-\u097F]/.test(cleaned);
  let promptText = cleaned;
  let translatedToEnglish = false;

  if (hasHindi) {
    try {
      const enQ = await gtranslate(cleaned, "auto", "en");
      if (enQ && enQ.trim().length > 0) {
        promptText = enQ.trim();
        translatedToEnglish = true;
      }
    } catch (e) {
      console.warn(`[DeepSeek] Free translation to English failed for Q${idx}, falling back to original language`, e);
      translatedToEnglish = false;
    }
  }

  // Keep system prompt static and clean to maximize DeepSeek Context / Prompt Caching hits across batch calls
  const basePrompt = translatedToEnglish
    ? (subjectType === "math" ? PROMPT_MATH_EN : PROMPT_GK_EN)
    : (subjectType === "math" ? PROMPT_MATH : PROMPT_GK);
  const lengthRule = translatedToEnglish
    ? ""
    : (subjectType === "math"
      ? (solutionLength === "long" ? MATH_LENGTH_LONG : MATH_LENGTH_NORMAL)
      : (solutionLength === "long" ? GK_LENGTH_LONG : GK_LENGTH_NORMAL));
  const systemPrompt = translatedToEnglish
    ? basePrompt
    : basePrompt + LANG_RULE + lengthRule;

  // Max tokens: English generation requires ~300-450 tokens for 8-10 full points, leaving ample headroom
  const maxTokens = subjectType === "math" ? 850 : 800;

  // Standardized user prompt structure for optimal prompt prefix caching
  const userPrompt = `Solve and format the following MCQ:\n\n${promptText}\n\nReminder: Output strictly in the required format. Question must begin with "${idx}."`;

  const attempt = async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 45_000);
    const onCallerAbort = () => ctl.abort();
    if (signal) {
      if (signal.aborted) ctl.abort();
      else signal.addEventListener("abort", onCallerAbort, { once: true });
    }
    try {
      const res = await fetch(DEEPSEEK_API_URL, {
        method: "POST",
        signal: ctl.signal,
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Connection": "keep-alive",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: DEEPSEEK_MODEL,
          temperature: 0,
          top_p: 0.1,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw parseDeepSeekError(res.status, errText);
      }

      const json = (await res.json().catch(() => null)) as {
        choices?: { message?: { content?: string } }[];
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          prompt_cache_hit_tokens?: number;
          prompt_cache_miss_tokens?: number;
          prompt_tokens_details?: {
            cached_tokens?: number;
          };
        };
      } | null;

      if (json?.usage) {
        const hit = json.usage.prompt_cache_hit_tokens ?? json.usage.prompt_tokens_details?.cached_tokens ?? 0;
        const miss = json.usage.prompt_cache_miss_tokens ?? Math.max(0, (json.usage.prompt_tokens ?? 0) - hit);
        const out = json.usage.completion_tokens ?? 0;
        console.log(`[DeepSeek API] Q${idx} Tokens | Cache Hit: ${hit} (@$0.014/1M) | Miss: ${miss} (@$0.14/1M) | Output: ${out} (@$0.28/1M)`);
      }

      let content = json?.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error("Empty DeepSeek response");

      // If we processed in English, convert the output back to Hindi for FREE via Google Translate (0 AI cost)
      if (translatedToEnglish) {
        try {
          const protectedContent = protectOptionsForTranslation(content);
          const hiOut = await gtranslate(protectedContent, "en", "hi");
          if (hiOut && hiOut.trim().length > 0) {
            content = normalizeTranslated(hiOut, idx);
          }
        } catch (e) {
          console.warn(`[DeepSeek] Free translation to Hindi failed for Q${idx}, keeping English output`, e);
        }
      }

      return content;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onCallerAbort);
    }
  };

  let lastErr: unknown;
  const MAX_RETRIES = 3;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const content = await attempt();
      try {
        return sanitizeAiOutput(latexToText(content), idx, subjectType);
      } catch {
        return sanitizeAiOutput(content, idx, subjectType);
      }
    } catch (e) {
      lastErr = e;
      if (isNonRetryableDeepSeekError(e)) throw e;
      if (e instanceof Error && e.name === "AbortError" && signal?.aborted) throw e;
      if (i < MAX_RETRIES - 1) {
        // Apply exponential backoff with jitter for Rate Limits (429) or transient errors
        const isRateLimit = e instanceof DeepSeekProviderError && e.status === 429;
        const baseDelay = isRateLimit ? 3000 : 800;
        const backoff = Math.pow(1.8, i) * baseDelay + Math.random() * 400;
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
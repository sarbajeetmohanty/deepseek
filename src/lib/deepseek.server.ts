// Server-only DeepSeek client used to format a single MCQ.
import { latexToText } from "./latex-to-text";

// LANGUAGE RULE: Original language for question/options; Hindi for solution; English for labels.
export const LANG_RULE = `\nLANGUAGE RULE (STRICT):
- Question text and options MUST remain in their original language.
- Solution steps MUST always be in pure Hindi (preserve digits 0-9, math symbols).
- "Answer:" and "Solution:" labels MUST be English.`;

export const PROMPT_GK = `Expert competitive-exam MCQ solver. Output clean plain text ONLY (no markdown, no blank lines, no greetings):

<number>. <Question text in clean Unicode - no LaTeX/$. Superscripts ²,³, fractions (a)/(b), √x>
[If statements: 1 <text> ... 2 <text> ... on separate lines]
[If code header: 'कूट :' or 'Code:' on separate line]
[If Match Column: Column A: 1. ... 2. ... Column B: a. ... b. ...]
A. <option 1>
B. <option 2>
C. <option 3>
D. <option 4>

Answer: <matching option label>
Solution:
1 <fact/point 1>
2 <fact/point 2>
3 <fact/point 3>
4 <fact/point 4>
5 <fact/point 5>
6 <fact/point 6>
7 <fact/point 7>
8 <fact/point 8>

Rules:
1. 100% accurate facts. Solve and match options.
2. Clean Unicode formulas (², ³, √x, θ, α, π).
3. ALWAYS prefix the options exactly with A., B., C., D. on separate lines (add them if missing from input).
4. Sub-statements must have a space after their number (e.g., "1 <text>").
5. Solution MUST be exactly 8 to 10 points in pure Hindi, numbered "1 ", "2 " (never paragraph).
6. Output ONLY the required format above.`;

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
3. ALWAYS prefix the options exactly with A., B., C., D. on separate lines (add them if missing from input).
4. Sub-statements must have a space after their number (e.g., "1 <text>").
5. Solution MUST be dash-bulleted steps starting with "- " in pure Hindi. Maximum 10 steps.
6. Output ONLY the required format above.`;

export const LENGTH_NORMAL = `\nSolution length: 2-4 short steps.`;
export const LENGTH_LONG = `\nSolution length: 5-10 detailed steps.`;

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

  // Fix column headers glued to the end of a line or to their first item
  s = s.replace(/(?<=\S)[^\S\r\n]+((?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*(?:A|B|I{1,3}|1|2)(?:[\s.:\-]+(?=\(?[a-zA-Z1-9]\)?[\s.)])|[\s.:\-]*$))/gim, "\n$1");
  s = s.replace(/^((?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*(?:A|B|I{1,3}|1|2)[\s.:\-]*)[^\S\r\n]+(?=\(?[a-zA-Z1-9]\)?[\s.)])/gim, "$1\n");

  // Fix "कूट :" / "Code:" glued to previous text or to options
  s = s.replace(/(?<=\S)[^\S\r\n]+((?:उत्तर\s*)?(?:कूट|कोड|Code|Codes)\s*(?::|:-|[-–—]|(?=\s*(?:[A-Ha-h]\.|\([a-hA-H1-8]\)|[A-Ha-h]\)))))/gim, "\n$1");
  s = s.replace(/^((?:उत्तर\s*)?(?:कूट|कोड|Code|Codes)\s*[:.\-]*)[^\S\r\n]+(?=(?:[A-Ha-h]\.|\([a-hA-H1-8]\)|[A-Ha-h]\)))/gim, "$1\n");

  // Add missing space after option label if stuck directly to content (e.g. "A.2, 3" -> "A. 2, 3", "(a)Delhi" -> "(a) Delhi")
  s = s.replace(/(?<![A-Za-z0-9])([A-Ha-h]\.)(?=\S)/g, "$1 ");
  s = s.replace(/(?<![A-Za-z0-9])(\([a-hA-H1-8]\)|[A-Ha-h]\))(?=\S)/g, "$1 ");

  // Add missing space after sub-statement number if stuck directly to content (e.g. "1वैगनर" -> "1 वैगनर")
  s = s.replace(/^([1-9]|10)(?=[^\s\d.\)])/gm, "$1 ");

  // Also split sub-statements like (1), (2), (3), (4) or (i), (ii), (iii), (iv) if on same line
  s = s.replace(/(?<=\S)[^\S\r\n]{2,}(?=\((?:[1-9]|10|i{1,3}|iv|v|vi)\)\s+)/gi, "\n");

  // Split options (A-H, (a)-(h), etc.) if they were output on the same line horizontally.
  s = s.replace(/(?<!Answer:)(?<=\S)[^\S\r\n]+(?=(?:[A-Ha-h][.)]|\([a-hA-H1-8]\))(?:\s+|$))/g, "\n");

  // Fix detached options (e.g. "A.\n4:9" -> "A. 4:9" or "(1)\nValue" -> "(1) Value")
  s = s.replace(/^((?:[A-Ha-h]\.)|(?:\([a-h1-8]\)))\s*\n\s*/gm, "$1 ");

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
  // matching the first occurrence of a number at the top of the string.
  s = s.replace(/^\s*(?:#+\s*)?(?:(?:[Qq](?:uestion)?|प्रश्न|प्र\.?)[ \t]*[.-]?[ \t]*)?\d{1,4}[.:\-)\]\s]+\s*/i, `${idx}. `);

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
  const apiKey = await getDeepseekApiKey();

  let cleaned: string;
  try {
    cleaned = latexToText(raw);
  } catch {
    cleaned = raw;
  }
  if (!cleaned.trim()) throw new Error("Empty question text");

  // Keep system prompt static and clean to maximize DeepSeek Context / Prompt Caching hits across batch calls
  const basePrompt = subjectType === "math" ? PROMPT_MATH : PROMPT_GK;
  const lengthRule = subjectType === "math" ? (solutionLength === "long" ? LENGTH_LONG : LENGTH_NORMAL) : "";
  const systemPrompt = basePrompt + LANG_RULE + lengthRule;

  // Optimized max tokens: solutions are strictly concise points (GK: 8-10 points, Math: 2-10 steps),
  // preventing runaway token generation and keeping costs at the absolute minimum.
  const maxTokens = subjectType === "math"
    ? (solutionLength === "long" ? 1000 : 600)
    : 1000;

  // Standardized user prompt structure for optimal prompt prefix caching
  const userPrompt = `Solve and format the following MCQ:\n\n${cleaned}\n\nReminder: Output strictly in the required format. Question must begin with "${idx}."`;

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

      const json = (await res.json().catch(() => null)) as
        | { choices?: { message?: { content?: string } }[] }
        | null;
      const content = json?.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error("Empty DeepSeek response");
      return content;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onCallerAbort);
    }
  };

  let lastErr: unknown;
  const MAX_RETRIES = 5;
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
        // Apply a harsher penalty for 429 Rate Limits with exponential backoff and jitter
        const isRateLimit = e instanceof DeepSeekProviderError && e.status === 429;
        const baseDelay = isRateLimit ? 4000 : 1000;
        const backoff = Math.pow(2, i) * baseDelay + Math.random() * 500;
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
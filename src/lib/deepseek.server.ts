// Server-only DeepSeek client used to format a single MCQ.
import { latexToText } from "./latex-to-text";

// LANGUAGE RULE (applies to every prompt): the AI must write the question,
// options, and solution in the SAME language as the input question. Only the
// labels "Answer:" and "Solution:" are always English. If the input mixes
// languages, use the dominant one.
const LANG_RULE = `\n\nLANGUAGE RULE (STRICT):
- Detect the language of the input question and write the ENTIRE output (question, options, solution steps, bullets) in that SAME language.
- If the question is in Hindi, write output in Hindi. If English, write in English. If any other language, use that language.
- For Hindi solutions, ensure all explanatory text is in pure Hindi, but keep digits (0-9) and mathematical symbols (+, -, =) exactly as they are.
- ONLY the labels "Answer:" and "Solution:" must always be in English.
- Do NOT translate the question. Preserve its original language exactly.`;

const PROMPT_GK = `You are an expert teacher writing SSC / competitive-exam MCQ solutions.

Output EXACTLY this format — no markdown, no extra blank lines, no greetings:

<question number>. <full question text in clean Unicode — no LaTeX, no $, no backslashes. Use ², ³ Unicode superscripts for powers. Greek letters directly: θ, α, φ, π. Fractions as (a)/(b). √x for square roots.>
For Match-the-Column questions, immediately after the question write two columns on separate lines like this —
Column A:
1. <item>
2. <item>
3. <item>
4. <item>
Column B:
a. <item>
b. <item>
c. <item>
d. <item>
Do NOT change the original matching order. Then give A/B/C/D options.
A. <option 1>
B. <option 2>
C. <option 3>
D. <option 4>

Answer: <A/B/C/D>
Solution:
1 <point 1>
2 <point 2>
3 <point 3>
4 <point 4>
5 <point 5>
6 <point 6>
7 <point 7>
8 <point 8>

Strict rules:
1. Facts must be 100% accurate. Solve the question yourself, then match against the options.
2. If the input contains LaTeX (\\cot, \\theta, ^2, \\frac …), convert it to clean Unicode. No \\ or { } in output.
3. Options must be "A. " "B. " "C. " "D. " — no brackets, dot flush.
4. Question number then ". " then question text. No extra numbering.
5. Do NOT include exam tags (SSC CGL … etc.) in the output.
6. "Answer" and "Solution" labels are always English; everything else follows the LANGUAGE RULE.
7. Keep formulas compact so MS Word copy-paste does not break.
8. Output ONLY the format above — no greeting, no explanation before or after.
9. Every solution step on its own line as "1 ", "2 ", "3 " — never a paragraph. The solution MUST contain exactly 8 to 10 detailed points covering the complete background and relevant facts.`;

const PROMPT_MATH = `You are a math teacher. Write the MCQ in MS-Word-friendly format so copy-paste never breaks numbering or spacing.

Output EXACTLY this format — no markdown, no brackets around option letters, no extra blank lines:

<question number>. <full question text — no LaTeX, no backslash, no $. Use Unicode superscript ² ³ for powers. Remove decorative () brackets. Clean Unicode for square / root.>
A. <option>
B. <option>
C. <option>
D. <option>

Answer: <A/B/C/D>
Solution:
- <step 1 — what is given / what to find>
- <step 2 — write the formula>
- <step 3 — substitute values>
- <final step — final answer>

Strict rules:
1. Math must be 100% accurate. Solve first, then match to options.
2. Every solution step starts with "- " (dash + space). NEVER use "1.", "2.", "Step 1", etc. Each step on its own line.
3. Options A. B. C. D. each on its own line, dot flush.
4. Solution ALWAYS as dash-bulleted steps (never a paragraph). Maximum 10 steps total. Each point must be very concise (normally 1 line, absolute maximum 3 lines). Each step on a new line starting with "- ".
5. Squares as ², cubes as ³ — never "^2".
6. "Answer" and "Solution" labels are always English; everything else follows the LANGUAGE RULE.
7. No decorative "()" brackets in the question; brackets only for real mathematical grouping.
8. Return the whole output in one shot — no greeting, no explanation.`;

const LENGTH_NORMAL = `\n\nSolution length: 2–4 short steps only. Keep it brief.`;
const LENGTH_LONG = `\n\nSolution length: 5–10 detailed steps maximum. First step recalls the relevant formula, then show every intermediate calculation, last step is the final answer. One step per line, never a paragraph. Each step must be concise (1 line normally, absolute maximum 3 lines).`;

export interface DeepSeekOptions {
  raw: string;
  idx: number;
  signal?: AbortSignal;
  subjectType?: "gk_english" | "math";
  solutionLength?: "normal" | "long";
}

// Post-process AI output so it matches the strict target format even if the
// model slips in markdown, wrong numbering, or squashed lines.
function sanitizeAiOutput(text: string, idx: number, subjectType?: "gk_english" | "math"): string {
  let s = text;
  // Strip markdown bold/italics that the model sometimes emits despite the prompt.
  s = s.replace(/\*\*(.+?)\*\*/g, "$1");
  s = s.replace(/__(.+?)__/g, "$1");
  // Normalize line endings.
  s = s.replace(/\r\n?/g, "\n");
  // If the whole response arrived on one line, re-insert breaks before the
  // canonical anchors (options A-D, Answer:, Solution:, bullet points).
  if (!s.includes("\n")) {
    s = s
      .replace(/\s+(?=[ABCD]\.\s)/g, "\n")
      .replace(/\s+(?=Answer:)/gi, "\n\n")
      .replace(/\s+(?=Solution:)/gi, "\n")
      .replace(/\s+(?=\*\s+महत्वपूर्ण)/g, "\n");
  }
  // Fix detached options (e.g. "A.\n4:9" -> "A. 4:9")
  s = s.replace(/^([A-D]\.)\s*\n\s*/gm, "$1 ");
  // Normalize "Step 1:" / "चरण 1:" -> "1 " on its own line inside the Solution.
  s = s.replace(/(?:^|\n)\s*(?:Step|चरण|पद)\s*(\d+)\s*[:.\-)]\s*/g, "\n$1 ");
  // Remove dots from all numbered list items at the start of any line (e.g. " 1. " -> " 1 ")
  s = s.replace(/^([ \t]*\d+)\.\s+/gm, "$1 ");
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
  const basePrompt = subjectType === "math" ? PROMPT_MATH : PROMPT_GK;
  const lengthRule = subjectType === "math" ? (solutionLength === "long" ? LENGTH_LONG : LENGTH_NORMAL) : "";
  const systemPrompt = basePrompt + LANG_RULE + lengthRule;
  const maxTokens = solutionLength === "long" || subjectType === "gk_english" ? 1800 : 1200;
  const userPrompt = `Format question number ${idx} in the required format. Original question:\n\n${cleaned}\n\nReminder: verify correctness, follow the format exactly, and write the output in the SAME language as the question above.`;

  const attempt = async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60_000);
    const onCallerAbort = () => ctl.abort();
    if (signal) {
      if (signal.aborted) ctl.abort();
      else signal.addEventListener("abort", onCallerAbort, { once: true });
    }
    try {
      const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        signal: ctl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "deepseek-chat",
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
        // Exponential backoff with jitter to optimize API usage under extreme concurrency
        const backoff = Math.pow(2, i) * 1000 + Math.random() * 500;
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
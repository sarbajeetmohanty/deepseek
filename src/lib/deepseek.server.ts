// Server-only DeepSeek solver, used as paid OVERFLOW behind the free Gemini pool.
//
// Why this exists: the Gemini free tier grants 500 requests/project/day on the
// Flash-Lite models. That is generous across 81 projects but it is a hard daily
// ceiling, and when it is reached a batch simply stops finishing. DeepSeek has no
// such ceiling, so it picks up exactly the questions the free pool could not take.
//
// Language round trip. Hindi tokenizes roughly 2-3x worse than English, and
// OUTPUT is ~91% of the DeepSeek bill, so sending Hindi straight through would
// cost about 2.6x more per question. Instead a Devanagari question is translated
// to English, solved in English, and the answer translated back to Hindi using
// the Google Translate helper the app already uses (free). Measured effect:
// ~$0.055 per 100 questions becomes ~$0.021.
import { getDeepseekApiKey } from "./settings.functions";
import { gtranslate, normalizeTranslated } from "./translate.functions";
import { protectOptionsForTranslation } from "./normalize-options";
import { latexToText } from "./latex-to-text";
import {
  sanitizeAiOutput,
  UNIFIED_SYSTEM_PROMPT_GK_NORMAL,
  UNIFIED_SYSTEM_PROMPT_GK_LONG,
  UNIFIED_SYSTEM_PROMPT_MATH_NORMAL,
  UNIFIED_SYSTEM_PROMPT_MATH_LONG,
  type QuestionSolverOptions,
  type SolveResult,
} from "./gemini.server";

// DeepSeek retired `deepseek-chat` and `deepseek-reasoner` on 2026-07-24, and
// `deepseek-v4-flash` on 2026-09-10. Two models remain; this is the cheaper one
// (DeepSeek-V4.1-Flash) and by far the right fit - the work is formatting and
// recall, not reasoning, so v4-pro would cost ~3.4x for nothing.
export const DEEPSEEK_MODEL = "deepseek-flash";

const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";

// Per-request wall clock. Measured latency is ~2.5s for English and ~5s for
// Hindi (two extra translation hops), so 60s is far beyond any healthy call and
// only ever fires on a genuinely stuck connection.
const REQUEST_TIMEOUT_MS = 60_000;

// USD per 1,000,000 tokens, peak rates. Off-peak is exactly half.
const PRICE_PEAK = { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 };

/**
 * DeepSeek peak window: 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday.
 * Everything else, including all weekend, bills at half price.
 */
export function isDeepSeekPeak(at: Date = new Date()): boolean {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = at.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

export type DeepSeekUsage = {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  costUsd: number;
};

function priceCall(u: {
  cacheHit: number;
  cacheMiss: number;
  output: number;
  peak: boolean;
}): number {
  const m = u.peak ? 1 : 0.5;
  return (
    (u.cacheHit * PRICE_PEAK.cacheHit * m +
      u.cacheMiss * PRICE_PEAK.cacheMiss * m +
      u.output * PRICE_PEAK.output * m) /
    1_000_000
  );
}

// Circuit breaker.
//
// An invalid key, an exhausted balance or a suspended account will not fix
// itself on retry, and the batch scheduler is willing to start up to 32 paid
// workers when it is behind deadline. Without this, each of those would burn a
// round trip discovering the same 401 and then fall back to Gemini anyway -
// spending the deadline budget on nothing. One such answer trips the breaker and
// the whole process stops offering DeepSeek.
let deepseekDisabledReason: string | null = null;
export function deepseekAvailable(): boolean {
  return deepseekDisabledReason === null;
}
export function deepseekDisabledBecause(): string | null {
  return deepseekDisabledReason;
}
function tripBreaker(reason: string) {
  if (deepseekDisabledReason) return;
  deepseekDisabledReason = reason;
  console.warn(`[DeepSeek] Disabled for this process: ${reason}`);
}

// Running total for this process, so spend is observable without a dashboard.
const spend = { calls: 0, costUsd: 0, promptTokens: 0, completionTokens: 0, cacheHitTokens: 0 };
export function getDeepSeekSpend() {
  return { ...spend, costUsd: +spend.costUsd.toFixed(6) };
}

// Appended to the shared system prompt for DeepSeek ONLY.
//
// Output tokens are ~91% of the DeepSeek bill, and DeepSeek is markedly more
// verbose than Gemini on the identical prompt: measured 760 output tokens per
// question against Gemini's 267, i.e. ~68 tokens per solution point versus ~21.
// That alone pushed a 100-question set from ~Rs 1.70 to ~Rs 10.78.
//
// The fix is brevity, NOT fewer points - the point count is a product
// requirement and stays at 8-10. Each point simply has to be one tight sentence
// instead of a paragraph, which is what Gemini already does naturally.
const BREVITY_ADDENDUM = `

CRITICAL OUTPUT LENGTH RULE:
- Keep the solution to 8-10 points, but make EACH point ONE short sentence of at most 16 words.
- State the fact and stop. No preamble, no restating the question, no hedging, no repetition between points.
- Do not explain why a wrong option is wrong in more than one short sentence.
- The entire Solution block must stay under 160 words total.`;

const DEVANAGARI = /[ऀ-ॿ]/;
export function isHindi(text: string): boolean {
  return DEVANAGARI.test(text);
}

/**
 * One DeepSeek chat completion. The system prompt is sent as its own message and
 * is byte-identical on every call, so DeepSeek's automatic prefix cache serves it
 * at 1/50th the input rate after the first question of a run.
 */
async function callDeepSeek(opts: {
  apiKey: string;
  system: string;
  user: string;
  maxTokens: number;
  signal?: AbortSignal;
}): Promise<{ text: string; usage: DeepSeekUsage }> {
  const res = await fetch(DEEPSEEK_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
      temperature: 0.1,
      top_p: 0.1,
      max_tokens: opts.maxTokens,
      stream: false,
      // Reasoning is ON by default on deepseek-flash and its tokens are billed
      // as OUTPUT, which is ~91% of the cost here - yet none of it is ever shown
      // to the user. Measured on this prompt: 70 of 232 completion tokens were
      // hidden reasoning. Disabling it cut output ~30% AND latency ~40%
      // (2655ms -> 1590ms), while the visible answer got slightly LONGER.
      // Tried and rejected: reasoning_effort "minimal" (still 55 reasoning
      // tokens) and chat_template_kwargs (65). Only this switch reaches zero.
      thinking: { type: "disabled" },
    }),
    // A hung connection must not hold a worker for the life of the batch.
    signal: opts.signal
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err: any = new Error(`DeepSeek ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  const json: any = await res.json();
  const text = json?.choices?.[0]?.message?.content ?? "";
  const finish = json?.choices?.[0]?.finish_reason;
  const u = json?.usage ?? {};

  const cacheHit = Number(u.prompt_cache_hit_tokens ?? 0);
  const cacheMiss = Number(u.prompt_cache_miss_tokens ?? u.prompt_tokens ?? 0);
  const output = Number(u.completion_tokens ?? 0);
  const usage: DeepSeekUsage = {
    promptTokens: Number(u.prompt_tokens ?? 0),
    completionTokens: output,
    cacheHitTokens: cacheHit,
    cacheMissTokens: cacheMiss,
    costUsd: priceCall({ cacheHit, cacheMiss, output, peak: isDeepSeekPeak() }),
  };

  spend.calls++;
  spend.costUsd += usage.costUsd;
  spend.promptTokens += usage.promptTokens;
  spend.completionTokens += usage.completionTokens;
  spend.cacheHitTokens += usage.cacheHitTokens;

  if (finish === "length") {
    const e: any = new Error("DeepSeek hit the output limit and returned a truncated answer");
    e.usage = usage;
    throw e;
  }
  return { text, usage };
}

/**
 * Solve one MCQ through DeepSeek, translating around it when the input is Hindi.
 *
 * Signature matches formatQuestionWithGemini so the batch processor can use
 * either without caring which one answered.
 */
export async function solveWithDeepSeek({
  raw,
  idx,
  subjectType,
  solutionLength,
  signal,
}: QuestionSolverOptions): Promise<SolveResult> {
  if (signal?.aborted) throw new Error("Question solving aborted");
  if (!deepseekAvailable()) {
    throw new Error(`DeepSeek unavailable: ${deepseekDisabledReason}`);
  }

  let apiKey: string;
  try {
    apiKey = await getDeepseekApiKey();
  } catch (e: any) {
    // No key configured at all - same breaker, so we stop offering the tier.
    tripBreaker(String(e?.message || "no API key configured"));
    throw e;
  }

  let cleaned: string;
  try {
    cleaned = latexToText(raw);
  } catch {
    cleaned = raw;
  }
  if (!cleaned.trim()) throw new Error("Empty question text");

  const hindi = isHindi(cleaned);

  // Hindi in -> English for the model. Translation failures are non-fatal: fall
  // back to sending the original text rather than losing the question entirely.
  let forModel = cleaned;
  if (hindi) {
    try {
      forModel = await gtranslate(cleaned, "hi", "en");
    } catch {
      forModel = cleaned;
    }
  }

  const isLong = solutionLength === "long";
  const basePrompt =
    subjectType === "math"
      ? isLong
        ? UNIFIED_SYSTEM_PROMPT_MATH_LONG
        : UNIFIED_SYSTEM_PROMPT_MATH_NORMAL
      : isLong
        ? UNIFIED_SYSTEM_PROMPT_GK_LONG
        : UNIFIED_SYSTEM_PROMPT_GK_NORMAL;
  const system = basePrompt + BREVITY_ADDENDUM;

  let out = "";
  let apiCalls = 0;
  let maxTokens = 700;
  let lastError: any = null;

  // Generous retry budget: the batch contract is that every question finishes,
  // and a single 429 or dropped socket must never be the reason one does not.
  const MAX_ATTEMPTS = 6;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw Object.assign(new Error("Question solving aborted"), { apiCalls });
    try {
      apiCalls++;
      const r = await callDeepSeek({
        apiKey,
        system,
        user: `Solve and format the following MCQ:\n\n${forModel}`,
        maxTokens,
        signal,
      });
      if (r.text.trim()) {
        out = r.text;
        break;
      }
      lastError = new Error("DeepSeek returned an empty response");
    } catch (e: any) {
      lastError = e;
      // Truncation: give the retry more room rather than repeating the failure.
      if (String(e?.message || "").includes("output limit")) {
        maxTokens = Math.min(maxTokens * 2, 2800);
        continue;
      }
      // 401 invalid key, 402 out of balance, 403 suspended. None recover on
      // retry, and all of them apply to every future call too.
      if ([401, 402, 403].includes(e?.status)) {
        tripBreaker(`HTTP ${e.status}: ${String(e?.message || "").slice(0, 120)}`);
        throw Object.assign(e, { apiCalls });
      }
      if (attempt < MAX_ATTEMPTS) {
        // 429 means DeepSeek wants us to slow down, so back off harder for it
        // than for an ordinary network blip. Exponential with jitter, capped so
        // one bad question cannot stall a batch indefinitely.
        const rateLimited = e?.status === 429;
        const base = rateLimited ? 1500 : 400;
        const delay = Math.min(base * 2 ** (attempt - 1), 12_000) + Math.random() * 500;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
    }
  }

  if (!out.trim()) {
    throw Object.assign(lastError || new Error("DeepSeek failed to solve question"), { apiCalls });
  }

  // English out -> Hindi, matching the language the question arrived in.
  //
  // The option labels MUST be shielded on this leg. Measured on a real answer,
  // an unprotected en->hi pass transliterates them into Devanagari - "B." comes
  // back as "बी.", "Answer:" as "उत्तर:" - which breaks both the required output
  // format and the answer-key parsing downstream. protectOptionsForTranslation
  // swaps them for sentinels Google leaves alone and normalizeTranslated puts
  // them back. (The inbound hi->en leg needs none of this: "(A)" was verified to
  // survive that direction untouched.)
  if (hindi) {
    try {
      const translated = await gtranslate(protectOptionsForTranslation(out), "en", "hi");
      out = normalizeTranslated(translated, idx);
    } catch {
      // Keep the English answer rather than failing the question outright.
    }
  }

  return { text: sanitizeAiOutput(latexToText(out), idx, subjectType), apiCalls };
}

// Backward-compatible aliases. Nothing in the app imports these today, but they
// were part of this module's public surface before it became a re-export shim.
export { solveWithDeepSeek as formatQuestionWithDeepSeek };
export { solveWithDeepSeek as formatQuestionWithDeepSeekNative };
export * from "./gemini.server";

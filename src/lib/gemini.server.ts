// Server-only Gemini question solver and formatter (uses free-tier multi-key pool)
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { latexToText } from "./latex-to-text";
import { getGeminiApiKeys } from "./settings.functions";
import {
  UNIFIED_SYSTEM_PROMPT_GK_NORMAL,
  UNIFIED_SYSTEM_PROMPT_GK_LONG,
  UNIFIED_SYSTEM_PROMPT_MATH_NORMAL,
  UNIFIED_SYSTEM_PROMPT_MATH_LONG,
  sanitizeAiOutput,
  type DeepSeekOptions,
} from "./deepseek.server";

// Type augmentation: @google/generative-ai v0.24.1 does not yet include thinkingConfig in GenerationConfig
declare module "@google/generative-ai" {
  interface GenerationConfig {
    thinkingConfig?: {
      thinkingBudget?: number;
      turnOffThinking?: boolean;
    };
  }
}

const defaultSafetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// High-quota, ultra-fast free tier models (1,500 RPD each across 18 keys = 108,000+ daily capacity):
// - gemini-flash-lite-latest: Blazing fast ~2.0s latency with thinkingBudget 256, 1,500 RPD
// - gemini-3.5-flash-lite: Reliable ~2.2s latency with thinkingBudget 256, 1,500 RPD
// - gemini-3.1-flash-lite: High capacity fallback, 1,500 RPD
// - gemini-3.6-flash: High-capability flash model, 1,500 RPD
const GEMINI_SOLVER_MODELS = [
  "gemini-flash-lite-latest",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.6-flash",
];

let keyIndex = 0;
// Track rate limits and quota cooldowns per (key + model) pair
const rateLimitedKeyModels = new Map<string, number>();
const permanentlyUnavailableModels = new Set<string>();
const permanentlyDisabledKeys = new Set<string>();

function isKeyModelAvailable(key: string, modelName: string): boolean {
  if (permanentlyDisabledKeys.has(key)) return false;
  if (permanentlyUnavailableModels.has(modelName)) return false;
  const composite = `${key.slice(-8)}:${modelName}`;
  const timeout = rateLimitedKeyModels.get(composite);
  if (!timeout) return true;
  if (Date.now() > timeout) {
    rateLimitedKeyModels.delete(composite);
    return true;
  }
  return false;
}

function recordModelRateLimit(key: string, modelName: string, isDailyQuota: boolean, retryAfterMs?: number) {
  const composite = `${key.slice(-8)}:${modelName}`;
  // 30-minute cooldown if genuine daily quota/RPD is exhausted for this model on this key;
  // If Google specified a retryAfterMs (e.g. 5s), use it + 1s padding. Otherwise 4 seconds for temporary RPM burst.
  const cooldown = isDailyQuota
    ? 30 * 60_000
    : (retryAfterMs ? Math.max(retryAfterMs + 1000, 3000) : 4_000);
  rateLimitedKeyModels.set(composite, Date.now() + cooldown);
}

function getEarliestAvailableDelay(): number {
  if (rateLimitedKeyModels.size === 0) return 2000;
  let minWait = Infinity;
  const now = Date.now();
  for (const exp of rateLimitedKeyModels.values()) {
    // Only consider temporary cooldowns (< 10 minutes) rather than long daily quota lockouts
    if (exp - now < 10 * 60_000 && exp > now) {
      if (exp < minWait) minWait = exp;
    }
  }
  if (minWait === Infinity) return 2500;
  return Math.max(1000, minWait - now);
}

function classifyError(error: any): { isDailyQuota: boolean; isRateLimitOr503: boolean; retryAfterMs?: number } {
  const msg = (error?.message || "").toLowerCase();
  const status = error?.status;

  // Detect explicit retry delays in error message e.g. "Please retry in 42.59s" or "retryDelay":"42s"
  let retryAfterMs: number | undefined;
  const retryMatch = msg.match(/(?:retry in|retrydelay["']?:\s*["']?)(\d+(?:\.\d+)?)/i);
  if (retryMatch) {
    retryAfterMs = Math.ceil(parseFloat(retryMatch[1]) * 1000);
  }

  const isDaily =
    msg.includes("per day") ||
    msg.includes("requests per day") ||
    msg.includes("generaterequestsperday") ||
    msg.includes("limit: 1500") ||
    msg.includes("per_day");

  const isRateLimitOr503 =
    status === 429 ||
    status === 503 ||
    msg.includes("429") ||
    msg.includes("503") ||
    msg.includes("resourceexhausted") ||
    msg.includes("quota") ||
    msg.includes("high demand") ||
    msg.includes("spikes in demand");

  return { isDailyQuota: isDaily, isRateLimitOr503, retryAfterMs };
}

function getResponseTextSafely(response: any): string {
  try {
    return response.text();
  } catch (e: any) {
    const candidate = response?.candidates?.[0];
    const partsText = candidate?.content?.parts
      ?.map((p: any) => (typeof p.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("");
    if (partsText && partsText.trim().length > 0) {
      return partsText;
    }
    throw e;
  }
}

export async function formatQuestionWithGemini({
  raw,
  idx,
  subjectType,
  solutionLength,
}: DeepSeekOptions): Promise<string> {
  const allKeys = (await getGeminiApiKeys()).filter((k) => !permanentlyDisabledKeys.has(k));
  if (allKeys.length === 0) {
    throw new Error("No available Gemini API keys configured");
  }

  let cleaned: string;
  try {
    cleaned = latexToText(raw);
  } catch {
    cleaned = raw;
  }
  if (!cleaned.trim()) throw new Error("Empty question text");

  const isLong = solutionLength === "long";
  const systemInstruction = subjectType === "math"
    ? (isLong ? UNIFIED_SYSTEM_PROMPT_MATH_LONG : UNIFIED_SYSTEM_PROMPT_MATH_NORMAL)
    : (isLong ? UNIFIED_SYSTEM_PROMPT_GK_LONG : UNIFIED_SYSTEM_PROMPT_GK_NORMAL);

  const prompt = `Solve and format the following MCQ:\n\n${cleaned}`;

  let lastError: any = null;
  const MAX_RETRIES = 10;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let triedAtLeastOneKey = false;

    // Prioritize high-quota flash-lite models across rotating healthy keys
    for (const modelName of GEMINI_SOLVER_MODELS) {
      if (permanentlyUnavailableModels.has(modelName)) continue;

      // Rotate starting key index so concurrent requests distribute evenly across the 18 keys
      const startKeyIdx = keyIndex % allKeys.length;
      keyIndex = (keyIndex + 1) % 1_000_000;

      for (let k = 0; k < allKeys.length; k++) {
        const keyIdx = (startKeyIdx + k) % allKeys.length;
        const key = allKeys[keyIdx];

        if (!isKeyModelAvailable(key, modelName)) {
          continue; // In active cooldown on this key; skip to next key instantly in 0ms
        }

        triedAtLeastOneKey = true;

        try {
          const genAI = new GoogleGenerativeAI(key);
          const model = genAI.getGenerativeModel(
            {
              model: modelName,
              systemInstruction,
              generationConfig: {
                temperature: 0.1,
                topP: 0.1,
                maxOutputTokens: 2048,
                // Cap thinking budget to 128 tokens for blazing ~1.9s response time while keeping 8-10 points depth
                thinkingConfig: { thinkingBudget: 128 },
              },
              safetySettings: defaultSafetySettings,
            },
            { timeout: 12000 }
          );

          let result;
          try {
            result = await model.generateContent([prompt]);
          } catch (genErr: any) {
            const errMsg = (genErr?.message || "").toLowerCase();
            // If the model does not support thinkingConfig, immediately retry without it
            if (errMsg.includes("invalid argument") || errMsg.includes("thinking")) {
              const fallbackModel = genAI.getGenerativeModel(
                {
                  model: modelName,
                  systemInstruction,
                  generationConfig: {
                    temperature: 0.1,
                    topP: 0.1,
                    maxOutputTokens: 2048,
                  },
                  safetySettings: defaultSafetySettings,
                },
                { timeout: 12000 }
              );
              result = await fallbackModel.generateContent([prompt]);
            } else {
              throw genErr;
            }
          }

          const response = await result.response;
          const text = getResponseTextSafely(response);
          if (text && text.trim().length > 0) {
            return sanitizeAiOutput(latexToText(text), idx, subjectType);
          }
        } catch (error: any) {
          lastError = error;
          const msg = (error?.message || "").toLowerCase();
          const status = error?.status;

          // If the key itself is disabled/forbidden, permanently mark it
          if (status === 403 || msg.includes("denied access") || msg.includes("api_key_invalid") || msg.includes("consumer_suspended")) {
            permanentlyDisabledKeys.add(key);
            continue;
          }

          const { isDailyQuota, isRateLimitOr503, retryAfterMs } = classifyError(error);

          if (isRateLimitOr503) {
            recordModelRateLimit(key, modelName, isDailyQuota, retryAfterMs);
            continue; // Rotate to next available key in 0ms!
          }

          if (msg.includes("not found") || msg.includes("deprecated")) {
            permanentlyUnavailableModels.add(modelName);
            break; // Don't try this deprecated model on any other keys
          }

          if (msg.includes("recitation") || msg.includes("safety")) {
            continue; // Safety edge case; try next model
          }

          // Unknown error; record short cooldown and continue
          recordModelRateLimit(key, modelName, false);
          continue;
        }
      }
    }

    if (attempt < MAX_RETRIES) {
      // Dynamic smart wait: if all keys were in cooldown, wait for earliest cooldown expiry instead of burning attempts
      const earliestDelay = getEarliestAvailableDelay();
      const baseDelay = triedAtLeastOneKey ? 1000 * Math.pow(1.2, attempt) : earliestDelay;
      const jitter = Math.random() * 800;
      const sleepTime = Math.min(Math.max(baseDelay, 1500), 8000) + jitter;
      await new Promise((resolve) => setTimeout(resolve, sleepTime));
    }
  }

  throw new Error(lastError?.message || "Failed to solve question across all Gemini keys and models.");
}

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

const defaultSafetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// Prioritize Google Gemini's cheapest, fastest, and highest-quota Flash-Lite models
// - gemini-3.5-flash-lite: Cheapest model ($0.075/1M), 30 RPM free tier, ~1.4s latency
// - gemini-flash-lite-latest: Latest auto-updating cheapest lightweight tier
// - gemini-3.1-flash-lite: Reliable lightweight fallback
// - gemini-3.7-flash: High-capability flash fallback
// - gemini-flash-latest: Auto-updating standard flash fallback
const GEMINI_SOLVER_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-3.1-flash-lite",
  "gemini-3.7-flash",
  "gemini-flash-latest",
];

let keyIndex = 0;
// Track rate limits and quota cooldowns per (key + model) pair
const rateLimitedKeyModels = new Map<string, number>();
const permanentlyUnavailableModels = new Set<string>();

function isKeyModelAvailable(key: string, modelName: string): boolean {
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

function recordModelRateLimit(key: string, modelName: string, isDailyQuota: boolean) {
  const composite = `${key.slice(-8)}:${modelName}`;
  // 30-minute cooldown if daily quota/RPD is exhausted; 6 seconds for temporary 429/503 RPM spikes
  const cooldown = isDailyQuota ? 30 * 60_000 : 6_000;
  rateLimitedKeyModels.set(composite, Date.now() + cooldown);
}

function classifyError(error: any): { isDailyQuota: boolean; isRateLimitOr503: boolean } {
  const msg = (error?.message || "").toLowerCase();
  const status = error?.status;
  const isDaily =
    msg.includes("per day") ||
    msg.includes("daily") ||
    msg.includes("requests per day") ||
    msg.includes("limit: 1500") ||
    msg.includes("free_tier_requests_per_day");

  const isRateLimitOr503 =
    status === 429 ||
    status === 503 ||
    msg.includes("429") ||
    msg.includes("503") ||
    msg.includes("resourceexhausted") ||
    msg.includes("quota") ||
    msg.includes("high demand") ||
    msg.includes("spikes in demand");

  return { isDailyQuota: isDaily, isRateLimitOr503 };
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
  const allKeys = await getGeminiApiKeys();
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
  const MAX_RETRIES = 5;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // Level 1: Prioritize the fastest/cheapest model (gemini-3.5-flash-lite) across rotating keys.
    // If all keys are rate-limited on model 1, smoothly fall back to model 2 across keys, etc.
    for (const modelName of GEMINI_SOLVER_MODELS) {
      if (permanentlyUnavailableModels.has(modelName)) continue;

      // Rotate starting key index so concurrent requests distribute evenly across the 18 keys
      const startKeyIdx = keyIndex++ % allKeys.length;

      for (let k = 0; k < allKeys.length; k++) {
        const keyIdx = (startKeyIdx + k) % allKeys.length;
        const key = allKeys[keyIdx];

        if (!isKeyModelAvailable(key, modelName)) {
          continue; // In active cooldown on this key; skip to next key instantly in 0ms
        }

        try {
          const genAI = new GoogleGenerativeAI(key);
          const model = genAI.getGenerativeModel({
            model: modelName,
            systemInstruction,
            generationConfig: {
              temperature: 0.1,
              topP: 0.1,
              maxOutputTokens: 2048,
            },
            safetySettings: defaultSafetySettings,
          });

          const result = await model.generateContent([prompt]);
          const response = await result.response;
          const text = getResponseTextSafely(response);
          if (text && text.trim().length > 0) {
            return sanitizeAiOutput(latexToText(text), idx, subjectType);
          }
        } catch (error: any) {
          lastError = error;
          const { isDailyQuota, isRateLimitOr503 } = classifyError(error);

          if (isRateLimitOr503) {
            recordModelRateLimit(key, modelName, isDailyQuota);
            continue; // Rotate to next available key in 0ms!
          }

          const msg = (error?.message || "").toLowerCase();
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
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  throw new Error(lastError?.message || "Failed to solve question across all Gemini keys and models.");
}

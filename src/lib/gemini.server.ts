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
// - gemini-3.5-flash-lite: Cheapest model ($0.075/1M), 30 RPM free tier, ~1.8s latency
// - gemini-flash-lite-latest: Latest auto-updating cheapest lightweight tier
// - gemini-3.1-flash-lite: Reliable lightweight fallback
// - gemini-3.7-flash: High-capability flash fallback
const GEMINI_SOLVER_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-3.1-flash-lite",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-flash-latest",
];

let keyIndex = 0;
// Track rate limits and quota cooldowns per (key + model) pair so exhausting
// one model family automatically unlocks the next model family on the same key.
const rateLimitedKeyModels = new Map<string, number>();

function isKeyModelAvailable(key: string, modelName: string): boolean {
  const composite = `${key.slice(-8)}:${modelName}`;
  const timeout = rateLimitedKeyModels.get(composite);
  if (!timeout) return true;
  if (Date.now() > timeout) {
    rateLimitedKeyModels.delete(composite);
    return true;
  }
  return false;
}

function recordModelRateLimit(key: string, modelName: string, isQuota: boolean) {
  const composite = `${key.slice(-8)}:${modelName}`;
  // 60-second cooldown if daily quota/resource exhausted; 6 seconds for temporary 429/503 spikes
  const cooldown = isQuota ? 60_000 : 6_000;
  rateLimitedKeyModels.set(composite, Date.now() + cooldown);
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
  const MAX_RETRIES = 6;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    for (let i = 0; i < allKeys.length; i++) {
      const index = keyIndex++ % allKeys.length;
      const key = allKeys[index];

      for (const modelName of GEMINI_SOLVER_MODELS) {
        if (!isKeyModelAvailable(key, modelName)) {
          continue; // Skip models currently in cooldown on this key
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
          const msg = error.message?.toLowerCase() || "";
          const isRateOrQuota =
            error.status === 429 ||
            error.status === 503 ||
            msg.includes("429") ||
            msg.includes("503") ||
            msg.includes("resourceexhausted") ||
            msg.includes("quota");

          if (isRateOrQuota) {
            const isDailyQuota = msg.includes("quota") || msg.includes("resourceexhausted");
            recordModelRateLimit(key, modelName, isDailyQuota);
            // Multi-model quota stacking: continue to next model family instead of discarding key!
            continue;
          }
          if (msg.includes("recitation") || msg.includes("safety") || msg.includes("not found")) {
            continue; // Try next model in pool
          }
          break;
        }
      }
    }

    if (attempt < MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  throw new Error(lastError?.message || "Failed to solve question using Gemini pool.");
}

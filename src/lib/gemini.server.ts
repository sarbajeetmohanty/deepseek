// Server-only Gemini question solver and formatter (uses free-tier multi-key pool)
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { latexToText } from "./latex-to-text";
import { getGeminiApiKeys } from "./settings.functions";
import {
  PROMPT_GK,
  PROMPT_MATH,
  LANG_RULE,
  LENGTH_NORMAL,
  LENGTH_LONG,
  sanitizeAiOutput,
  type DeepSeekOptions,
} from "./deepseek.server";

const defaultSafetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

const GEMINI_SOLVER_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash-lite",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
  "gemini-flash-lite-latest",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.7-flash",
];

let keyIndex = 0;
const rateLimitedKeys = new Map<string, number>();

function getAvailableKeys(allKeys: string[]): string[] {
  const now = Date.now();
  const available = allKeys.filter((key) => {
    const timeout = rateLimitedKeys.get(key);
    if (!timeout) return true;
    if (now > timeout) {
      rateLimitedKeys.delete(key);
      return true;
    }
    return false;
  });
  return available.length > 0 ? available : allKeys;
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

  const basePrompt = subjectType === "math" ? PROMPT_MATH : PROMPT_GK;
  const lengthRule = subjectType === "math" ? (solutionLength === "long" ? LENGTH_LONG : LENGTH_NORMAL) : "";
  const systemInstruction = basePrompt + LANG_RULE + lengthRule;
  const prompt = `Solve and format the following MCQ:\n\n${cleaned}\n\nReminder: Output strictly in the required format. Question must begin with "${idx}."`;

  let lastError: any = null;
  const MAX_RETRIES = 6;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const activeKeys = getAvailableKeys(allKeys);

    for (let i = 0; i < activeKeys.length; i++) {
      const index = keyIndex++ % activeKeys.length;
      const key = activeKeys[index];

      for (const modelName of GEMINI_SOLVER_MODELS) {
        try {
          const genAI = new GoogleGenerativeAI(key);
          const model = genAI.getGenerativeModel({
            model: modelName,
            systemInstruction,
            generationConfig: {
              temperature: 0.1,
              topP: 0.1,
              maxOutputTokens: subjectType === "math" && solutionLength === "normal" ? 600 : 1000,
            },
            safetySettings: defaultSafetySettings,
          });

          const result = await model.generateContent([prompt]);
          const response = await result.response;
          const text = response.text();
          if (text && text.trim().length > 0) {
            return sanitizeAiOutput(latexToText(text), idx, subjectType);
          }
        } catch (error: any) {
          lastError = error;
          const msg = error.message?.toLowerCase() || "";
          if (
            error.status === 429 ||
            error.status === 503 ||
            msg.includes("429") ||
            msg.includes("503") ||
            msg.includes("resourceexhausted") ||
            msg.includes("quota")
          ) {
            rateLimitedKeys.set(key, Date.now() + 5000);
            break; // Try next key in pool
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

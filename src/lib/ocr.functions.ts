import { createServerFn } from "@tanstack/react-start";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { getGeminiApiKeys } from "./settings.functions";

type ExtractPayload = {
  data: string;
  customPrompt?: string | undefined;
};

// Global state for intelligent key load balancing across concurrent requests
let currentKeyIndex = 0;
const rateLimitedKeys = new Map<string, number>();

function getAvailableKeys(allKeys: string[]): string[] {
  const now = Date.now();
  // Filter out keys that are currently in their timeout period (e.g., 5 seconds)
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

const defaultSafetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// Prioritizing Gemini 3.5 Flash-Lite as requested
const GEMINI_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-3.1-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
];

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
      console.warn("Recovered text from candidate with finishReason:", candidate?.finishReason);
      return partsText;
    }
    throw e;
  }
}

export const extractTextFromImage = createServerFn({ method: "POST" })
  .validator((d: ExtractPayload) => d)
  .handler(async ({ data: payload }) => {
    const base64Image = payload.data;
    const allKeys = await getGeminiApiKeys();
    const base64Data = base64Image.replace(/^data:image\/(png|jpeg);base64,/, "");

    const prompt = payload.customPrompt
      ? `${payload.customPrompt}\n\nIMPORTANT: Return ONLY the requested content based on the instructions above. Do not include any conversational filler, markdown code blocks, or greetings. Output exactly what is requested.`
      : `Transcribe and digitize all text and questions from this document image accurately.
- Preserve the layout, question numbers, statements (e.g. (1), (2), (3), (4)), and options (A, B, C, D) exactly.
- Each statement, code header ('कूट :', 'Code:'), and option (A., B., C., D. or (a), (b), (c), (d)) MUST be on its own separate line.
- Return only the raw extracted text.`;

    const imageParts = [
      {
        inlineData: {
          data: base64Data,
          mimeType: "image/jpeg",
        },
      },
    ];

    let lastError: any = null;
    const MAX_RETRIES = 12;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const activeKeys = getAvailableKeys(allKeys);

      for (let i = 0; i < activeKeys.length; i++) {
        const index = currentKeyIndex++ % activeKeys.length;
        const key = activeKeys[index];

        for (const modelName of GEMINI_MODELS) {
          try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({
              model: modelName,
              systemInstruction:
                "You are an OCR and document digitization engine. Accurately transcribe and digitize the document image into text.",
              generationConfig: {
                temperature: 0.1,
                topP: 0.95,
              },
              safetySettings: defaultSafetySettings,
            });

            const result = await model.generateContent([prompt, ...imageParts]);
            const response = await result.response;
            const text = getResponseTextSafely(response);
            if (text && text.trim().length > 0) {
              return text;
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
              break; // Try next key
            }

            if (msg.includes("recitation") || msg.includes("safety") || msg.includes("not found")) {
              console.warn(`Model ${modelName} hit safety/recitation filter. Trying next Gemini model in pool...`);
              continue;
            }

            break;
          }
        }
      }

      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }

    console.error("All OCR attempts exhausted:", lastError);
    throw new Error(lastError?.message || "Failed to extract text from image using Gemini.");
  });

type GenerationPayload = {
  contextText: string;
  customPrompt: string;
};

export const generateFromContext = createServerFn({ method: "POST" })
  .validator((d: GenerationPayload) => d)
  .handler(async ({ data: payload }) => {
    const allKeys = await getGeminiApiKeys();

    const prompt = `${payload.customPrompt}\n\nIMPORTANT: Return ONLY the requested content based on the instructions above. Do not include any conversational filler, markdown code blocks, or greetings. Output exactly what is requested.\n\n--- DOCUMENT CONTEXT START ---\n${payload.contextText}\n--- DOCUMENT CONTEXT END ---`;

    let lastError: any = null;
    const MAX_RETRIES = 10;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const activeKeys = getAvailableKeys(allKeys);

      for (let i = 0; i < activeKeys.length; i++) {
        const index = currentKeyIndex++ % activeKeys.length;
        const key = activeKeys[index];

        for (const modelName of GEMINI_MODELS) {
          try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({
              model: modelName,
              systemInstruction:
                "You are an expert document structuring and question extraction assistant. Digitize, format, and organize the user's provided document questions according to their instructions.",
              generationConfig: {
                temperature: 0.1,
                topP: 0.95,
              },
              safetySettings: defaultSafetySettings,
            });

            const result = await model.generateContent([prompt]);
            const response = await result.response;
            const text = getResponseTextSafely(response);
            if (text && text.trim().length > 0) {
              return text;
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
              break;
            }

            if (msg.includes("recitation") || msg.includes("safety") || msg.includes("not found")) {
              console.warn(`Model ${modelName} triggered ${msg.includes("recitation") ? "RECITATION" : "safety"} filter. Retrying with next Gemini model...`);
              continue;
            }

            break;
          }
        }
      }

      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }

    console.error("All Gemini models/keys exhausted in Phase 2 generation:", lastError);
    throw new Error(lastError?.message || "Failed to generate formatted questions using Gemini.");
  });

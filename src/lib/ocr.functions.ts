import { createServerFn } from "@tanstack/react-start";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { requireSupabaseAuth } from "../integrations/supabase/auth-middleware";
import { getGeminiApiKeys } from "./settings.functions";

type ExtractPayload = {
  data: string;
  customPrompt?: string | undefined;
};

type GenerationPayload = {
  contextText: string;
  customPrompt: string;
};

// Client cache to avoid instantiating new GoogleGenerativeAI objects on every request
const ocrGenAiClientCache = new Map<string, GoogleGenerativeAI>();
function getOcrGenAIClient(key: string): GoogleGenerativeAI {
  let client = ocrGenAiClientCache.get(key);
  if (!client) {
    client = new GoogleGenerativeAI(key);
    ocrGenAiClientCache.set(key, client);
  }
  return client;
}

let ocrKeyIndex = 0;
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

const defaultSafetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
];

const OCR_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite-preview",
  "gemini-3.1-flash-lite",
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
      return partsText;
    }
    throw e;
  }
}

export const extractTextFromImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: ExtractPayload) => {
    if (!d?.data || typeof d.data !== "string") {
      throw new Error("Image data is required");
    }
    if (d.data.length > 15_000_000) {
      throw new Error("Image payload too large (max 15MB)");
    }
    return {
      data: d.data,
      customPrompt: d.customPrompt ? String(d.customPrompt).slice(0, 4000) : undefined,
    };
  })
  .handler(async ({ data: payload }) => {
    const base64Image = payload.data;
    const allKeys = await getGeminiApiKeys();
    const base64Data = base64Image.replace(/^data:image\/(png|jpeg|jpg|webp);base64,/, "");

    const prompt = payload.customPrompt
      ? `${payload.customPrompt}\n\nIMPORTANT: Return ONLY the requested content based on the instructions above. Do not include any conversational filler, markdown code blocks, or greetings. Output exactly what is requested.`
      : `Transcribe and digitize all text and questions from this document image accurately.
- Preserve the layout, question numbers, statements (ensure a space after statement numbers, e.g., 1 <text>, 2 <text>), and options (A., B., C., D.) exactly.
- If there is a match-the-column table, transcribe it as two completely separate lists: "Column A:" followed by its items (a., b., c., d.), and "Column B:" followed by its items (1, 2, 3, 4 without dot). NEVER combine rows using '|' or spaces.
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
    const MAX_ATTEMPTS = 6;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const activeKeys = getAvailableKeys(allKeys);
      const key = activeKeys[ocrKeyIndex++ % activeKeys.length];
      const modelName = OCR_MODELS[(attempt - 1) % OCR_MODELS.length];

      try {
        const genAI = getOcrGenAIClient(key);
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
          continue;
        }

        if (msg.includes("recitation") || msg.includes("safety") || msg.includes("not found")) {
          continue;
        }
      }
    }

    throw new Error(lastError?.message || "Failed to extract text from image using Gemini.");
  });

export const generateFromContext = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: GenerationPayload) => {
    if (!d?.contextText || typeof d.contextText !== "string") {
      throw new Error("Context text is required");
    }
    return {
      contextText: d.contextText.slice(0, 100_000),
      customPrompt: String(d.customPrompt || "").slice(0, 5000),
    };
  })
  .handler(async ({ data: payload }) => {
    const allKeys = await getGeminiApiKeys();

    const prompt = `${payload.customPrompt}\n\nIMPORTANT: Return ONLY the requested content based on the instructions above. Do not include any conversational filler, markdown code blocks, or greetings. Output exactly what is requested.\n\n--- DOCUMENT CONTEXT START ---\n${payload.contextText}\n--- DOCUMENT CONTEXT END ---`;

    let lastError: any = null;
    const MAX_ATTEMPTS = 6;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const activeKeys = getAvailableKeys(allKeys);
      const key = activeKeys[ocrKeyIndex++ % activeKeys.length];
      const modelName = OCR_MODELS[(attempt - 1) % OCR_MODELS.length];

      try {
        const genAI = getOcrGenAIClient(key);
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
          continue;
        }

        if (msg.includes("recitation") || msg.includes("safety") || msg.includes("not found")) {
          continue;
        }
      }
    }

    throw new Error(lastError?.message || "Failed to generate formatted questions using Gemini.");
  });

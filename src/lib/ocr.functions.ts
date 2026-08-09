import { createServerFn } from "@tanstack/react-start";
import { GoogleGenerativeAI } from "@google/generative-ai";
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
  const available = allKeys.filter(key => {
    const timeout = rateLimitedKeys.get(key);
    if (!timeout) return true;
    if (now > timeout) {
      rateLimitedKeys.delete(key);
      return true;
    }
    return false;
  });
  return available.length > 0 ? available : allKeys; // If all are rate-limited, try them anyway as a last resort
}

export const extractTextFromImage = createServerFn({ method: "POST" })
  .validator((d: ExtractPayload) => d)
  .handler(async ({ data: payload }) => {
    const base64Image = payload.data;
    
    // Use the dynamic DB-driven keys from settings instead of hardcoded .env
    const allKeys = await getGeminiApiKeys();

    const base64Data = base64Image.replace(/^data:image\/(png|jpeg);base64,/, "");
    
    const prompt = payload.customPrompt 
      ? `${payload.customPrompt}\n\nIMPORTANT: Return ONLY the requested content based on the instructions above. Do not include any conversational filler, markdown code blocks, or greetings. Output exactly what is requested.`
      : `Extract all text from this image exactly as it appears. 
Preserve the layout, spacing, and formatting as best as possible. 
Do not translate it, do not summarize it. Return only the raw extracted text.`;

    const imageParts = [
      {
        inlineData: {
          data: base64Data,
          mimeType: "image/jpeg",
        },
      },
    ];

    let lastError = null;
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const activeKeys = getAvailableKeys(allKeys);
      
      // Try every available key using round-robin distribution
      for (let i = 0; i < activeKeys.length; i++) {
        // Atomic increment for round-robin across concurrent requests
        const index = currentKeyIndex++ % activeKeys.length;
        const key = activeKeys[index];
        
        try {
          const genAI = new GoogleGenerativeAI(key);
          const model = genAI.getGenerativeModel({ model: "gemini-flash-lite-latest" });
          
          const result = await model.generateContent([prompt, ...imageParts]);
          const response = await result.response;
          return response.text();
        } catch (error: any) {
          lastError = error;
          const msg = error.message?.toLowerCase() || "";
          
          // Check for rate limits (429), server overload (503), or quota exhaustion
          if (
            error.status === 429 || 
            error.status === 503 || 
            msg.includes("429") || 
            msg.includes("503") || 
            msg.includes("resourceexhausted") || 
            msg.includes("quota")
          ) {
            console.warn(`API Key hit a limit or overloaded (Attempt ${attempt}/${MAX_RETRIES}). Backing off this key for 5s...`);
            rateLimitedKeys.set(key, Date.now() + 5000); // Mark key as rate limited for 5s
            continue; // Instantly retry the extraction with the next key in the array
          }
          
          // If it's a real failure (like an invalid base64 image), throw it immediately
          throw new Error(error.message || "Failed to extract text from image using Gemini.");
        }
      }
      
      // If we exhausted all keys, wait a bit before trying the whole list again (if not the last attempt)
      if (attempt < MAX_RETRIES) {
        console.warn(`All keys exhausted or rate-limited on attempt ${attempt}. Waiting 5s before retrying...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    console.error("All API keys are exhausted:", lastError);
    throw new Error("All Gemini API keys have exhausted their quota or are rate limited. Try again later.");
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

    let lastError = null;
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const activeKeys = getAvailableKeys(allKeys);

      for (let i = 0; i < activeKeys.length; i++) {
        const index = currentKeyIndex++ % activeKeys.length;
        const key = activeKeys[index];

        try {
          const genAI = new GoogleGenerativeAI(key);
          // Using gemini-flash-lite-latest which handles 1M tokens
          const model = genAI.getGenerativeModel({ model: "gemini-flash-lite-latest" });
          
          const result = await model.generateContent([prompt]);
          const response = await result.response;
          return response.text();
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
            console.warn(`API Key hit a limit during Global Generation (Attempt ${attempt}/${MAX_RETRIES}). Backing off this key for 5s...`);
            rateLimitedKeys.set(key, Date.now() + 5000);
            continue; 
          }
          
          throw new Error(error.message || "Failed to generate global content using Gemini.");
        }
      }

      if (attempt < MAX_RETRIES) {
        console.warn(`All keys exhausted on attempt ${attempt}. Waiting 5s before retrying...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    console.error("All API keys are exhausted:", lastError);
    throw new Error("All Gemini API keys have exhausted their quota or are rate limited. Try again later.");
  });

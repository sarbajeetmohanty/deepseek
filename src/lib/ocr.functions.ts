import { createServerFn } from "@tanstack/react-start";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getGeminiApiKeys } from "./settings.functions";

type ExtractPayload = {
  data: string;
  customPrompt?: string | undefined;
};

export const extractTextFromImage = createServerFn({ method: "POST" })
  .validator((d: ExtractPayload) => d)
  .handler(async ({ data: payload }) => {
    const base64Image = payload.data;
    
    // Use the dynamic DB-driven keys from settings instead of hardcoded .env
    const keys = await getGeminiApiKeys();
    const shuffledKeys = [...keys].sort(() => Math.random() - 0.5);

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

    // Retry Waterfall: loop through the shuffled keys until one succeeds
    for (const key of shuffledKeys) {
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
          console.warn("API Key hit a limit or overloaded, failing over to next key...");
          continue; // Instantly retry the extraction with the next key in the array
        }
        
        // If it's a real failure (like an invalid base64 image), throw it immediately
        throw new Error(error.message || "Failed to extract text from image using Gemini.");
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
    const keys = await getGeminiApiKeys();
    const shuffledKeys = [...keys].sort(() => Math.random() - 0.5);

    const prompt = `${payload.customPrompt}\n\nIMPORTANT: Return ONLY the requested content based on the instructions above. Do not include any conversational filler, markdown code blocks, or greetings. Output exactly what is requested.\n\n--- DOCUMENT CONTEXT START ---\n${payload.contextText}\n--- DOCUMENT CONTEXT END ---`;

    let lastError = null;

    for (const key of shuffledKeys) {
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
          console.warn("API Key hit a limit during Global Generation, failing over to next key...");
          continue; 
        }
        
        throw new Error(error.message || "Failed to generate global content using Gemini.");
      }
    }

    console.error("All API keys are exhausted:", lastError);
    throw new Error("All Gemini API keys have exhausted their quota or are rate limited. Try again later.");
  });

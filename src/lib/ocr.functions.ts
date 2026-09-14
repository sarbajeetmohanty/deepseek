import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "../integrations/supabase/auth-middleware";

type ExtractPayload = {
  data: string;
  customPrompt?: string | undefined;
};

type GenerationPayload = {
  contextText: string;
  customPrompt: string;
};

// OCR runs against the SAME Gemini key pool as the batch solver, so it must go
// through the SAME scheduler.
//
// It used to keep a private rotation (`ocrKeyIndex`) and a private cooldown map
// that parked a rate-limited key for 5 seconds against a 60-second window. Two
// schedulers spending one pool, neither aware of the other: OCR quietly ate the
// per-minute allowance the solver had carefully reserved, and its own 5s park
// guaranteed it walked straight back into the same 429. runGeminiTask() below
// borrows the solver's bucket scheduler, so every request in the app - batch or
// OCR - is paced against one shared view of the pool.
import { runGeminiTask } from "./gemini.server";

// Vision work stays on the Gemini Flash-Lite models. gemini-3-flash-preview is
// excluded for the same reason the solver dropped it: a 20-requests-per-day
// grant is not worth a rotation slot. Gemma is text-only, so it is not a
// candidate here at all.
const OCR_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];

// Transcribing a dense exam page produces far more text than solving one MCQ.
const OCR_MAX_OUTPUT_TOKENS = 8192;

// A data: URL declares its own type. The old code stripped the prefix with a
// regex that matched png/jpeg/jpg/webp and then hard-coded mimeType "image/jpeg"
// for all of them, so every PNG and WebP was handed to Gemini mislabelled.
const DATA_URL_RE = /^data:(image\/(?:png|jpeg|jpg|webp));base64,/i;

function splitImagePayload(raw: string): { data: string; mimeType: string } {
  const match = raw.match(DATA_URL_RE);
  if (match) {
    const declared = match[1].toLowerCase();
    return {
      data: raw.slice(match[0].length),
      mimeType: declared === "image/jpg" ? "image/jpeg" : declared,
    };
  }
  // Bare base64 with no prefix - JPEG is the safe default for camera uploads.
  return { data: raw, mimeType: "image/jpeg" };
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
    const { data: base64Data, mimeType } = splitImagePayload(payload.data);

    const prompt = payload.customPrompt
      ? `${payload.customPrompt}\n\nIMPORTANT: Return ONLY the requested content based on the instructions above. Do not include any conversational filler, markdown code blocks, or greetings. Output exactly what is requested.`
      : `Transcribe and digitize all text and questions from this document image accurately.
- Preserve the layout, question numbers, statements (ensure a space after statement numbers, e.g., 1 <text>, 2 <text>), and options (A., B., C., D.) exactly.
- If there is a match-the-column table, transcribe it as two completely separate lists: "Column A:" followed by its items (a., b., c., d.), and "Column B:" followed by its items (1, 2, 3, 4 without dot). NEVER combine rows using '|' or spaces.
- Each statement, code header ('कूट :', 'Code:'), and option (A., B., C., D. or (a), (b), (c), (d)) MUST be on its own separate line.
- Return only the raw extracted text.`;

    const { text } = await runGeminiTask({
      models: OCR_MODELS,
      systemInstruction:
        "You are an OCR and document digitization engine. Accurately transcribe and digitize the document image into text.",
      contents: [{ text: prompt }, { inlineData: { data: base64Data, mimeType } }],
      maxOutputTokens: OCR_MAX_OUTPUT_TOKENS,
      temperature: 0.1,
      topP: 0.95,
      label: "OCR extract",
    });
    return text;
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
    const prompt = `${payload.customPrompt}\n\nIMPORTANT: Return ONLY the requested content based on the instructions above. Do not include any conversational filler, markdown code blocks, or greetings. Output exactly what is requested.\n\n--- DOCUMENT CONTEXT START ---\n${payload.contextText}\n--- DOCUMENT CONTEXT END ---`;

    const { text } = await runGeminiTask({
      models: OCR_MODELS,
      systemInstruction:
        "You are an expert document structuring and question extraction assistant. Digitize, format, and organize the user's provided document questions according to their instructions.",
      contents: [{ text: prompt }],
      maxOutputTokens: OCR_MAX_OUTPUT_TOKENS,
      temperature: 0.1,
      topP: 0.95,
      label: "OCR generate",
    });
    return text;
  });

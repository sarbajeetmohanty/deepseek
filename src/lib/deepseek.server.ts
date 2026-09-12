// Fully decoupled from DeepSeek API: all formatting is handled 100% via the Gemini Multi-Key/Multi-Model Pool.
// Re-exports all prompts, types, and solvers for full backward-compatibility with existing routes and tests.

export * from "./gemini.server";
export { formatQuestionWithGemini as formatQuestionWithDeepSeek } from "./gemini.server";
export { formatQuestionWithGemini as formatQuestionWithDeepSeekNative } from "./gemini.server";
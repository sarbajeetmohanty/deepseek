import "dotenv/config";
import { formatQuestionWithDeepSeek } from "./src/lib/deepseek.server.ts";

async function main() {
  const raw = `406. यदि \\cos A = \\sin^2 A तथा a\\sin^{12} A + b\\sin^{10} A + c\\sin^8 A + \\sin^6 A = 1 है, तो a+b+c = ?`;

  try {
    console.log("Starting DeepSeek formatting...");
    const ctl = new AbortController();
    setTimeout(() => { ctl.abort(); console.log("Aborted after 10s"); }, 10000);
    
    const out = await formatQuestionWithDeepSeek({ raw, idx: 406, signal: ctl.signal });
    console.log("SUCCESS:", out);
  } catch (e) {
    console.error("FAILED:", e);
  }
}
main();

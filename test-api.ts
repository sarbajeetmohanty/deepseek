import { latexToText } from "./src/lib/latex-to-text.ts";

async function main() {
  const raw = `390. \\frac{\\sin\\phi(1 - \\sin\\phi)(\\sin\\phi + \\cos\\phi)(\\sec\\phi + \\tan\\phi)}{\\sin\\phi(1 + \\tan\\phi) + \\cos\\phi(1 + \\cot\\phi)} का मान है।
(a) 2\\cos\\phi
(b) \\text{cosec}\\phi\\sec\\phi
(c) 2\\sin\\phi
(d) \\sin^2\\phi\\cos^2\\phi`;

  try {
    console.log("Starting latexToText...");
    const out = latexToText(raw);
    console.log("SUCCESS:", out);
  } catch (e) {
    console.error("FAILED:", e);
  }
}
main();

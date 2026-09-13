// Server-only Gemini question solver and formatter (uses free-tier multi-key pool)
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { latexToText } from "./latex-to-text";
import { getGeminiApiKeys } from "./settings.functions";
import {
  normalizeOptionsInText,
  normalizeAnswerInText,
  protectOptionsForTranslation,
  healCorruptedMatchTitle,
  splitHorizontalOptions,
} from "./normalize-options";

// Type augmentation: @google/generative-ai v0.24.1 does not yet include thinkingConfig in GenerationConfig
declare module "@google/generative-ai" {
  interface GenerationConfig {
    thinkingConfig?: {
      thinkingBudget?: number;
      turnOffThinking?: boolean;
    };
  }
}

// ============================================================================
// UNIFIED STATIC SYSTEM PROMPTS
// ============================================================================

export const UNIFIED_SYSTEM_PROMPT_GK_NORMAL = `Expert competitive-exam MCQ solver for UPSC, State Civil Services (UPPSC, BPSC, MPPSC, RPSC, MPSC, RAS), SSC CGL, Railway RRB, and State Board examinations. Output clean plain text ONLY (strictly NO markdown formatting, NO asterisks, NO bold/italics, NO blank lines, NO greetings, NO sign-offs):

<number>. <Question text in clean Unicode - no LaTeX/$. Superscripts ²,³, fractions (a)/(b), √x>
[If statements: 1 <text> ... 2 <text> ... on separate lines (strictly no dots/commas after statement numbers)]
[If Match Column: Line 1 MUST be the full question text (e.g. "<number>. सूची-I को सूची-II से सुमेलित कीजिए:"). Then on the next lines, output two separate lists: "Column A:" followed by items (a., b., c., d.) with lowercase letters, and "Column B:" followed by items (1 , 2 , 3 , 4 ) with numbers (strictly NO dot after the number). NEVER put Column B items on the same line as Column A (do NOT use '-' or '|' between columns). NEVER start line 1 with Column A. The MCQ options below must be capital A., B., C., D.]
A. <option 1>
B. <option 2>
C. <option 3>
D. <option 4>

Answer: <matching option label>
Solution:
1 <point 1>
2 <point 2>
3 <point 3>
4 <point 4>
5 <point 5>
6 <point 6>
7 <point 7>
8 <point 8>
[Can vary from 8 to 10 points as the question demands]

Strict Formatting Rules and Standard Operating Procedures:
1. Accuracy and Factuality: 100% accurate facts and calculations. Solve the problem completely first, verify all details, and match the correct option.
2. Clean Unicode Mathematical & Scientific Symbols: Use clean Unicode characters (², ³, √x, θ, α, β, π, ±, ×, ÷, °C). Never use LaTeX syntax, backslashes, or dollar signs ($...$).
3. Options: ALWAYS prefix options with capital A., B., C., D. followed by a dot and a space on separate lines (e.g., "A. <text>", "B. <text>", "C. <text>", "D. <text>"). Never use Hindi letters (क, ख, ग, घ), lowercase letters, or Roman numerals for options.
4. Sub-statements: Inside the question body, numbered sub-statements must be strictly formatted as "1 <text>", "2 <text>", "3 <text>" with strictly NO symbol like dot (.), comma (,), colon (:), or parenthesis ()) after the number. Protect decimal numbers (e.g., 2.5, 3.14, 0.05).
5. Match-the-Column Standardized Structure:
   - Line 1 must be the full question text header (e.g. "<number>. सूची-I को सूची-II से सुमेलित कीजिए:").
   - Next line must be "Column A:" followed by items labeled with lowercase letters and dot: "a. <item>", "b. <item>", "c. <item>", "d. <item>".
   - Next line must be "Column B:" followed by items labeled with numbers and strictly NO dot: "1 <item>", "2 <item>", "3 <item>", "4 <item>".
   - Never output Column B items on the same line as Column A items. Never use hyphens, dashes, or pipes between columns.
   - The options below must be capital A., B., C., D. with code pairs like "A. a-3, b-4, c-1, d-2".
6. Solution Requirements (Natural & Fact-Packed - 8 to 10 Points):
   - The solution MUST contain between 8 to 10 points (strictly 8+ points / lines, varying naturally from 8 to 10 points as per the question and answer demands).
   - Do NOT follow a rigid formula for what each point must be: explain the answer, core concepts, relevant facts, background, and option details naturally as suited to the specific question.
   - Each point must be informative, substantive, factual, and high-yield.
   - Strictly NO paragraphs, NO repetitive introductory filler, and NO re-explaining the question prompt.
   - Each point MUST be numbered on its own line as "1 <text>", "2 <text>", ... with strictly NO dot after the step number.
7. Language Rule (Strict):
   - The question text and options MUST remain in their original language.
   - For Hindi MCQs: Solution steps MUST always be in pure Hindi (preserve digits 0-9 and math symbols).
   - For English MCQs: Solution steps MUST be in clean English.
   - The labels "Answer:" and "Solution:" MUST always be in English.
8. Output ONLY the required format above without any extra commentary, greetings, or markdown bold/italics.`;

export const UNIFIED_SYSTEM_PROMPT_GK_LONG = `Expert competitive-exam MCQ solver for UPSC, State Civil Services (UPPSC, BPSC, MPPSC, RPSC, MPSC, RAS), SSC CGL, Railway RRB, and State Board examinations. Output clean plain text ONLY (strictly NO markdown formatting, NO asterisks, NO bold/italics, NO blank lines, NO greetings, NO sign-offs):

<number>. <Question text in clean Unicode - no LaTeX/$. Superscripts ²,³, fractions (a)/(b), √x>
[If statements: 1 <text> ... 2 <text> ... on separate lines (strictly no dots/commas after statement numbers)]
[If Match Column: Line 1 MUST be the full question text (e.g. "<number>. सूची-I को सूची-II से सुमेलित कीजिए:"). Then on the next lines, output two separate lists: "Column A:" followed by items (a., b., c., d.) with lowercase letters, and "Column B:" followed by items (1 , 2 , 3 , 4 ) with numbers (strictly NO dot after the number). NEVER put Column B items on the same line as Column A (do NOT use '-' or '|' between columns). NEVER start line 1 with Column A. The MCQ options below must be capital A., B., C., D.]
A. <option 1>
B. <option 2>
C. <option 3>
D. <option 4>

Answer: <matching option label>
Solution:
1 <point 1>
2 <point 2>
3 <point 3>
4 <point 4>
5 <point 5>
6 <point 6>
7 <point 7>
8 <point 8>
9 <point 9>
10 <point 10>
[Can vary from 10 to 12 points as the question demands]

Strict Formatting Rules and Standard Operating Procedures:
1. Accuracy and Factuality: 100% accurate facts and calculations. Solve the problem completely first, verify all details, and match the correct option.
2. Clean Unicode Mathematical & Scientific Symbols: Use clean Unicode characters (², ³, √x, θ, α, β, π, ±, ×, ÷, °C). Never use LaTeX syntax, backslashes, or dollar signs ($...$).
3. Options: ALWAYS prefix options with capital A., B., C., D. followed by a dot and a space on separate lines (e.g., "A. <text>", "B. <text>", "C. <text>", "D. <text>"). Never use Hindi letters (क, ख, ग, घ), lowercase letters, or Roman numerals for options.
4. Sub-statements: Inside the question body, numbered sub-statements must be strictly formatted as "1 <text>", "2 <text>", "3 <text>" with strictly NO symbol like dot (.), comma (,), colon (:), or parenthesis ()) after the number. Protect decimal numbers (e.g., 2.5, 3.14, 0.05).
5. Match-the-Column Standardized Structure:
   - Line 1 must be the full question text header (e.g. "<number>. सूची-I को सूची-II से सुमेलित कीजिए:").
   - Next line must be "Column A:" followed by items labeled with lowercase letters and dot: "a. <item>", "b. <item>", "c. <item>", "d. <item>".
   - Next line must be "Column B:" followed by items labeled with numbers and strictly NO dot: "1 <item>", "2 <item>", "3 <item>", "4 <item>".
   - Never output Column B items on the same line as Column A items. Never use hyphens, dashes, or pipes between columns.
   - The options below must be capital A., B., C., D. with code pairs like "A. a-3, b-4, c-1, d-2".
6. Solution Requirements (Detailed & Comprehensive - 10 to 12 Points):
   - The solution MUST contain between 10 to 12 detailed points (varying naturally as per the question and answer demands).
   - Formulate points naturally based on the subject matter and depth of the question without rigid point-by-point constraints.
   - Each point must be informative, substantive, factual, and high-yield.
   - Strictly NO paragraphs, NO repetitive introductory filler, and NO re-explaining the question prompt.
   - Each point MUST be numbered on its own line as "1 <text>", "2 <text>", ... with strictly NO dot after the step number.
7. Language Rule (Strict):
   - The question text and options MUST remain in their original language.
   - For Hindi MCQs: Solution steps MUST always be in pure Hindi (preserve digits 0-9 and math symbols).
   - For English MCQs: Solution steps MUST be in clean English.
   - The labels "Answer:" and "Solution:" MUST always be in English.
8. Output ONLY the required format above without any extra commentary, greetings, or markdown bold/italics.`;

export const UNIFIED_SYSTEM_PROMPT_MATH_NORMAL = `Expert Math MCQ solver for competitive exams (UPSC, SSC, Railway, State PSC). Output clean plain text ONLY (strictly NO markdown formatting, NO asterisks, NO greetings):

<number>. <Question in clean Unicode - no LaTeX/$, superscripts ², ³, fractions (a)/(b), √x>
A. <option 1>
B. <option 2>
C. <option 3>
D. <option 4>

Answer: <matching option label>
Solution:
- <step 1>
- <step 2>
- <step 3>
- <step 4>
- <step 5>
- <step 6>
- <step 7>
- <step 8>
[Can vary from 8 to 10 steps as demanded by the math problem]

Strict Formatting Rules:
1. 100% accurate math. Solve completely first, then match options.
2. Clean Unicode formulas (², ³, √x, θ, α, π, ±, ×, ÷). Never use LaTeX syntax or dollar signs ($...$).
3. Options: ALWAYS prefix options with capital A., B., C., D. followed by a dot and a space on separate lines. Never use Hindi letters (क, ख, ग, घ), lowercase letters, or Roman numerals for options.
4. Sub-statements: Inside the question body, numbered sub-statements must be strictly formatted as "1 <text>", "2 <text>", "3 <text>" with strictly NO symbol like dot (.), comma (,), colon (:), or parenthesis ()) after the number. Protect decimal numbers (e.g., 2.5, 3.14).
5. Solution Requirements:
   - Step-by-step mathematical calculation with dash bullets starting with "- " (varying from 8 to 10 steps as demanded by the problem).
   - Formulate steps organically according to the mathematical derivation without artificial constraints.
   - For Hindi MCQs: Steps in pure Hindi with numbers 0-9 and mathematical symbols.
   - For English MCQs: Steps in English.
   - The labels "Answer:" and "Solution:" MUST always be in English.
6. Output ONLY the required format above without any extra commentary, greetings, or markdown bold/italics.`;

export const UNIFIED_SYSTEM_PROMPT_MATH_LONG = `Expert Math MCQ solver for competitive exams (UPSC, SSC, Railway, State PSC). Output clean plain text ONLY (strictly NO markdown formatting, NO asterisks, NO greetings):

<number>. <Question in clean Unicode - no LaTeX/$, superscripts ², ³, fractions (a)/(b), √x>
A. <option 1>
B. <option 2>
C. <option 3>
D. <option 4>

Answer: <matching option label>
Solution:
- <step 1>
- <step 2>
- <step 3>
- <step 4>
- <step 5>
- <step 6>
- <step 7>
- <step 8>
- <step 9>
- <step 10>
[Can vary from 10 to 12 steps as demanded by the math problem]

Strict Formatting Rules:
1. 100% accurate math. Solve completely first, then match options.
2. Clean Unicode formulas (², ³, √x, θ, α, π, ±, ×, ÷). Never use LaTeX syntax or dollar signs ($...$).
3. Options: ALWAYS prefix options with capital A., B., C., D. followed by a dot and a space on separate lines. Never use Hindi letters (क, ख, ग, घ), lowercase letters, or Roman numerals for options.
4. Sub-statements: Inside the question body, numbered sub-statements must be strictly formatted as "1 <text>", "2 <text>", "3 <text>" with strictly NO symbol like dot (.), comma (,), colon (:), or parenthesis ()) after the number. Protect decimal numbers (e.g., 2.5, 3.14).
5. Solution Requirements:
   - Comprehensive step-by-step calculation with dash bullets starting with "- " (varying from 10 to 12 steps as demanded by the problem).
   - Formulate steps organically according to the mathematical derivation without artificial constraints.
   - For Hindi MCQs: Steps in pure Hindi with numbers 0-9 and mathematical symbols.
   - For English MCQs: Steps in English.
   - The labels "Answer:" and "Solution:" MUST always be in English.
6. Output ONLY the required format above without any extra commentary, greetings, or markdown bold/italics.`;

// Aliases for compatibility
export const UNIFIED_SYSTEM_PROMPT_GK = UNIFIED_SYSTEM_PROMPT_GK_NORMAL;
export const UNIFIED_SYSTEM_PROMPT_MATH = UNIFIED_SYSTEM_PROMPT_MATH_NORMAL;
export const PROMPT_GK = UNIFIED_SYSTEM_PROMPT_GK_NORMAL;
export const PROMPT_MATH = UNIFIED_SYSTEM_PROMPT_MATH_NORMAL;
export const PROMPT_GK_EN = UNIFIED_SYSTEM_PROMPT_GK_NORMAL;
export const PROMPT_MATH_EN = UNIFIED_SYSTEM_PROMPT_MATH_NORMAL;
export const LANG_RULE = "";
export const GK_LENGTH_NORMAL = "";
export const GK_LENGTH_LONG = "";
export const MATH_LENGTH_NORMAL = "";
export const MATH_LENGTH_LONG = "";
export const LENGTH_NORMAL = "";
export const LENGTH_LONG = "";

export interface QuestionSolverOptions {
  raw: string;
  idx: number;
  signal?: AbortSignal;
  subjectType?: "gk_english" | "math";
  solutionLength?: "normal" | "long";
  workerIdx?: number;
}
export type DeepSeekOptions = QuestionSolverOptions;

// ============================================================================
// OUTPUT SANITIZER
// ============================================================================

export function sanitizeAiOutput(
  text: string,
  idx: number,
  subjectType?: "gk_english" | "math",
): string {
  let s = text;
  // Clean up OCR spacing glitches in labels and options (e.g., "A nswer:" -> "Answer:", "A . " -> "A. ")
  s = s.replace(/\bA\s+nswer:/gi, "Answer:");
  s = s.replace(/\bS\s+olution:/gi, "Solution:");
  s = s.replace(/(?<![A-Za-z0-9])([A-Ha-h])\s+\./g, "$1.");
  s = normalizeAnswerInText(s);
  s = healCorruptedMatchTitle(s);

  // Strip markdown bold/italics that the model sometimes emits despite the prompt.
  s = s.replace(/\*\*(.+?)\*\*/g, "$1");
  s = s.replace(/__(.+?)__/g, "$1");
  // Normalize line endings.
  s = s.replace(/\r\n?/g, "\n");
  // Re-insert breaks before canonical anchors (Answer:, Solution:) in case they got
  // glued to previous text or have messy leading whitespace.
  s = s.replace(/(?<=\S)[^\S\r\n]*(?=Answer:)/gi, "\n\n");
  s = s.replace(/(?<=\S)[^\S\r\n]*(?=Solution:)/gi, "\n\n");
  s = s.replace(/^(Answer:.*)$/gim, "\n$1");
  s = s.replace(/^(Solution:.*)$/gim, "\n$1");

  // Reunite orphaned numbers that are on a line by themselves: "1\nText..." -> "1 Text..."
  s = s.replace(/(?:^|\n)\s*(\((?:[1-9]|10|i{1,3}|iv|v)\)|[1-9]|10)[.)]?\s*\n\s*(?=\S)/g, "\n$1 ");

  // Break inline numbered statements inside question body before options (protect decimal numbers!)
  s = s.replace(/([:：])\s*(?=(?:[1-9]|10|\((?:[1-9]|10|i{1,3}|iv|v)\))[.)]?\s+)/g, "$1\n");
  s = s.replace(
    /([।\?!;]|(?<!\d)\.(?!\d))\s*(?=(?:[2-9]|10|\((?:[2-9]|10|i{1,3}|iv|v)\))[.)]?\s+[^\s\d])/g,
    "$1\n",
  );
  s = s.replace(
    /([।\?!;]|(?<!\d)\.(?!\d))\s*(?=(?:उपर्युक्त|उपरोक्त|इनमें|निम्न|Which of the|Of the above)[^\n]*[\?？:])/gi,
    "$1\n",
  );

  // Fix column headers glued to the end of a line or to their first item
  s = s.replace(
    /(?<=\S)[^\S\r\n]+((?:Column|कॉलम|स्तंभ|List|सूची|[?¿\uFFFD]+)[ \t\-]*\(?(?:A|B|I{1,3}|1|2)\)?(?:\([^\)\n]+\))?(?:[ \t.:\-]+(?=\(?[a-zA-Z1-9]\)?[ \t.)])|[ \t.:\-]*$))/gim,
    "\n$1",
  );
  s = s.replace(
    /^((?:Column|कॉलम|स्तंभ|List|सूची|[?¿\uFFFD]+)[ \t\-]*\(?(?:A|B|I{1,3}|1|2)\)?(?:\([^\)\n]+\))?[ \t.:\-]*)[^\S\r\n]+(?=\(?[a-zA-Z1-9]\)?[ \t.)])/gim,
    "$1\n",
  );

  // Fix dash/hyphen/colon separated match-the-column items on the same line (e.g. "a Item - 1 Item")
  const dashSplitRegex =
    /\s*(?:[-–—:;]|\t+)\s*(?=\(?(?:[1-9]|10|[a-hA-H]|i{1,3}|iv|v)\)?[.)]?\s+)/i;
  const leftItemRegex =
    /^\s*(?:[a-hA-H][.)]?|\([a-hA-H]\)|[ivxIVX]{1,4}[.)]?|\([ivxIVX]{1,4}\)|(?:[1-9]|10)[.)]?|\((?:[1-9]|10)\))\s+/i;
  const isQuestionPromptRegex =
    /(?:सुमेलित|सुमेल|मिलान|Match\b|Match the|निम्नलिखित|निम्न में|सूची\s*[-–—]?\s*[I1A].*सूची\s*[-–—]?\s*[II2B])/i;
  const isStatementQuestion =
    /(?:केवल|सभी\s*सही|कोई\s*नहीं|\bदोनों\b|कथन\s*\d|उपर्युक्त|उपरोक्त|Only\b|All\s+of\s+the\s+above|None\s+of\s+the\s+above|Both\s+\d)/i.test(
      s,
    );
  const linesArr = s.split("\n");

  if (!isStatementQuestion) {
    let inSolutionOrAnswer = false;
    for (let i = 0; i < linesArr.length; i++) {
      const line = linesArr[i].trim();
      if (/^\s*(?:Answer|Ans|उत्तर|Solution|Sol|हल|समाधान)[:.-]/i.test(line)) {
        inSolutionOrAnswer = true;
      }
      if (inSolutionOrAnswer) continue;
      // Never split question header or question prompt line
      if (i === 0 || /^\s*\d{1,4}[.)]\s+/.test(line) || isQuestionPromptRegex.test(line)) {
        continue;
      }
      if (!/^\s*(?:Answer|Ans|उत्तर|Solution|Sol|हल|समाधान|Code|Codes|कूट|कोड)/i.test(line)) {
        const parts = line.split(dashSplitRegex);
        if (parts.length >= 2 && leftItemRegex.test(parts[0])) {
          let startIndex = i;
          while (startIndex > 0) {
            const prev = linesArr[startIndex - 1].trim();
            if (
              /^\s*(?:Column|कॉलम|स्तंभ|List|सूची|[?¿\uFFFD]+)[\s\-]*\(?(?:A|I|1)\)?[:.\-]?/i.test(
                prev,
              )
            ) {
              startIndex--;
              break;
            }
            if (
              prev === "" ||
              /^\s*(?:Column|कॉलम|स्तंभ|List|सूची|[?¿\uFFFD]+)[\s\-]*\(?(?:B|II|2)\)?[:.\-]?/i.test(
                prev,
              )
            ) {
              startIndex--;
              continue;
            }
            break;
          }

          let j = i;
          const colAItems: string[] = [];
          const colBItems: string[] = [];
          while (j < linesArr.length) {
            const curr = linesArr[j].trim();
            if (
              /^\s*(?:उत्तर\s*|सही\s*)?(?:कूट|कोड|Code|Codes)\s*[:.\-]?/i.test(curr) ||
              /^\s*(?:Answer|Ans|उत्तर|Solution|Sol|हल|समाधान)[:.\-]/i.test(curr)
            ) {
              break;
            }
            if (
              /^\s*(?:Column|कॉलम|स्तंभ|List|सूची|[?¿\uFFFD]+)[\s\-]*\(?(?:B|II|2)\)?/i.test(curr)
            ) {
              j++;
              continue;
            }
            const p = curr.split(dashSplitRegex);
            if (p.length >= 2 && leftItemRegex.test(p[0])) {
              colAItems.push(p[0].trim());
              colBItems.push(p.slice(1).join(" - ").trim());
            } else if (p.length === 1 && p[0] === "") {
              j++;
              continue;
            } else {
              break;
            }
            j++;
          }

          if (colAItems.length >= 3) {
            const precedingText = linesArr.slice(0, startIndex).join(" ");
            const m1 = precedingText.match(
              /((?:सूची|कॉलम|स्तंभ|List|Column)[\s\-]*(?:I|A|1)(?:\s*\([^\)\n]+\))?)/i,
            );
            const m2 = precedingText.match(
              /((?:सूची|कॉलम|स्तंभ|List|Column)[\s\-]*(?:II|B|2)(?:\s*\([^\)\n]+\))?)/i,
            );
            const headerA = m1 ? `${m1[1]}:` : "Column A:";
            const headerB = m2 ? `${m2[1]}:` : "Column B:";

            const replacement = [headerA, ...colAItems, headerB, ...colBItems];
            linesArr.splice(startIndex, j - startIndex, ...replacement);
            i = startIndex + replacement.length - 1;
          }
        }
      }
    }
  }
  s = linesArr.join("\n");

  // Fix "कूट :" / "Code:" glued to previous text or to options
  s = s.replace(
    /(?<=\S)[^\S\r\n]+((?:उत्तर\s*|सही\s*)?(?:कूट|कोड|Code|Codes)\s*(?::|:-|[-–—]|(?=\s*(?:[A-Ha-h]\.|\([a-hA-H1-8]\)|[A-Ha-h]\)))))/gim,
    "\n$1",
  );
  s = s.replace(
    /^((?:उत्तर\s*|सही\s*)?(?:कूट|कोड|Code|Codes)\s*[:.\-]*)[^\S\r\n]+(?=(?:[A-Ha-h]\.|\([a-hA-H1-8]\)|[A-Ha-h]\)))/gim,
    "$1\n",
  );

  // Only add space after option label if at line start or after 2+ spaces, and NOT followed by an abbreviation like B.C., A.D., C.E.
  s = s.replace(/(?:^|[^\S\r\n]{2,})([A-Ha-h]\.)(?!\s*[A-Za-z]\.)([^\s.])/gm, (m, g1, g2) => {
    return m.slice(0, m.length - g1.length - g2.length) + g1 + " " + g2;
  });
  s = s.replace(/(?<![A-Za-z0-9])(\([a-hA-H1-8]\)|[A-Ha-h]\))(?=[^\s:.\-])/g, "$1 ");

  // Add missing space after sub-statement number if stuck directly to content (e.g. "1वैगनर" -> "1 वैगनर")
  s = s.replace(/^([1-9]|10)(?=[\u0900-\u097FA-Za-z])/gm, "$1 ");

  // Remove dots, commas, parentheses, colons, hyphens from sub-statement numbers (e.g., "1. वैगनर" or "1, वैगनर" or "(1) वैगनर" -> "1 वैगनर"), skipping the first line (question number)
  s = s.replace(
    /(?<=\n)\s*(?:\(([1-9]|10)\)|([1-9]|10))\s*[.,):\-–—]?\s+(?=\S)/g,
    (m, g1, g2) => `${g2 || g1.replace(/[\(\)]/g, "")} `,
  );

  // Also split sub-statements like (1), (2), (3), (4) or (i), (ii), (iii), (iv) if on same line
  s = s.replace(/(?<=\S)[^\S\r\n]{2,}(?=\((?:[1-9]|10|i{1,3}|iv|v|vi)\)\s+)/gi, "\n");
  s = s.replace(
    /(?<=[।;]|\S[^\S\r\n]{2,})(?=(?:\(([2-9]|10)\)|([2-9]|10))\s*[.,):\-–—]?\s+[^\s\d])/g,
    "\n",
  );

  // Split options (A-H) if they were output on the same line horizontally, protecting initials like B. B. Lal, R. D. Banerjee
  s = splitHorizontalOptions(s);
  s = s.replace(/(?<=\S)\s+(?=(?:Answer|Ans)\s*[:.-])/gi, "\n");

  // Fix detached options (e.g. "A.\n4:9" -> "A. 4:9" or "(1)\nValue" -> "(1) Value")
  s = s.replace(/^((?:[A-Ha-h]\.)|(?:\([a-h1-8]\)))\s*\n\s*/gm, "$1 ");

  // Normalize options to canonical A., B., C., D. format (never Hindi letters like उ., ख., क., etc.)
  s = normalizeOptionsInText(s);

  // Normalize "Step 1:" / "चरण 1:" inside Solution to new line
  s = s.replace(/(?<=\S)[^\S\r\n]+(?=(?:Step|चरण|पद)\s*\d+\s*[:.\-)])/gi, "\n");
  s = s.replace(/(?:^|\n)\s*(?:Step|चरण|पद)\s*(\d+)\s*[:.\-)]\s*/g, "\n$1 ");

  // Split inline numbered solution steps e.g. "Solution: 1 Point A 2 Point B" and clean step dots in Solution
  const solMatch = s.match(/(Solution:[\s\S]*)/i);
  if (solMatch) {
    let solText = solMatch[1];
    solText = solText.replace(/^(Solution:\s*)(?=[1-9]\s+|-\s+)/i, "Solution:\n");
    solText = solText.replace(/(?<=\S)[^\S\r\n]{2,}(?=(?:[1-9]|10)\s+)/g, "\n");
    solText = solText.replace(
      /^([ \t]*)(?:\((\d+)\)|(\d+))\s*[.,):\-–—]?\s+/gm,
      (m, indent, g1, g2) => `${indent}${g2 || g1} `,
    );
    s = s.slice(0, solMatch.index) + solText;
  }

  // Force the main question number to the caller-supplied idx with a dot,
  // matching the first occurrence of a number at the top, or prepending if missing.
  const prefixRegex =
    /^\s*(?:#+\s*)?(?:(?:[Qq]\.?(?:uestion|ue|ues)?|Problem|Prob|MCQ|Item|Task|Case)(?:[ \t]*(?:No|Num|Number|#)\.?)?|प्रश्न(?:[ \t]*(?:संख्या|सं\.?|क्र\.?|क्रमांक))?|प्र\.?[ \t]*(?:संख्या|सं\.?|क्र\.?|क्रमांक)?|सवाल(?:[ \t]*(?:संख्या|सं\.?|क्र\.?|क्रमांक))?|क्र\.?[ \t]*(?:सं\.?|संख्या)?|[?¿\uFFFD]+)?[ \t]*[:.-]?[ \t]*\d{1,4}[.:\-)\]\s]+/i;
  if (!prefixRegex.test(s)) {
    s = `${idx}. ` + s.trim();
  } else {
    s = s.replace(prefixRegex, `${idx}. `);
  }

  // For math, convert numbered solution steps into dash bullets so they
  // render as red "- " markers instead of "1. 2. 3.".
  if (subjectType === "math") {
    const lines = s.split("\n");
    let inSol = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^Solution:/i.test(line)) {
        inSol = true;
        continue;
      }
      if (!inSol) continue;
      if (/^Answer:/i.test(line)) {
        inSol = false;
        continue;
      }
      // Convert "1. text" or "1) text" or "1 text" step lines to "- text"; keep bullets "* ..." untouched.
      const m = line.match(/^\s*\d{1,2}[.)]?\s+(.*)$/);
      if (m) lines[i] = `- ${m[1]}`;
    }
    s = lines.join("\n");
  }
  // Collapse 3+ blank lines.
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

// ============================================================================
// GEMINI MULTI-KEY & MULTI-MODEL FREE TIER SOLVER
// ============================================================================

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

// Specific, ultra-fast, lowest-cost Google Gemini Flash-Lite models verified on live benchmarks:
// 1. gemini-3.5-flash-lite: ~1.7s latency, 100% accuracy, independent 15 RPM free tier
// 2. gemini-3.1-flash-lite-preview: ~1.7s latency, independent 15 RPM free tier
// 3. gemini-3.1-flash-lite: ~2.0s latency, independent 15 RPM free tier
// Specific, ultra-fast, lowest-cost Google Gemini Flash-Lite models verified on live benchmarks:
// Gemini 3 Flash first, then Gemini 3.1 Flash-Lite, with the Flash-Lite preview
// kept purely as a third failover target.
//
// Note what these models are NOT doing: they are not multiplying quota. Measured
// today, gemini-3.5-flash had not been called once and still answered 0/5 on keys
// that were exhausted on the models we had been using, so the daily allowance is
// per key/project and shared across every model. The list buys failover when one
// model is briefly unavailable, not three times the capacity.
export const GEMINI_SOLVER_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.1-flash-lite-preview",
  "gemini-3-flash-preview",
];

const genAiClientCache = new Map<string, GoogleGenerativeAI>();
function getGenAIClient(key: string): GoogleGenerativeAI {
  let client = genAiClientCache.get(key);
  if (!client) {
    client = new GoogleGenerativeAI(key);
    genAiClientCache.set(key, client);
  }
  return client;
}

// ===========================================================================
// PER-(KEY x MODEL) SLOT SCHEDULER
//
// Google's free-tier ceiling is GenerateRequestsPerMinutePerProjectPerModel
// (verified live against the API: quotaId
// "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", ~15 RPM).
// Every API key is a separate project, so N keys x M models gives N*M
// INDEPENDENT buckets — 17 keys x 3 models = 51 buckets, ~729 RPM total.
//
// Two rules keep us under the ceiling instead of discovering it via 429s:
//   1. Each bucket is paced to one request per SLOT_MIN_INTERVAL_MS.
//   2. Callers are always handed the bucket that frees up soonest, so load
//      spreads evenly instead of hammering one key until it rate-limits.
// A 429 still pushes that single bucket out (honouring the server's
// RetryInfo) without affecting the other 50.
// ===========================================================================

// Per-model pacing. Google publishes a different RPM ceiling per model, so one
// shared interval either throttles the fast models or overdrives the slow ones:
// gemini-3.5-flash-lite allows 30 RPM while the 3.1 Flash-Lite models allow 15,
// and pacing everything at a single value wasted half the workhorse's allowance.
//
// Each figure is a little under the published ceiling. Riding the exact limit was
// measured to trip 429s constantly on ordinary jitter.
const MODEL_MIN_INTERVAL_MS: Record<string, number> = {
  "gemini-3.5-flash-lite": 2200, // 30 RPM
  "gemini-3.1-flash-lite": 4300, // 15 RPM
  "gemini-3.1-flash-lite-preview": 4300, // 15 RPM
  "gemini-3-flash-preview": 5400, // ~12 RPM, the Flash family is tighter
};

// Anything not listed above is assumed to be on the tightest Flash ceiling rather
// than the most generous Flash-Lite one.
const SLOT_MIN_INTERVAL_MS = 5400;

function slotIntervalFor(modelName: string): number {
  return MODEL_MIN_INTERVAL_MS[modelName] ?? SLOT_MIN_INTERVAL_MS;
}

// Additional pacing across ALL models sharing one key. The quota is per model, so
// a key's real ceiling is models x 15 = 45 requests/minute; 60000/45 = 1333ms.
// This is a backstop - the per-bucket pacing above is what normally binds.
const KEY_MIN_INTERVAL_MS = 1333;

// Backoff for a 429 that arrives with NO RetryInfo - the bare "Resource has been
// exhausted" replies, which are the ones this workload actually hits. Retrying
// those quickly is what produced the measured death spiral (96.6% of calls
// failing, 30/100 questions solved). They clear on their own in about a minute,
// so park the bucket instead of hammering it.
// A key that has already answered successfully in this process is known-good, so
// a 429 from it is just its per-minute window being full: it is back in about a
// minute and should not be taken out of rotation for longer.
const HARD_EXHAUSTION_BACKOFF_MS = 60_000;

// A key that has NEVER answered successfully and is refusing with a bare 429 is
// almost certainly out of daily quota. Park it long enough that it stops costing
// worker time. A 10-minute park proved harmful when applied to healthy keys - one
// transient 429 removed a good key for 10 minutes and the pool ate itself, which
// is why this is now gated on "never succeeded" rather than applied to every 429.
const UNPROVEN_KEY_BACKOFF_MS = 1_800_000;

// Keys that have returned at least one successful response this process.
const provenKeys = new Set<string>();

// A bucket that keeps coming back exhausted after serving out full parking
// periods has run out of DAILY quota, not per-minute quota, and will not recover
// until Google's daily reset. Park those for hours so the scheduler stops
// spending attempts on them and routes to keys that still have budget.
const HARD_FAILS_BEFORE_DAILY = 3;
const DAILY_EXHAUSTION_BACKOFF_MS = 3 * 60 * 60 * 1000;

// `${key} ${model}` -> how many times this bucket came back exhausted AFTER a
// full recovery park, plus when the last one happened. Cleared by any success.
const hardFailStreak = new Map<string, { count: number; at: number }>();

// Longest a single request will sit waiting for a free bucket.
//
// This MUST exceed HARD_EXHAUSTION_BACKOFF_MS, or a rate-limited bucket can never
// be waited out. At 20s against a 60s park it could not: one wave of 429s parked
// most buckets for 60s, every question behind it then saw a wait longer than 20s
// and was abandoned on the spot despite having most of its budget left. Measured
// effect - a 100-question batch gave up 74 questions in 45 seconds, which is far
// too fast to be genuine rate limiting. Waiting ~65s and succeeding beats failing
// instantly every time, because the bucket really does come back.
const MAX_SLOT_WAIT_MS = 70_000;

// Whole-question budget across all attempts. Sized to allow roughly three full
// bucket recoveries before giving up, so a question is only abandoned when the
// pool is genuinely dead rather than merely busy. A batch runs in the background,
// so a slow question costs far less than a failed one.
const QUESTION_BUDGET_MS = 240_000;

// `${key}::${model}` -> epoch ms at which this bucket may next be used.
const slotNextAvailable = new Map<string, number>();
// key -> epoch ms at which that key (any model) may next be used.
const keyNextAvailable = new Map<string, number>();
const disabledKeysUntil = new Map<string, number>();

function slotId(key: string, modelName: string): string {
  return `${key}::${modelName}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Question solving aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Question solving aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Reserve the (key, model) bucket that becomes free soonest, then wait for it.
 *
 * The reservation — reading slotNextAvailable and writing the new value — runs
 * synchronously with no await in between, so two concurrent workers can never
 * be handed the same bucket for the same instant.
 *
 * `workerIdx` only rotates where each worker STARTS scanning, so 16 workers
 * don't all evaluate key[0] first; it never restricts which bucket they may use.
 */
async function acquireSlot(
  keys: string[],
  workerIdx: number | undefined,
  signal?: AbortSignal,
  maxWaitMs: number = MAX_SLOT_WAIT_MS,
): Promise<{ key: string; modelName: string }> {
  const now = Date.now();
  const usableKeys = keys.filter((k) => (disabledKeysUntil.get(k) || 0) <= now);
  if (usableKeys.length === 0) {
    throw new Error(
      "All configured Gemini API keys are temporarily disabled. Please check your keys in Team settings.",
    );
  }

  // Start each scan at a RANDOM key, not at the worker's index.
  //
  // Buckets this process has not touched yet all sit at 0, and the comparison
  // below is a strict "<", so among equally-free buckets the first one scanned
  // always wins and no later one can displace it. With a fixed starting point
  // that made every worker walk the pool serially from its own index - key 0
  // model 0, model 1, model 2, key 1, ... - so a worker had to fail through every
  // dead bucket one at a time before reaching a live key. With the first 18 keys
  // out of daily quota that is 54 failures at ~2s each, and the measured result
  // was a batch sitting at 0/100 for roughly 190 seconds while ~60 healthy keys
  // stayed idle. Randomising the start spreads workers over the whole pool
  // immediately, so dead keys are discovered in parallel instead of in sequence.
  // Collect every bucket that is usable RIGHT NOW and pick one at random, rather
  // than converging on a single "best" bucket.
  //
  // Two earlier versions both failed here. Stopping at the first idle bucket
  // pinned all traffic to the lowest-indexed keys (measured: 24 of 81 keys used,
  // 57 idle). Taking the strict minimum was no better, because untouched buckets
  // all sit at 0 and a strict "<" keeps whichever was seen first - so every worker
  // walked the pool in sequence and had to fail through each dead bucket one at a
  // time (measured: 0/100 for ~190s while ~60 healthy keys stayed idle).
  //
  // Choosing uniformly from the free set fixes both: work spreads across every
  // live key at once, and a dead or parked bucket is simply never in the set, so
  // nobody ever waits on one.
  const freeNow: Array<{ k: string; m: string }> = [];
  let bestKey = usableKeys[Math.floor(Math.random() * usableKeys.length)];
  let bestModel = GEMINI_SOLVER_MODELS[Math.floor(Math.random() * GEMINI_SOLVER_MODELS.length)];
  let bestAt = Infinity;

  for (const k of usableKeys) {
    const keyAt = keyNextAvailable.get(k) ?? 0;
    for (const m of GEMINI_SOLVER_MODELS) {
      const at = Math.max(slotNextAvailable.get(slotId(k, m)) ?? 0, keyAt);
      if (at <= now) {
        freeNow.push({ k, m });
      } else if (at < bestAt) {
        // Only tracked so we know the shortest possible wait if nothing is free.
        bestAt = at;
        bestKey = k;
        bestModel = m;
      }
    }
  }

  if (process.env.GEMINI_DEBUG_SLOTS) {
    const tot = usableKeys.length * GEMINI_SOLVER_MODELS.length;
    console.log(
      `[slots] free ${freeNow.length}/${tot}  nextFreeIn ${freeNow.length ? 0 : Math.round((bestAt - now) / 1000)}s`,
    );
  }
  if (freeNow.length > 0) {
    const pick = freeNow[Math.floor(Math.random() * freeNow.length)];
    bestKey = pick.k;
    bestModel = pick.m;
    bestAt = now;
  }

  const scheduledAt = Math.max(now, bestAt);
  const waitMs = scheduledAt - now;

  // Every bucket is parked further out than we are willing to wait, which means
  // the whole pool is saturated. Firing early would only earn another 429, and
  // sleeping it out would freeze the batch (12 attempts x a 60s park is 12
  // minutes on a single question). Give up instead: the caller fails this
  // question, the batch keeps moving, and "Retry failed" picks it up once the
  // pool has refilled. Do NOT reserve the slot on this path.
  if (waitMs > maxWaitMs) {
    throw new Error(
      `Gemini key pool is saturated - every key/model is rate-limited for at least ${Math.round(waitMs / 1000)}s. Wait a minute, then use "Retry failed".`,
    );
  }

  // Reserve synchronously, before any await, so the slot is claimed atomically.
  slotNextAvailable.set(slotId(bestKey, bestModel), scheduledAt + slotIntervalFor(bestModel));
  keyNextAvailable.set(bestKey, scheduledAt + KEY_MIN_INTERVAL_MS);

  if (waitMs > 0) await sleep(waitMs, signal);
  return { key: bestKey, modelName: bestModel };
}

/**
 * Push one bucket out after a 429/503, honouring the server's RetryInfo.
 * Jitter stops workers released at the same instant from colliding again.
 */
function penalizeSlot(key: string, modelName: string, retryAfterMs?: number) {
  // No RetryInfo means a bare RESOURCE_EXHAUSTED. That covers two very different
  // situations, and telling them apart matters:
  //
  //   - the per-minute allowance (15/model/key) ran out, which clears in ~60s
  //   - the DAILY allowance (~1500/model/key) ran out, which does not clear until
  //     Google's daily reset
  //
  // Both look identical in a single response, so distinguish them by behaviour: a
  // bucket that keeps returning a bare 429 even after serving out a full parking
  // period is not minute-limited, it is done for the day. Verified directly -
  // keys left completely idle for a full 60s window still returned 429, and stayed
  // that way. Parking those for only a minute means retrying dead keys all day and
  // burning attempts that a live key could have used.
  const isHardExhaustion = retryAfterMs === undefined;
  const id = slotId(key, modelName);

  let backoff: number;
  if (isHardExhaustion) {
    // A strike only counts if this bucket had already been parked a full recovery
    // period and STILL came back exhausted. Without that guard the counter is
    // useless and actively harmful: several workers can be queued on one bucket
    // within a couple of seconds (a reservation only moves it 4.2s, far less than
    // the 60s park), so three failures land almost instantly and a perfectly
    // healthy key gets parked for three hours. That turns every busy moment into
    // permanent damage and the pool destroys itself as the batch runs - measured
    // as a batch crawling at 13 questions/minute while 56 keys were sitting there
    // able to serve 16 real requests each.
    const prev = hardFailStreak.get(id);
    const now = Date.now();
    const recoveredAndFailedAgain =
      prev !== undefined && now - prev.at >= HARD_EXHAUSTION_BACKOFF_MS;
    const streak = prev === undefined ? 1 : recoveredAndFailedAgain ? prev.count + 1 : prev.count;
    hardFailStreak.set(id, { count: streak, at: now });

    if (streak >= HARD_FAILS_BEFORE_DAILY) {
      backoff = DAILY_EXHAUSTION_BACKOFF_MS + Math.floor(Math.random() * 600_000);
    } else if (!provenKeys.has(key)) {
      // Never answered successfully in this process and is refusing with a bare
      // 429: treat it as out of daily quota and get it out of the way now, rather
      // than re-testing it every minute for the whole batch. Measured: with ~97
      // dead buckets and a 60s park, a 253s run burned ~409 calls and ~818
      // worker-seconds on keys that could not work at all that day.
      backoff = UNPROVEN_KEY_BACKOFF_MS + Math.floor(Math.random() * 300_000);
    } else {
      // Known-good key, so this is just its per-minute window being full.
      backoff = HARD_EXHAUSTION_BACKOFF_MS + Math.floor(Math.random() * 5000);
    }
    // Nudge the whole key too; its other models are usually close behind.
    keyNextAvailable.set(key, Math.max(keyNextAvailable.get(key) ?? 0, Date.now() + 5000));
  } else {
    backoff =
      Math.max(retryAfterMs, slotIntervalFor(modelName)) + 500 + Math.floor(Math.random() * 1000);
  }

  slotNextAvailable.set(id, Math.max(slotNextAvailable.get(id) ?? 0, Date.now() + backoff));
}

/**
 * A bucket that answers successfully proves two things: it is not out of daily
 * quota, and its key is worth trusting with a short backoff from now on.
 */
function noteSlotSuccess(key: string, modelName: string) {
  hardFailStreak.delete(slotId(key, modelName));
  provenKeys.add(key);
}

function classifyError(error: any): { isRateLimitOr503: boolean; retryAfterMs?: number } {
  const msg = (error?.message || "").toLowerCase();
  const status = error?.status;

  let retryAfterMs: number | undefined;

  // 1. Extract Google RPC RetryInfo from errorDetails if present
  const retryInfo = error?.errorDetails?.find?.((d: any) => d?.["@type"]?.includes("RetryInfo"));
  if (retryInfo?.retryDelay) {
    const s = parseFloat(String(retryInfo.retryDelay).replace(/s$/i, ""));
    if (!isNaN(s) && s > 0) {
      retryAfterMs = Math.ceil(s * 1000);
    }
  }

  // 2. Fallback regex in message
  if (!retryAfterMs) {
    const retryMatch = msg.match(/(?:retry in|retrydelay["']?:\s*["']?)(\d+(?:\.\d+)?)/i);
    if (retryMatch) {
      retryAfterMs = Math.ceil(parseFloat(retryMatch[1]) * 1000);
    }
  }

  const isRateLimitOr503 =
    status === 429 ||
    status === 503 ||
    msg.includes("429") ||
    msg.includes("503") ||
    msg.includes("resource has been exhausted") ||
    msg.includes("resourceexhausted") ||
    msg.includes("quota") ||
    msg.includes("high demand") ||
    msg.includes("spikes in demand");

  return { isRateLimitOr503, retryAfterMs };
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
  workerIdx,
  signal,
}: QuestionSolverOptions): Promise<string> {
  if (signal?.aborted) {
    throw new Error("Question solving aborted");
  }

  const allKeys = await getGeminiApiKeys();
  if (allKeys.length === 0) {
    throw new Error("No available Gemini API keys configured");
  }

  let cleaned: string;
  try {
    cleaned = latexToText(raw);
  } catch {
    cleaned = raw;
  }
  if (!cleaned.trim()) throw new Error("Empty question text");

  const isLong = solutionLength === "long";
  const systemInstruction =
    subjectType === "math"
      ? isLong
        ? UNIFIED_SYSTEM_PROMPT_MATH_LONG
        : UNIFIED_SYSTEM_PROMPT_MATH_NORMAL
      : isLong
        ? UNIFIED_SYSTEM_PROMPT_GK_LONG
        : UNIFIED_SYSTEM_PROMPT_GK_NORMAL;

  const prompt = `Solve and format the following MCQ:\n\n${cleaned}`;

  let lastError: any = null;
  // With 51 paced buckets a request rarely needs more than a couple of tries.
  // Each attempt waits for a free bucket, so this is self-limiting rather than
  // the old tight spin of instant retries against already-throttled models.
  const MAX_ATTEMPTS = 12;

  const startedAt = Date.now();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) {
      throw new Error("Question solving aborted");
    }

    // Stop once this question has had its share of time. A worker stuck behind a
    // saturated pool blocks every question queued behind it, so it is better to
    // fail here and let the batch continue than to hold the slot indefinitely.
    const elapsed = Date.now() - startedAt;
    if (elapsed > QUESTION_BUDGET_MS) {
      throw new Error(
        lastError?.message ||
          `Gave up after ${Math.round(elapsed / 1000)}s: the Gemini key pool is rate-limited. Use "Retry failed" once it recovers.`,
      );
    }

    // Wait for the (key, model) bucket that frees up soonest. This is the only
    // pacing in the pipeline — it is what keeps us under the per-minute cap.
    // A throw here (no usable keys, saturated pool, or aborted) is terminal for
    // this question: retrying immediately cannot help.
    const remainingBudget = QUESTION_BUDGET_MS - elapsed;
    const { key, modelName } = await acquireSlot(
      allKeys,
      workerIdx,
      signal,
      Math.min(MAX_SLOT_WAIT_MS, remainingBudget),
    );

    try {
      const genAI = getGenAIClient(key);
      const model = genAI.getGenerativeModel(
        {
          model: modelName,
          systemInstruction,
          generationConfig: {
            temperature: 0.1,
            topP: 0.1,
            // A full 8-10 point Hindi solution runs to roughly 1,000-1,700
            // characters, and 1200 tokens was not always enough: measured answers
            // came back cut off mid-word ("...Solution") or stopping after option
            // C, with no Answer line at all. Those were then stored as "done".
            maxOutputTokens: 2048,
          },
          safetySettings: defaultSafetySettings,
        },
        { timeout: 15000, signal } as any,
      );

      if (signal?.aborted) {
        throw new Error("Question solving aborted");
      }

      const result = await model.generateContent([prompt]);
      const response = await result.response;

      // Reject a truncated answer instead of saving it. finishReason MAX_TOKENS
      // means the model was still writing, so the text is missing whatever comes
      // last - usually the Answer line and the Solution. Falling through to the
      // retry loop lets another attempt produce a complete answer; keeping it
      // would silently store a half-written question.
      const finishReason = (response as any)?.candidates?.[0]?.finishReason;
      if (finishReason === "MAX_TOKENS") {
        lastError = new Error(
          `Model ${modelName} hit the output limit and returned a truncated answer`,
        );
        continue;
      }

      const text = getResponseTextSafely(response);
      if (text && text.trim().length > 0) {
        // This bucket clearly still has quota, so clear any daily-exhaustion suspicion.
        noteSlotSuccess(key, modelName);
        return sanitizeAiOutput(latexToText(text), idx, subjectType);
      }
    } catch (error: any) {
      lastError = error;
      const msg = (error?.message || "").toLowerCase();
      const status = error?.status;

      // Bad-key handling. The SDK appends JSON.stringify(error.details) to the
      // message, so the upstream `reason` (e.g. API_KEY_INVALID) is matchable here
      // even though that error arrives as HTTP 400 rather than 403.
      const isDeadKey = msg.includes("api_key_invalid") || msg.includes("consumer_suspended");
      if (isDeadKey || status === 403 || msg.includes("denied access")) {
        // A key Google reports as invalid/suspended will not recover on its own,
        // so park it for hours instead of letting it re-enter rotation every 10
        // minutes and burn one failure per model each time. Rotating the key in
        // Team settings produces a different string, which is tracked separately
        // and is therefore unaffected by this entry.
        disabledKeysUntil.set(key, Date.now() + (isDeadKey ? 6 * 60 * 60 * 1000 : 10 * 60 * 1000));
        console.warn(
          `[Gemini] Disabling key ...${key.slice(-6)} for ${isDeadKey ? "6h" : "10m"}: ${(error?.message || "").slice(0, 120)}`,
        );
        continue;
      }

      const { isRateLimitOr503, retryAfterMs } = classifyError(error);

      if (isRateLimitOr503) {
        // Push only this bucket out; the other 50 stay available. The next
        // attempt waits for whichever bucket frees up soonest.
        penalizeSlot(key, modelName, retryAfterMs);
        continue;
      }

      if (msg.includes("recitation") || msg.includes("safety")) {
        continue;
      }

      // Transient error; retry next key/model
      continue;
    }
  }

  throw new Error(
    lastError?.message || "Failed to solve question across all Gemini keys and models.",
  );
}

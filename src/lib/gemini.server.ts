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
}
export type DeepSeekOptions = QuestionSolverOptions;

// ============================================================================
// OUTPUT SANITIZER
// ============================================================================

export function sanitizeAiOutput(text: string, idx: number, subjectType?: "gk_english" | "math"): string {
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
  s = s.replace(/([।\?!;]|(?<!\d)\.(?!\d))\s*(?=(?:[2-9]|10|\((?:[2-9]|10|i{1,3}|iv|v)\))[.)]?\s+[^\s\d])/g, "$1\n");
  s = s.replace(/([।\?!;]|(?<!\d)\.(?!\d))\s*(?=(?:उपर्युक्त|उपरोक्त|इनमें|निम्न|Which of the|Of the above)[^\n]*[\?？:])/gi, "$1\n");

  // Fix column headers glued to the end of a line or to their first item
  s = s.replace(/(?<=\S)[^\S\r\n]+((?:Column|कॉलम|स्तंभ|List|सूची|[?¿\uFFFD]+)[ \t\-]*\(?(?:A|B|I{1,3}|1|2)\)?(?:\([^\)\n]+\))?(?:[ \t.:\-]+(?=\(?[a-zA-Z1-9]\)?[ \t.)])|[ \t.:\-]*$))/gim, "\n$1");
  s = s.replace(/^((?:Column|कॉलम|स्तंभ|List|सूची|[?¿\uFFFD]+)[ \t\-]*\(?(?:A|B|I{1,3}|1|2)\)?(?:\([^\)\n]+\))?[ \t.:\-]*)[^\S\r\n]+(?=\(?[a-zA-Z1-9]\)?[ \t.)])/gim, "$1\n");

  // Fix dash/hyphen/colon separated match-the-column items on the same line (e.g. "a Item - 1 Item")
  const dashSplitRegex = /\s*(?:[-–—:;]|\t+)\s*(?=\(?(?:[1-9]|10|[a-hA-H]|i{1,3}|iv|v)\)?[.)]?\s+)/i;
  const leftItemRegex = /^\s*(?:[a-hA-H][.)]?|\([a-hA-H]\)|[ivxIVX]{1,4}[.)]?|\([ivxIVX]{1,4}\)|(?:[1-9]|10)[.)]?|\((?:[1-9]|10)\))\s+/i;
  const isQuestionPromptRegex = /(?:सुमेलित|सुमेल|मिलान|Match\b|Match the|निम्नलिखित|निम्न में|सूची\s*[-–—]?\s*[I1A].*सूची\s*[-–—]?\s*[II2B])/i;
  const isStatementQuestion = /(?:केवल|सभी\s*सही|कोई\s*नहीं|\bदोनों\b|कथन\s*\d|उपर्युक्त|उपरोक्त|Only\b|All\s+of\s+the\s+above|None\s+of\s+the\s+above|Both\s+\d)/i.test(s);
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
            if (/^\s*(?:Column|कॉलम|स्तंभ|List|सूची|[?¿\uFFFD]+)[\s\-]*\(?(?:A|I|1)\)?[:.\-]?/i.test(prev)) {
              startIndex--;
              break;
            }
            if (prev === "" || /^\s*(?:Column|कॉलम|स्तंभ|List|सूची|[?¿\uFFFD]+)[\s\-]*\(?(?:B|II|2)\)?[:.\-]?/i.test(prev)) {
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
            if (/^\s*(?:उत्तर\s*|सही\s*)?(?:कूट|कोड|Code|Codes)\s*[:.\-]?/i.test(curr) || /^\s*(?:Answer|Ans|उत्तर|Solution|Sol|हल|समाधान)[:.\-]/i.test(curr)) {
              break;
            }
            if (/^\s*(?:Column|कॉलम|स्तंभ|List|सूची|[?¿\uFFFD]+)[\s\-]*\(?(?:B|II|2)\)?/i.test(curr)) {
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
            const m1 = precedingText.match(/((?:सूची|कॉलम|स्तंभ|List|Column)[\s\-]*(?:I|A|1)(?:\s*\([^\)\n]+\))?)/i);
            const m2 = precedingText.match(/((?:सूची|कॉलम|स्तंभ|List|Column)[\s\-]*(?:II|B|2)(?:\s*\([^\)\n]+\))?)/i);
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
  s = s.replace(/(?<=\S)[^\S\r\n]+((?:उत्तर\s*|सही\s*)?(?:कूट|कोड|Code|Codes)\s*(?::|:-|[-–—]|(?=\s*(?:[A-Ha-h]\.|\([a-hA-H1-8]\)|[A-Ha-h]\)))))/gim, "\n$1");
  s = s.replace(/^((?:उत्तर\s*|सही\s*)?(?:कूट|कोड|Code|Codes)\s*[:.\-]*)[^\S\r\n]+(?=(?:[A-Ha-h]\.|\([a-hA-H1-8]\)|[A-Ha-h]\)))/gim, "$1\n");

  // Only add space after option label if at line start or after 2+ spaces, and NOT followed by an abbreviation like B.C., A.D., C.E.
  s = s.replace(/(?:^|[^\S\r\n]{2,})([A-Ha-h]\.)(?!\s*[A-Za-z]\.)([^\s.])/gm, (m, g1, g2) => {
    return m.slice(0, m.length - g1.length - g2.length) + g1 + " " + g2;
  });
  s = s.replace(/(?<![A-Za-z0-9])(\([a-hA-H1-8]\)|[A-Ha-h]\))(?=[^\s:.\-])/g, "$1 ");

  // Add missing space after sub-statement number if stuck directly to content (e.g. "1वैगनर" -> "1 वैगनर")
  s = s.replace(/^([1-9]|10)(?=[\u0900-\u097FA-Za-z])/gm, "$1 ");

  // Remove dots, commas, parentheses, colons, hyphens from sub-statement numbers (e.g., "1. वैगनर" or "1, वैगनर" or "(1) वैगनर" -> "1 वैगनर"), skipping the first line (question number)
  s = s.replace(/(?<=\n)\s*(?:\(([1-9]|10)\)|([1-9]|10))\s*[.,):\-–—]?\s+(?=\S)/g, (m, g1, g2) => `${g2 || g1.replace(/[\(\)]/g, "")} `);

  // Also split sub-statements like (1), (2), (3), (4) or (i), (ii), (iii), (iv) if on same line
  s = s.replace(/(?<=\S)[^\S\r\n]{2,}(?=\((?:[1-9]|10|i{1,3}|iv|v|vi)\)\s+)/gi, "\n");
  s = s.replace(/(?<=[।;]|\S[^\S\r\n]{2,})(?=(?:\(([2-9]|10)\)|([2-9]|10))\s*[.,):\-–—]?\s+[^\s\d])/g, "\n");

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
    solText = solText.replace(/^([ \t]*)(?:\((\d+)\)|(\d+))\s*[.,):\-–—]?\s+/gm, (m, indent, g1, g2) => `${indent}${g2 || g1} `);
    s = s.slice(0, solMatch.index) + solText;
  }

  // Force the main question number to the caller-supplied idx with a dot,
  // matching the first occurrence of a number at the top, or prepending if missing.
  const prefixRegex = /^\s*(?:#+\s*)?(?:(?:[Qq]\.?(?:uestion|ue|ues)?|Problem|Prob|MCQ|Item|Task|Case)(?:[ \t]*(?:No|Num|Number|#)\.?)?|प्रश्न(?:[ \t]*(?:संख्या|सं\.?|क्र\.?|क्रमांक))?|प्र\.?[ \t]*(?:संख्या|सं\.?|क्र\.?|क्रमांक)?|सवाल(?:[ \t]*(?:संख्या|सं\.?|क्र\.?|क्रमांक))?|क्र\.?[ \t]*(?:सं\.?|संख्या)?|[?¿\uFFFD]+)?[ \t]*[:.-]?[ \t]*\d{1,4}[.:\-)\]\s]+/i;
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
      if (/^Solution:/i.test(line)) { inSol = true; continue; }
      if (!inSol) continue;
      if (/^Answer:/i.test(line)) { inSol = false; continue; }
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
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// High-capacity, ultra-fast free tier flash-lite models each with an INDEPENDENT 15 RPM project quota:
// - gemini-flash-lite-latest: ~800ms
// - gemini-3.5-flash-lite: ~800ms
// - gemini-3.1-flash-lite: ~800ms
// Combined capacity: 3 distinct quota pools x 14 RPM = 42 RPM rock-solid zero-error throughput!
export const GEMINI_SOLVER_MODELS = [
  "gemini-flash-lite-latest",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
];

interface ModelSlot {
  name: string;
  nextAvailableTime: number;
}

const modelSlots: ModelSlot[] = GEMINI_SOLVER_MODELS.map((name) => ({
  name,
  nextAvailableTime: 0,
}));

let slotLock: Promise<void> = Promise.resolve();

// Inter-request pacing per model to guarantee we NEVER exceed Google's 15 RPM per project quota
// 60,000ms / 4,300ms = 13.95 RPM max per model (strictly below the 15 RPM hard ceiling)
const MIN_MODEL_INTERVAL_MS = 4300;

const genAiClientCache = new Map<string, GoogleGenerativeAI>();
function getGenAIClient(key: string): GoogleGenerativeAI {
  let client = genAiClientCache.get(key);
  if (!client) {
    client = new GoogleGenerativeAI(key);
    genAiClientCache.set(key, client);
  }
  return client;
}

let globalRequestIndex = 0;
// Track model-level cooldowns (since Google quotas are PerProjectPerModel)
const modelCooldowns = new Map<string, number>();
const permanentlyUnavailableModels = new Set<string>();
const permanentlyDisabledKeys = new Set<string>();

function recordModelCooldown(modelName: string, retryAfterMs?: number) {
  const cooldown = retryAfterMs ? Math.max(retryAfterMs + 500, 3000) : 10000;
  modelCooldowns.set(modelName, Date.now() + cooldown);
}

async function acquireScheduledModel(preferredModelName?: string): Promise<string> {
  let modelToUse: string;
  let waitNeeded = 0;

  // Hold lock ONLY to evaluate and reserve the slot timestamp (runs in microseconds)
  let releaseSlot: () => void;
  const prevLock = slotLock;
  slotLock = new Promise((resolve) => {
    releaseSlot = resolve;
  });
  await prevLock;

  try {
    const now = Date.now();

    // Clean up expired cooldowns
    for (const [model, exp] of modelCooldowns.entries()) {
      if (exp <= now) {
        modelCooldowns.delete(model);
      }
    }

    const availableSlots = modelSlots.filter((s) => !permanentlyUnavailableModels.has(s.name));
    if (availableSlots.length === 0) {
      // Reset if all were marked unavailable
      permanentlyUnavailableModels.clear();
    }

    const slotsToEvaluate = availableSlots.length > 0 ? availableSlots : modelSlots;
    let bestSlot: ModelSlot | null = null;
    let minEarliestTime = Infinity;

    // Check if preferred model is healthy and ready within 1.5s
    if (preferredModelName && !permanentlyUnavailableModels.has(preferredModelName)) {
      const preferred = slotsToEvaluate.find((s) => s.name === preferredModelName);
      if (preferred) {
        const cooldownExp = modelCooldowns.get(preferred.name) || 0;
        const earliest = Math.max(now, preferred.nextAvailableTime, cooldownExp);
        if (earliest - now <= 1500) {
          bestSlot = preferred;
          minEarliestTime = earliest;
        }
      }
    }

    if (!bestSlot) {
      for (const slot of slotsToEvaluate) {
        const cooldownExp = modelCooldowns.get(slot.name) || 0;
        const earliest = Math.max(now, slot.nextAvailableTime, cooldownExp);
        if (earliest < minEarliestTime) {
          minEarliestTime = earliest;
          bestSlot = slot;
        }
      }
    }

    if (!bestSlot) {
      bestSlot = slotsToEvaluate[0];
      minEarliestTime = now;
    }

    const scheduledTime = Math.max(now, minEarliestTime);
    bestSlot.nextAvailableTime = scheduledTime + MIN_MODEL_INTERVAL_MS;
    modelToUse = bestSlot.name;
    waitNeeded = scheduledTime - now;
  } finally {
    // ALWAYS release lock immediately so no other caller is blocked!
    releaseSlot!();
  }

  // Sleep OUTSIDE the critical section
  if (waitNeeded > 0) {
    await new Promise((r) => setTimeout(r, waitNeeded));
  }

  return modelToUse;
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
}: QuestionSolverOptions): Promise<string> {
  const allKeys = (await getGeminiApiKeys()).filter((k) => !permanentlyDisabledKeys.has(k));
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
  const systemInstruction = subjectType === "math"
    ? (isLong ? UNIFIED_SYSTEM_PROMPT_MATH_LONG : UNIFIED_SYSTEM_PROMPT_MATH_NORMAL)
    : (isLong ? UNIFIED_SYSTEM_PROMPT_GK_LONG : UNIFIED_SYSTEM_PROMPT_GK_NORMAL);

  const prompt = `Solve and format the following MCQ:\n\n${cleaned}`;

  let lastError: any = null;
  const MAX_ATTEMPTS = 20;

  const preferredModelName = workerIdx !== undefined ? GEMINI_SOLVER_MODELS[workerIdx % GEMINI_SOLVER_MODELS.length] : undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Only use preferred model on the very first attempt; on retries, choose whichever model is available right now
    const modelName = await acquireScheduledModel(attempt === 1 ? preferredModelName : undefined);
    const key = allKeys[(globalRequestIndex++) % allKeys.length];

    try {
      const genAI = getGenAIClient(key);
      const is37 = modelName.includes("3.7");
      const model = genAI.getGenerativeModel(
        {
          model: modelName,
          systemInstruction,
          generationConfig: {
            temperature: 0.1,
            topP: 0.1,
            maxOutputTokens: 1200,
            ...(is37 ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
          },
          safetySettings: defaultSafetySettings,
        },
        { timeout: 15000 }
      );

      const result = await model.generateContent([prompt]);
      const response = await result.response;
      const text = getResponseTextSafely(response);
      if (text && text.trim().length > 0) {
        return sanitizeAiOutput(latexToText(text), idx, subjectType);
      }
    } catch (error: any) {
      lastError = error;
      const msg = (error?.message || "").toLowerCase();
      const status = error?.status;

      // If the key itself is disabled/forbidden, permanently mark it
      if (status === 403 || msg.includes("denied access") || msg.includes("api_key_invalid") || msg.includes("consumer_suspended")) {
        permanentlyDisabledKeys.add(key);
        continue;
      }

      const { isRateLimitOr503, retryAfterMs } = classifyError(error);

      if (isRateLimitOr503) {
        recordModelCooldown(modelName, retryAfterMs);
        // Next iteration will automatically acquire another available model
        continue;
      }

      if (msg.includes("not found") || msg.includes("deprecated") || msg.includes("perdayperprojectpermodel")) {
        permanentlyUnavailableModels.add(modelName);
        continue;
      }

      if (msg.includes("recitation") || msg.includes("safety")) {
        continue;
      }

      // Unknown/transient error; retry next model
      continue;
    }
  }

  throw new Error(lastError?.message || "Failed to solve question across all Gemini keys and models.");
}

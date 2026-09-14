// Server-only Gemini question solver and formatter (uses free-tier multi-key pool)
import {
  GoogleGenAI,
  HarmCategory,
  HarmBlockThreshold,
  ThinkingLevel,
  type SafetySetting,
} from "@google/genai";
import { latexToText } from "./latex-to-text";
import { getGeminiApiKeys } from "./settings.functions";
import {
  normalizeOptionsInText,
  normalizeAnswerInText,
  protectOptionsForTranslation,
  healCorruptedMatchTitle,
  splitHorizontalOptions,
} from "./normalize-options";

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
  /**
   * Longest this question may wait for a free (key x model) bucket.
   *
   * Defaults to MAX_SLOT_WAIT_MS (70s), which is right when Gemini is the only
   * option - waiting out a rate limit beats failing. But when a paid provider is
   * standing by, waiting 70s is absurd: the question should give up in a few
   * seconds and go get answered. The batch processor passes a small value in
   * that case, which is what turns "Gemini then DeepSeek" from a slow serial
   * fallback into a fast parallel one.
   */
  maxSlotWaitMs?: number;
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

const defaultSafetySettings: SafetySetting[] = [
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

// Thinking is billed against maxOutputTokens, and it is ON BY DEFAULT on the
// Gemini 3 Flash family (thinking_level "high"). Measured on a live key with a
// short MCQ and maxOutputTokens 2048:
//
//   gemini-3-flash-preview, default thinking : 303 answer + 711 THINKING tokens
//   gemini-3-flash-preview, thinkingLevel MIN: 298 answer +   0 thinking tokens
//
// So three quarters of the budget was going to reasoning we never read, and on a
// full 8-10 point Hindi solution thinking + answer crossed 2048 and came back as
// finishReason MAX_TOKENS - which is exactly the truncation that raising the cap
// from 1200 to 2048 was trying to paper over. Solving a formatted MCQ needs no
// extended reasoning, so ask for none. The Flash-Lite models already default to
// minimal; setting it explicitly keeps them pinned there if that default moves.
export const SOLVER_THINKING_CONFIG = { thinkingLevel: ThinkingLevel.MINIMAL } as const;

// The solver pool, sized from the project's ACTUAL free-tier grants as shown on
// the AI Studio rate-limit dashboard (per project, per day):
//
//   Gemini 3.5 Flash Lite   15 RPM   250K TPM     500 RPD
//   Gemini 3.1 Flash Lite   15 RPM   250K TPM     500 RPD
//   Gemini 3 Flash           5 RPM   250K TPM      20 RPD   <- excluded, see below
//   Gemma 4 26B / 31B       30 RPM    16K TPM   14,400 RPD
//
// Two models were removed from this list on that evidence:
//
//   gemini-3-flash-preview  - 20 requests per project per DAY. Across 81 keys
//     that is 1,620 requests total, under 2% of the pool's daily budget, while
//     occupying 25% of the scheduler's bucket picks. Measured directly: it went
//     79/81 keys alive -> 49 -> 0 within an afternoon. It cost far more in
//     wasted picks and 429-parks than the handful of answers it returned.
//
//   gemini-3.1-flash-lite-preview - the dashboard has NO separate line for it,
//     so it draws on the Gemini 3.1 Flash Lite grant. Treating it as its own
//     bucket meant the scheduler paced two buckets at 15 RPM each against a
//     single shared 15 RPM allowance and then blamed the pool for the 429s. It
//     is also deprecated. Removing it loses no capacity - it never had any of
//     its own.
export const GEMINI_SOLVER_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];

// Gemma 4 is the single largest capacity lever available on this tier: 14,400
// requests per project per day against Flash-Lite's 500, i.e. ~29x. It is off by
// default because it is a different model family and the output bar here is
// yours, not mine. Verified working on this pool before shipping:
//
//   - gemma-4-26b-a4b-it answered a Hindi MCQ correctly, in the required plain
//     text layout, in 5.4s. One flaw seen: it skipped a solution number
//     (3 -> 5), so check a sample batch before trusting it wholesale.
//   - gemma-4-31b-it was too slow to be useful here (timed out past 40s).
//   - Gemma has thinking ON by default and burned 509 thinking tokens on a
//     ONE WORD answer. thinkingLevel MINIMAL fixes it (thinkingBudget is
//     rejected outright with 400). Without that it is unusable.
//   - Gemma has no system role, so the system prompt must be folded into the
//     user turn. isGemmaModel() below drives that.
//
// Turn on with GEMINI_ENABLE_GEMMA=1 once you have eyeballed a sample.
export const GEMMA_SOLVER_MODELS = ["gemma-4-26b-a4b-it"];

export function isGemmaModel(modelName: string): boolean {
  return modelName.startsWith("gemma");
}

export function solverModels(): string[] {
  return process.env.GEMINI_ENABLE_GEMMA === "1"
    ? [...GEMINI_SOLVER_MODELS, ...GEMMA_SOLVER_MODELS]
    : GEMINI_SOLVER_MODELS;
}

const genAiClientCache = new Map<string, GoogleGenAI>();
function getGenAIClient(key: string): GoogleGenAI {
  let client = genAiClientCache.get(key);
  if (!client) {
    client = new GoogleGenAI({ apiKey: key });
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

// Per-model pacing, taken from the project's AI Studio rate-limit dashboard.
//
// An earlier revision paced these from a live measurement that read 32 RPM for
// gemini-3.5-flash-lite. That was a measurement artefact: the probe ran for 65
// seconds, so a window straddling the per-minute reset captured two minutes of
// allowance and reported roughly double. The dashboard is authoritative and says
// 15 RPM. Pacing at 28 RPM against a real 15 RPM ceiling is precisely how a pool
// of healthy keys turns into a wall of 429s.
//
// Each interval targets ~90% of the granted ceiling, leaving room for jitter.
const MODEL_MIN_INTERVAL_MS: Record<string, number> = {
  "gemini-3.5-flash-lite": 4400, // grant 15 RPM -> pace ~13.6
  "gemini-3.1-flash-lite": 4400, // grant 15 RPM -> pace ~13.6
  // Gemma's grant is 30 RPM but only 16K TPM, and a solve costs ~1,400 tokens.
  // 16,000 / 1,400 = ~11 requests/min, so TOKENS bind here, not requests - the
  // only model in the pool where that is true. Paced to ~10/min.
  "gemma-4-26b-a4b-it": 6000,
};

const SLOT_MIN_INTERVAL_MS = 5400;

function slotIntervalFor(modelName: string): number {
  return MODEL_MIN_INTERVAL_MS[modelName] ?? SLOT_MIN_INTERVAL_MS;
}

/**
 * Mean seconds between two firings of the SAME bucket, averaged over the pool.
 *
 * The batch processor sizes its worker fan-out from this. It used to hard-code
 * 6.5s, which was already wrong for a three-model pool and got worse when a
 * fourth model was added: the true mean is (2.2+4.3+4.3+5.4)/4 = 4.05s, so
 * supply was being under-estimated by ~60%. Deriving it here means the two
 * files can never drift apart again.
 */
export function meanSlotIntervalSeconds(): number {
  const models = solverModels();
  const total = models.reduce((sum, m) => sum + slotIntervalFor(m), 0);
  return total / models.length / 1000;
}

// Additional pacing across ALL models sharing one key. This is only a backstop -
// the per-bucket pacing above is what should normally bind.
//
// Per project the grants total 15 + 15 = 30 RPM on Gemini, plus ~10 more if
// Gemma is enabled. Set just above the Gemini-only figure so it never binds
// before the per-model intervals do.
const KEY_MIN_INTERVAL_MS = Math.floor(60_000 / 32);

// At most this many requests may be in flight on one key at any instant.
//
// This is the single most important limit in the file, and it is not about rate
// - it is about simultaneity. Measured on one rested key, round-robining all
// four models for 62 seconds:
//
//   in-flight   successes/min   429s   success rate
//       1             48          10       83%
//       2             63         116       35%
//       3             59         267       18%
//       6             74         690       10%
//
// Throughput barely moves past one in-flight request, while the 429 rate goes up
// 70x. That trade is catastrophic HERE specifically, because this scheduler
// parks a bucket for 60s on every 429: at six in flight a key produces ~11 parks
// per successful answer, so the pool destroys itself faster than it can serve.
// Holding one request per key costs ~25% of peak throughput and removes ~98% of
// the 429s. Pacing alone could not achieve this - a key can be well under its
// per-minute ceiling and still be refused for having six requests open at once.
const MAX_INFLIGHT_PER_KEY = 1;

// Keys with a request currently open. A key in here is not offered to anyone.
const keyInFlight = new Map<string, number>();

// ===========================================================================
// ADAPTIVE PER-MODEL CONCURRENCY (AIMD)
//
// How much work this pool absorbs is NOT a constant: it falls as each project's
// daily grant is spent, and the only signal is refusals. So the gate is learned,
// not configured - additive increase while clean, multiplicative decrease on
// refusals.
//
// Critically the gate is PER MODEL, not global. A single global gate was
// measured doing real damage: once the Flash-Lite models had spent their 500
// requests/day, their refusals dragged the shared limit down to the floor of 4
// and throttled Gemma along with them - even though Gemma still had ~14,000
// requests of daily grant left and was answering every time it was asked. The
// batch then crawled at 4 concurrent against a model that could have run at 40.
// Capacity is per model, so back-pressure has to be per model too.
// ===========================================================================
const CONCURRENCY_FLOOR = 2;
const CONCURRENCY_CEILING = 48;
const CONTROL_WINDOW = 12;
const WIDEN_BELOW_REFUSAL_RATE = 0.15;
const NARROW_ABOVE_REFUSAL_RATE = 0.35;
const DECREASE_FACTOR = 0.6;
// Slow start, borrowed from TCP. Pure additive increase is far too slow on a
// SHORT run: a 100-question batch is ~130 outcomes, so at +1 per window the gate
// barely leaves its seed and the batch is paced by the seed rather than by what
// the pool can take. While a window comes back completely clean, grow
// geometrically; the moment anything is refused, drop to cautious +1 steps.
const SLOW_START_FACTOR = 1.5;

type ModelGate = {
  limit: number;
  inFlight: number;
  winOk: number;
  winRefused: number;
  slowStart: boolean;
};
const modelGates = new Map<string, ModelGate>();
const gateWaiters: Array<() => void> = [];

function gateFor(model: string): ModelGate {
  let g = modelGates.get(model);
  if (!g) {
    g = { limit: 12, inFlight: 0, winOk: 0, winRefused: 0, slowStart: true };
    modelGates.set(model, g);
  }
  return g;
}

/** Models that still have room for another request right now. */
function modelsWithHeadroom(models: string[]): string[] {
  return models.filter((m) => gateFor(m).inFlight < gateFor(m).limit);
}

function wakeGateWaiters() {
  while (gateWaiters.length > 0) {
    const wake = gateWaiters.shift();
    if (!wake) break;
    wake();
  }
}

/** Wait until at least one of `models` has gate headroom. */
async function awaitAnyHeadroom(models: string[], signal?: AbortSignal): Promise<void> {
  if (modelsWithHeadroom(models).length > 0) return;
  await new Promise<void>((resolve, reject) => {
    const wake = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      const i = gateWaiters.indexOf(wake);
      if (i >= 0) gateWaiters.splice(i, 1);
      reject(new Error("Question solving aborted"));
    };
    if (signal?.aborted) {
      reject(new Error("Question solving aborted"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    gateWaiters.push(wake);
  });
}

function evaluateGate(model: string) {
  const g = gateFor(model);
  const total = g.winOk + g.winRefused;
  if (total < CONTROL_WINDOW) return;
  const refusalRate = g.winRefused / total;
  g.winOk = 0;
  g.winRefused = 0;
  if (refusalRate > 0) g.slowStart = false;

  if (refusalRate > NARROW_ABOVE_REFUSAL_RATE) {
    const next = Math.max(CONCURRENCY_FLOOR, Math.floor(g.limit * DECREASE_FACTOR));
    if (next !== g.limit) {
      g.limit = next;
      poolStats.concurrencyDecreases++;
    }
  } else if (refusalRate < WIDEN_BELOW_REFUSAL_RATE && g.limit < CONCURRENCY_CEILING) {
    g.limit =
      g.slowStart && refusalRate === 0
        ? Math.min(
            CONCURRENCY_CEILING,
            Math.max(g.limit + 1, Math.round(g.limit * SLOW_START_FACTOR)),
          )
        : g.limit + 1;
    poolStats.concurrencyIncreases++;
    wakeGateWaiters();
  }
}

function noteRateLimitForControl(model: string) {
  gateFor(model).winRefused++;
  evaluateGate(model);
}

function noteSuccessForControl(model: string) {
  gateFor(model).winOk++;
  evaluateGate(model);
}

/**
 * Seed every model's gate when a batch starts.
 *
 * Sized at half the key pool. With one request in flight per key that means half
 * the keys working and half as headroom; a quarter (the previous seed) left a
 * 57-key pool running at 20 concurrent and paced the whole batch off the seed
 * rather than off the pool. AIMD pulls it back within one window if too generous.
 */
export function primeConcurrency(keyCount: number) {
  const seed = Math.max(CONCURRENCY_FLOOR, Math.min(CONCURRENCY_CEILING, Math.round(keyCount / 2)));
  for (const m of solverModels()) {
    const g = gateFor(m);
    g.limit = Math.max(g.limit, seed);
    g.slowStart = true;
  }
  wakeGateWaiters();
}

// Backoff for a 429 that arrives with NO RetryInfo - the bare "Resource has been
// exhausted" replies, which are the ones this workload actually hits. Retrying
// those quickly is what produced the measured death spiral (96.6% of calls
// failing, 30/100 questions solved). They clear on their own in about a minute,
// so park the bucket instead of hammering it.
// A key that has already answered successfully in this process is known-good, so
// a 429 from it is just its per-minute window being full: it is back in about a
// minute and should not be taken out of rotation for longer.
const HARD_EXHAUSTION_BACKOFF_MS = 60_000;

// A bucket's first bare 429 is parked for one recovery window and nothing more.
//
// There used to be a 30-MINUTE park here for any key that had not yet answered
// successfully in this process. The intent was to clear out daily-exhausted keys
// quickly, but "has not answered YET" is not evidence of exhaustion - at process
// start it is true of every key in the pool, which is the exact moment a batch
// begins. Measured on this pool: a 60-question run at 32 workers issued 166 of
// these 30-minute parks and finished with 278 of 324 buckets parked, i.e. 86% of
// a healthy 61-key pool taken out of service in 52 seconds, and 31/60 solved.
//
// Escalation now needs real evidence instead: a bucket only earns a longer park
// by serving out a FULL recovery window and coming back exhausted anyway.
// Keys that have returned at least one successful response this process.
const provenKeys = new Set<string>();

// Park for a bucket that failed for a reason that is NOT rate limiting - a 404
// for a retired model, a malformed-request 400, a 500 from the backend.
//
// These used to fall through with no penalty at all, which inverted the whole
// scheduler. Healthy buckets get pushed out by their pacing interval and by
// 429s; a bucket that fails instantly and is never parked stays at the front of
// the free set and therefore gets picked MORE often than working ones. A model
// retirement would have turned a quarter of the pool into a traffic magnet that
// answered nothing. Escalates so a permanently broken bucket leaves rotation.
const TRANSIENT_FAIL_BACKOFF_MS = 30_000;
const TRANSIENT_FAILS_BEFORE_LONG_PARK = 3;
const TRANSIENT_LONG_PARK_MS = 30 * 60 * 1000;
const transientFailStreak = new Map<string, number>();

// A bucket that keeps coming back exhausted after serving out full parking
// periods has run out of DAILY quota, not per-minute quota, and will not recover
// until Google's daily reset. Park those for hours so the scheduler stops
// spending attempts on them and routes to keys that still have budget.
// Escalation ladder for a bucket that keeps coming back exhausted AFTER serving
// out a full park: 60s -> 10min -> 3h. A genuinely daily-dead bucket therefore
// costs three wasted calls spread over ~11 minutes and is then gone for the day,
// while a merely busy one is never punished for more than a minute at a time.
const HARD_FAILS_BEFORE_MEDIUM = 2;
const MEDIUM_EXHAUSTION_BACKOFF_MS = 10 * 60 * 1000;
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

// Lightweight pool telemetry. Cheap counters only - no per-request objects - so
// this can stay on in production. Read it with getPoolStats() to see whether a
// slow batch is the pool being genuinely exhausted or the scheduler mis-pacing.
const poolStats = {
  ok: new Map<string, number>(),
  rateLimited: new Map<string, number>(),
  transientFail: new Map<string, number>(),
  rlByKey: new Map<string, number>(),
  okByKey: new Map<string, number>(),
  picksByKey: new Map<string, number>(),
  deadKey: 0,
  parkedShort: 0,
  parkedMedium: 0,
  parkedDaily: 0,
  saturatedGiveUps: 0,
  concurrencyIncreases: 0,
  concurrencyDecreases: 0,
  slotWaitMsTotal: 0,
  slotWaits: 0,
};
function bump(m: Map<string, number>, k: string) {
  m.set(k, (m.get(k) ?? 0) + 1);
}
export function getPoolStats() {
  const now = Date.now();
  let parked = 0;
  for (const at of slotNextAvailable.values()) if (at > now) parked++;
  return {
    ok: Object.fromEntries(poolStats.ok),
    rateLimited: Object.fromEntries(poolStats.rateLimited),
    transientFail: Object.fromEntries(poolStats.transientFail),
    deadKey: poolStats.deadKey,
    parkedShort: poolStats.parkedShort,
    parkedMedium: poolStats.parkedMedium,
    parkedDaily: poolStats.parkedDaily,
    saturatedGiveUps: poolStats.saturatedGiveUps,
    gates: Object.fromEntries(
      [...modelGates.entries()].map(([m, g]) => [m, `${g.inFlight}/${g.limit}`]),
    ),
    concurrencyIncreases: poolStats.concurrencyIncreases,
    concurrencyDecreases: poolStats.concurrencyDecreases,
    bucketsParkedNow: parked,
    keysDisabledNow: [...disabledKeysUntil.values()].filter((t) => t > now).length,
    avgSlotWaitMs: poolStats.slotWaits
      ? Math.round(poolStats.slotWaitMsTotal / poolStats.slotWaits)
      : 0,
    provenKeys: provenKeys.size,
    keysInFlightNow: keyInFlight.size,
    distinctKeysPicked: poolStats.picksByKey.size,
    distinctKeysOk: poolStats.okByKey.size,
    distinctKeysRateLimited: poolStats.rlByKey.size,
    topPickedKeys: [...poolStats.picksByKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
    topRateLimitedKeys: [...poolStats.rlByKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
  };
}

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
 * There is deliberately no per-worker start offset. An earlier version took one
 * and never used it; uniform random choice over the free set already spreads
 * load across every live key, which is what the offset was trying to achieve.
 */
async function acquireSlot(
  keys: string[],
  signal?: AbortSignal,
  maxWaitMs: number = MAX_SLOT_WAIT_MS,
  models: string[] = solverModels(),
): Promise<{ key: string; modelName: string; release: () => void }> {
  // Wait until at least one model has gate headroom, then let the scan consider
  // only those models. Back-pressure is applied once, per model, rather than by
  // every worker independently rediscovering the same 429s.
  await awaitAnyHeadroom(models, signal);
  const open = modelsWithHeadroom(models);
  return acquireSlotInner(keys, signal, maxWaitMs, open.length > 0 ? open : models);
}

async function acquireSlotInner(
  keys: string[],
  signal?: AbortSignal,
  maxWaitMs: number = MAX_SLOT_WAIT_MS,
  models: string[] = solverModels(),
): Promise<{ key: string; modelName: string; release: () => void }> {
  const now = Date.now();
  const usableKeys = keys.filter((k) => (disabledKeysUntil.get(k) || 0) <= now);
  if (usableKeys.length === 0) {
    throw new Error(
      "All configured DeepSeek API keys are temporarily disabled. Please check your keys in Team settings.",
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
  let bestModel = models[Math.floor(Math.random() * models.length)];
  let bestAt = Infinity;

  for (const k of usableKeys) {
    // A key already serving a request is not a candidate at any price.
    if ((keyInFlight.get(k) ?? 0) >= MAX_INFLIGHT_PER_KEY) continue;
    const keyAt = keyNextAvailable.get(k) ?? 0;
    for (const m of models) {
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
    const tot = usableKeys.length * models.length;
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
    poolStats.saturatedGiveUps++;
    throw new Error(
      `DeepSeek key pool is saturated - every key/model is rate-limited for at least ${Math.round(waitMs / 1000)}s. Wait a minute, then use "Retry failed".`,
    );
  }

  // Reserve synchronously, before any await, so the slot is claimed atomically.
  slotNextAvailable.set(slotId(bestKey, bestModel), scheduledAt + slotIntervalFor(bestModel));
  keyNextAvailable.set(bestKey, scheduledAt + KEY_MIN_INTERVAL_MS);
  keyInFlight.set(bestKey, (keyInFlight.get(bestKey) ?? 0) + 1);
  gateFor(bestModel).inFlight++;

  bump(poolStats.picksByKey, bestKey.slice(-6));
  poolStats.slotWaitMsTotal += waitMs;
  poolStats.slotWaits++;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const n = (keyInFlight.get(bestKey) ?? 1) - 1;
    if (n <= 0) keyInFlight.delete(bestKey);
    else keyInFlight.set(bestKey, n);
    const g = gateFor(bestModel);
    g.inFlight = Math.max(0, g.inFlight - 1);
    wakeGateWaiters();
  };

  if (waitMs > 0) {
    try {
      await sleep(waitMs, signal);
    } catch (e) {
      // Aborted while waiting - never leak the in-flight reservation.
      release();
      throw e;
    }
  }
  return { key: bestKey, modelName: bestModel, release };
}

/**
 * Push one bucket out after a 429/503, honouring the server's RetryInfo.
 * Jitter stops workers released at the same instant from colliding again.
 */
function penalizeSlot(key: string, modelName: string, retryAfterMs?: number) {
  bump(poolStats.rateLimited, modelName);
  noteRateLimitForControl(modelName);
  bump(poolStats.rlByKey, key.slice(-6));
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
      poolStats.parkedDaily++;
      backoff = DAILY_EXHAUSTION_BACKOFF_MS + Math.floor(Math.random() * 600_000);
    } else if (streak >= HARD_FAILS_BEFORE_MEDIUM) {
      poolStats.parkedMedium++;
      backoff = MEDIUM_EXHAUSTION_BACKOFF_MS + Math.floor(Math.random() * 60_000);
    } else {
      // First bare 429 from this bucket. Either its per-minute window is full or
      // it is out for the day; both look identical here, so assume the cheap one
      // and let the ladder above sort out the difference.
      poolStats.parkedShort++;
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
  bump(poolStats.ok, modelName);
  noteSuccessForControl(modelName);
  bump(poolStats.okByKey, key.slice(-6));
  const id = slotId(key, modelName);
  hardFailStreak.delete(id);
  transientFailStreak.delete(id);
  provenKeys.add(key);
}

/**
 * Park a bucket that failed for a reason other than rate limiting.
 *
 * Without this the bucket is never pushed out, so it stays permanently in the
 * free set and out-competes every healthy bucket that a 429 or its own pacing
 * interval has moved forward. A bucket that keeps failing this way (a retired
 * model, a key with an API restriction) is parked for half an hour.
 */
function penalizeSlotTransient(key: string, modelName: string) {
  bump(poolStats.transientFail, modelName);
  const id = slotId(key, modelName);
  const streak = (transientFailStreak.get(id) ?? 0) + 1;
  transientFailStreak.set(id, streak);
  const backoff =
    streak >= TRANSIENT_FAILS_BEFORE_LONG_PARK
      ? TRANSIENT_LONG_PARK_MS + Math.floor(Math.random() * 300_000)
      : TRANSIENT_FAIL_BACKOFF_MS + Math.floor(Math.random() * 5_000);
  slotNextAvailable.set(id, Math.max(slotNextAvailable.get(id) ?? 0, Date.now() + backoff));
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
  const direct = typeof response?.text === "string" ? response.text : "";
  if (direct.trim().length > 0) return direct;
  const partsText = response?.candidates?.[0]?.content?.parts
    ?.map((part: any) => (typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("");
  return partsText ?? "";
}

/**
 * Run one arbitrary Gemini request through the SHARED bucket scheduler.
 *
 * Everything in the app that calls Gemini must come through here or through
 * formatQuestionWithGemini, because the per-(key x model) pacing only works if
 * it sees every request. OCR used to keep its own rotation and its own cooldown
 * map over the same keys, so it spent per-minute allowance the solver believed
 * it still had, and both sides then blamed the pool.
 *
 * `models` lets a caller use a different subset of the pool (OCR skips the
 * deprecated preview model) while still sharing the same bucket state.
 */
export async function runGeminiTask(opts: {
  models: string[];
  systemInstruction: string;
  contents: Array<Record<string, unknown>>;
  maxOutputTokens: number;
  temperature?: number;
  topP?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
  label?: string;
}): Promise<{ text: string; apiCalls: number }> {
  const allKeys = await getGeminiApiKeys();
  if (allKeys.length === 0) throw new Error("No available DeepSeek API keys configured");

  const label = opts.label ?? "DeepSeek task";
  const maxAttempts = opts.maxAttempts ?? 6;
  const startedAt = Date.now();
  let apiCalls = 0;
  let lastError: any = null;
  let maxOutputTokens = opts.maxOutputTokens;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw new Error(`${label} aborted`);

    const elapsed = Date.now() - startedAt;
    if (elapsed > QUESTION_BUDGET_MS) break;

    const { key, modelName, release } = await acquireSlot(
      allKeys,
      opts.signal,
      Math.min(MAX_SLOT_WAIT_MS, QUESTION_BUDGET_MS - elapsed),
      opts.models,
    );

    const timeoutCtl = new AbortController();
    const timer = setTimeout(() => timeoutCtl.abort(), REQUEST_TIMEOUT_MS);
    const abortSignal = opts.signal
      ? AbortSignal.any([opts.signal, timeoutCtl.signal])
      : timeoutCtl.signal;

    try {
      apiCalls++;
      const response = await getGenAIClient(key).models.generateContent({
        model: modelName,
        contents: [{ role: "user", parts: opts.contents as any }],
        config: {
          systemInstruction: opts.systemInstruction,
          temperature: opts.temperature ?? 0.1,
          topP: opts.topP ?? 0.95,
          maxOutputTokens,
          thinkingConfig: SOLVER_THINKING_CONFIG,
          safetySettings: defaultSafetySettings,
          abortSignal,
        },
      });

      if (response.candidates?.[0]?.finishReason === "MAX_TOKENS") {
        // Same escalation as the solver: retrying on the same cap reproduces
        // the same truncation.
        maxOutputTokens = Math.min(maxOutputTokens * 2, 32768);
        lastError = new Error(`${label}: ${modelName} truncated at the output limit`);
        continue;
      }

      const text = getResponseTextSafely(response);
      if (text && text.trim().length > 0) {
        noteSlotSuccess(key, modelName);
        return { text, apiCalls };
      }

      lastError = new Error(`${label}: ${modelName} returned an empty response`);
      penalizeSlotTransient(key, modelName);
    } catch (error: any) {
      lastError = error;
      if (opts.signal?.aborted) throw new Error(`${label} aborted`);

      const msg = (error?.message || "").toLowerCase();
      const isDeadKey =
        msg.includes("api_key_invalid") ||
        msg.includes("consumer_suspended") ||
        msg.includes("service account is deleted") ||
        msg.includes("service account bound to the api key") ||
        msg.includes("unauthenticated") ||
        error?.status === 401;
      if (isDeadKey || error?.status === 403 || msg.includes("denied access")) {
        disabledKeysUntil.set(key, Date.now() + (isDeadKey ? 6 * 60 * 60 * 1000 : 10 * 60 * 1000));
        poolStats.deadKey++;
        continue;
      }

      const { isRateLimitOr503, retryAfterMs } = classifyError(error);
      if (isRateLimitOr503) {
        penalizeSlot(key, modelName, retryAfterMs);
        continue;
      }

      // A 404 for a retired model, a 400, a backend 500. Park it rather than
      // swallowing it - the old code matched "not found" and silently retried,
      // so a bad model name surfaced only as a generic failure at the end.
      penalizeSlotTransient(key, modelName);
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  throw Object.assign(
    new Error(lastError?.message || `${label} failed across the DeepSeek pool.`),
    {
      apiCalls,
    },
  );
}

/**
 * Result of one solve. `apiCalls` is the number of requests actually spent at
 * the provider, which is NOT one per question: a question can retry across up
 * to MAX_ATTEMPTS buckets. The caller bills this against the user's quota;
 * counting one per question under-reported real usage by up to 12x.
 */
export interface SolveResult {
  text: string;
  apiCalls: number;
}

// Base output cap. With thinking pinned to minimal (see SOLVER_THINKING_CONFIG)
// the whole budget belongs to the answer, and a full 8-10 point Hindi solution
// measures ~300-500 tokens, so 2048 is comfortable.
const BASE_MAX_OUTPUT_TOKENS = 2048;
// If a model still reports MAX_TOKENS, retrying on the SAME cap just reproduces
// the same truncation and burns another bucket. Give the retry more room once.
const ESCALATED_MAX_OUTPUT_TOKENS = 4096;
// Per-request wall clock. Measured latency on the Flash-Lite models is 1.6-2.1s;
// the old 15s was tight enough that a slow long-solution response could be cut
// off by the client rather than by the model.
const REQUEST_TIMEOUT_MS = 30_000;

export async function formatQuestionWithGemini({
  raw,
  idx,
  subjectType,
  solutionLength,
  signal,
  maxSlotWaitMs,
}: QuestionSolverOptions): Promise<SolveResult> {
  if (signal?.aborted) {
    throw new Error("Question solving aborted");
  }

  const slotWaitCeiling = maxSlotWaitMs ?? MAX_SLOT_WAIT_MS;
  const allKeys = await getGeminiApiKeys();
  if (allKeys.length === 0) {
    throw new Error("No available DeepSeek API keys configured");
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
  // Each attempt waits for a free bucket, so this is self-limiting rather than
  // the old tight spin of instant retries against already-throttled models.
  const MAX_ATTEMPTS = 12;

  const startedAt = Date.now();
  // Every request actually sent to Google, including the ones that failed.
  let apiCalls = 0;
  // Raised once a model reports MAX_TOKENS, so the retry has room to finish.
  let maxOutputTokens = BASE_MAX_OUTPUT_TOKENS;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) {
      throw Object.assign(new Error("Question solving aborted"), { apiCalls });
    }

    // Stop once this question has had its share of time. A worker stuck behind a
    // saturated pool blocks every question queued behind it, so it is better to
    // fail here and let the batch continue than to hold the slot indefinitely.
    const elapsed = Date.now() - startedAt;
    if (elapsed > QUESTION_BUDGET_MS) {
      throw Object.assign(
        new Error(
          lastError?.message ||
            `Gave up after ${Math.round(elapsed / 1000)}s: the DeepSeek key pool is rate-limited. Use "Retry failed" once it recovers.`,
        ),
        { apiCalls },
      );
    }

    // Wait for the (key, model) bucket that frees up soonest. This is the only
    // pacing in the pipeline - it is what keeps us under the per-minute cap.
    // A throw here (no usable keys, saturated pool, or aborted) is terminal for
    // this question: retrying immediately cannot help.
    const remainingBudget = QUESTION_BUDGET_MS - elapsed;
    let key: string;
    let modelName: string;
    let release: () => void;
    try {
      const slot = await acquireSlot(allKeys, signal, Math.min(slotWaitCeiling, remainingBudget));
      key = slot.key;
      modelName = slot.modelName;
      release = slot.release;
    } catch (slotErr: any) {
      // Attach the spend so far so the caller still bills what was used.
      throw Object.assign(slotErr, { apiCalls });
    }

    // Per-request deadline that also honours the caller's cancellation. The old
    // SDK silently dropped `signal` - it is not a member of its RequestOptions -
    // so aborting a batch never actually cancelled anything already in flight.
    const timeoutCtl = new AbortController();
    const timer = setTimeout(() => timeoutCtl.abort(), REQUEST_TIMEOUT_MS);
    const abortSignal = signal ? AbortSignal.any([signal, timeoutCtl.signal]) : timeoutCtl.signal;

    try {
      const ai = getGenAIClient(key);
      apiCalls++;
      // Gemma exposes no system role, so its instruction has to ride along in
      // the user turn. Sending systemInstruction to it is rejected.
      const gemma = isGemmaModel(modelName);
      const response = await ai.models.generateContent({
        model: modelName,
        contents: gemma ? `${systemInstruction}\n\n${prompt}` : prompt,
        config: {
          ...(gemma ? {} : { systemInstruction }),
          temperature: 0.1,
          topP: 0.1,
          maxOutputTokens,
          thinkingConfig: SOLVER_THINKING_CONFIG,
          safetySettings: defaultSafetySettings,
          abortSignal,
        },
      });

      // Reject a truncated answer instead of saving it. finishReason MAX_TOKENS
      // means the model was still writing, so the text is missing whatever comes
      // last - usually the Answer line and the Solution. Retrying on the same
      // cap reproduces the same truncation, so give the next attempt more room.
      const finishReason = response.candidates?.[0]?.finishReason;
      if (finishReason === "MAX_TOKENS") {
        maxOutputTokens = ESCALATED_MAX_OUTPUT_TOKENS;
        lastError = new Error(
          `Model ${modelName} hit the output limit and returned a truncated answer`,
        );
        continue;
      }

      const text = getResponseTextSafely(response);
      if (text && text.trim().length > 0) {
        // This bucket clearly still has quota, so clear any exhaustion suspicion.
        noteSlotSuccess(key, modelName);
        return { text: sanitizeAiOutput(latexToText(text), idx, subjectType), apiCalls };
      }

      // Answered 200 with nothing usable - a safety block, or an empty candidate.
      // Park the bucket briefly and record why, so the final error is not blank.
      lastError = new Error(
        `Model ${modelName} returned an empty response (finishReason ${finishReason ?? "unknown"})`,
      );
      penalizeSlotTransient(key, modelName);
      continue;
    } catch (error: any) {
      lastError = error;
      const msg = (error?.message || "").toLowerCase();
      const status = error?.status;

      if (signal?.aborted) {
        throw Object.assign(new Error("Question solving aborted"), { apiCalls });
      }

      // Bad-key handling. The SDK appends the upstream error payload to the
      // message, so the `reason` (e.g. API_KEY_INVALID) is matchable here even
      // though that error arrives as HTTP 400 rather than 403.
      //
      // 401 matters as much as 403. Measured on this pool: three keys return
      // 401 UNAUTHENTICATED "The bound service account is deleted or disabled",
      // which is permanent - the project behind the key is broken. Without this
      // branch they were only bucket-parked, so each one came back every half
      // hour and burned four more attempts before parking again.
      const isDeadKey =
        msg.includes("api_key_invalid") ||
        msg.includes("consumer_suspended") ||
        msg.includes("service account is deleted") ||
        msg.includes("service account bound to the api key") ||
        msg.includes("unauthenticated") ||
        status === 401;
      if (isDeadKey || status === 403 || msg.includes("denied access")) {
        // A key Google reports as invalid/suspended will not recover on its own,
        // so park it for hours instead of letting it re-enter rotation every 10
        // minutes and burn one failure per model each time. Rotating the key in
        // Team settings produces a different string, which is tracked separately
        // and is therefore unaffected by this entry.
        disabledKeysUntil.set(key, Date.now() + (isDeadKey ? 6 * 60 * 60 * 1000 : 10 * 60 * 1000));
        poolStats.deadKey++;
        console.warn(
          `[DeepSeek] Disabling key ...${key.slice(-6)} for ${isDeadKey ? "6h" : "10m"}: ${(error?.message || "").slice(0, 120)}`,
        );
        continue;
      }

      const { isRateLimitOr503, retryAfterMs } = classifyError(error);

      if (isRateLimitOr503) {
        // Push only this bucket out; every other bucket stays available. The
        // next attempt waits for whichever bucket frees up soonest.
        penalizeSlot(key, modelName, retryAfterMs);
        continue;
      }

      // Everything else - a 404 for a retired model, a 400, a backend 500, a
      // client timeout. Park the bucket so a systematically broken one does not
      // sit permanently at the front of the free set out-competing healthy ones.
      penalizeSlotTransient(key, modelName);
      continue;
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  throw Object.assign(
    new Error(
      lastError?.message || "Failed to solve question across all DeepSeek keys and models.",
    ),
    { apiCalls },
  );
}

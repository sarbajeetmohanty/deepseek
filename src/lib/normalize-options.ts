// Canonical Option, Statement, Table, and Answer Normalizer
// - Enforces A., B., C., D. Latin option prefixes across all questions
// - Preserves lowercase (a., b., c., d.) for Column A match-the-column items ("a chota aaye bas")
// - Unglues Column B and numbered items into side-by-side table rows ("amnae samne")
// - Prevents Hindi letters (उ., ख., क., अ., ए., बी., सी., डी., etc.) from appearing as options
// - Splits inline/horizontal options, unglues sub-statements ("1वैगनर" -> "1 वैगनर")
// - Normalizes Assertion-Reason headers and Answer: labels end-to-end.

export function normalizeOptionsInText(text: string): string {
  let s = text;

  // 1. Normalize assertion / reason headers: "कथन (ए):" -> "कथन (A):", "कारण (आर):" -> "कारण (R):"
  s = s.replace(/(?:^|\n)\s*(\b(?:अभिकथन|कथन|Statement|Assertion)\s*[:.\-]?\s*)\((?:[Aए]|अ)\)\s*[:.\-]?/gi, "\nकथन (A): ");
  s = s.replace(/(?:^|\n)\s*(\b(?:कारण|दलील|Reason)\s*[:.\-]?\s*)\((?:[Rआर]|r)\)\s*[:.\-]?/gi, "\nकारण (R): ");

  // 2. In Assertion/Reason options, normalize (ए) -> (A) and (आर) -> (R) inside the body text
  s = s.replace(/(\b(?:और|\,|तथा|लेकिन|कि)\s*)\(ए\)/gi, "$1(A)");
  s = s.replace(/\(ए\)(\s*(?:और|तथा|का|की|के|सही|गलत|दोनों))/gi, "(A)$1");
  s = s.replace(/(\b(?:और|\,|तथा|लेकिन|कि)\s*)\(आर\)/gi, "$1(R)");
  s = s.replace(/\(आर\)(\s*(?:और|तथा|का|की|के|सही|गलत|दोनों))/gi, "(R)$1");

  // 3. Add space after sub-statement number if stuck directly to Devanagari or English text (e.g. "1वैगनर" -> "1 वैगनर")
  s = s.replace(/(?:^|\n)\s*([1-9]|10)(?=[\u0900-\u097FA-Za-z])/gm, "\n$1 ");

  // 4. Match-The-Column Normalization:
  // Unglue Column B if stuck to end of Column A item (e.g. "...हड़प्पा कॉलम बी: 1 बढ़िया...")
  s = s.replace(/(?<=\S)[^\S\r\n]+((?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*\(?(?:B|II|2|बी)\)?(?:\([^\)\n]+\))?\s*[:.-]\s*)/gim, "\n$1\n");

  // Normalize standalone Column A and Column B headers
  s = s.replace(/(?:^|\n)\s*(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*\(?(?:A|I|1|ए)\)?(?:\([^\)\n]+\))?\s*[:.-]\s*/gim, "\nColumn A:\n");
  s = s.replace(/(?:^|\n)\s*(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*\(?(?:B|II|2|बी)\)?(?:\([^\)\n]+\))?\s*[:.-]\s*/gim, "\nColumn B:\n");

  // Split inline numbered items in Column B (e.g. "1 item 2 item 3 item 4 item")
  const colLines = s.split("\n");
  let inColB = false;
  for (let i = 0; i < colLines.length; i++) {
    const l = colLines[i].trim();
    if (/^Column\s*B:/i.test(l)) {
      inColB = true;
      continue;
    }
    if (inColB && (/^\s*(?:उत्तर\s*|सही\s*)?(?:कूट|कोड|Code|Codes)\s*[:.\-]?/i.test(l) || /^\s*[A-D]\.\s+\d/i.test(l) || /^\s*(?:Answer|Ans|उत्तर)\s*[:.-]/i.test(l))) {
      inColB = false;
      continue;
    }
    if (inColB) {
      if (/(?:^|\s*)1\s+[^\d]+(?:\s+)2\s+/i.test(l)) {
        let splitItems = l
          .replace(/(?:^|\s*)1\s+([^\d]+)/, "\n1. $1")
          .replace(/\s+2\s+([^\d]+)/, "\n2. $1")
          .replace(/\s+3\s+([^\d]+)/, "\n3. $1")
          .replace(/\s+4\s+([^\d]+)/, "\n4. $1")
          .trim();
        colLines[i] = splitItems;
      }
    }
  }
  s = colLines.join("\n");

  // Ensure Column A items use lowercase letters: a., b., c., d. ("a chota aaye bas")
  const colLines2 = s.split("\n");
  let inColA = false;
  for (let i = 0; i < colLines2.length; i++) {
    const l = colLines2[i].trim();
    if (/^Column\s*A:/i.test(l)) {
      inColA = true;
      continue;
    }
    if (/^Column\s*B:/i.test(l)) {
      inColA = false;
      continue;
    }
    if (inColA) {
      colLines2[i] = colLines2[i].replace(/^\s*([A-Da-d])\s*[:.\)]\s*/, (m, letter) => `${letter.toLowerCase()}. `);
      colLines2[i] = colLines2[i].replace(/^\s*क\s*[:.\)]\s*/, "a. ");
      colLines2[i] = colLines2[i].replace(/^\s*ख\s*[:.\)]\s*/, "b. ");
      colLines2[i] = colLines2[i].replace(/^\s*ग\s*[:.\)]\s*/, "c. ");
      colLines2[i] = colLines2[i].replace(/^\s*घ\s*[:.\)]\s*/, "d. ");
    }
  }
  s = colLines2.join("\n");

  // 5. Split horizontal sub-statements (e.g. "...पहला कथन। 2. दूसरा कथन")
  s = s.replace(/(?<=[।;]|\S[^\S\r\n]{2,})(?=(?:\(([2-9]|10)\)|([2-9]|10))[.,):\-–—]?\s+[^\s\d])/g, "\n");

  // 6. Split horizontal options on the same line (e.g. "...है। बी. ..." or "...है। B. ..." or "(a) Opt 1   (b) Opt 2")
  const splitPattern = /(?<!Answer:)(?:(?<=[।\?!;])\s*|(?<=[^A-Da-d0-9]\.)\s*|(?<=\S)[^\S\r\n]{2,})(?=(?:[B-Db-d][.)](?!\s*[A-Za-z]\.)|\([b-dB-D]\)|[B-Db-d]\)|(?:[खबगसघद]|बी|सी|डी)[.)]|\((?:[खबगसघद]|बी|सी|डी)\)|(?:[खबगसघद]|बी|सी|डी)\))\s+)/g;
  s = s.replace(splitPattern, "\n");

  let lines = s.split("\n");
  let inColumn = false;
  let inSolution = false;
  let seenAnswer = false;
  let seenQuestionTitle = false;
  let seenOptions = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    // First non-empty line is the question header/title (e.g. "1. निम्नलिखित कथनों पर विचार कीजिए:")
    // Keep question number with its dot untouched!
    if (!seenQuestionTitle) {
      seenQuestionTitle = true;
      continue;
    }

    // Column table detection: ignore lines inside Column A/B table so items (a., b., c., d.) remain lowercase
    if (/^(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*\(?(?:A|I|1|ए)\)?/i.test(trimmed)) {
      inColumn = true;
      continue;
    }
    if (inColumn && (
      /^(?:उत्तर\s*|सही\s*)?(?:कूट|कोड|Code|Codes)\s*[:.\-]?/i.test(trimmed) ||
      /^(?:[A-Da-d][.)]|\([A-Da-d]\))\s+(?:[a-dA-D1-4]\s*[-–—:,]|\d\s*,\s*\d|केवल)/i.test(trimmed)
    )) {
      inColumn = false;
    }
    if (/^\s*(?:Answer|Ans|उत्तर)\s*[:.-]/i.test(trimmed)) {
      inColumn = false;
      seenAnswer = true;
    }
    if (/^\s*(?:Solution|Sol|हल|समाधान)\s*[:.-]/i.test(trimmed)) {
      inSolution = true;
    }
    if (inSolution) {
      const solStepMatch = trimmed.match(/^(\((?:\d{1,2})\)|\d{1,2})\s*[.,):\-–—]?\s+(.*)$/);
      if (solStepMatch) {
        const rawNum = solStepMatch[1].replace(/[\(\)]/g, "");
        lines[i] = `${rawNum} ${solStepMatch[2].trim()}`;
      }
      continue;
    }
    if (seenAnswer || inColumn) {
      continue;
    }

    // Skip assertion/reason lines
    if (/^(\s*(?:अभिकथन|कथन|कारण|दलील|Assertion|Reason|Statement)\s*(?:[\-–—\s]*(?:I{1,3}|IV|V|[A-Za-z0-9]|ए|आर)|\((?:[A-Za-z0-9]|ए|आर)+\))\s*[:.\-]?)/i.test(trimmed)) {
      continue;
    }

    // Skip lines starting with abbreviations like B.C., A.D., C.E.
    if (/^\s*[A-Za-z]\.(?:\s*[A-Za-z]\.)+/i.test(trimmed)) {
      continue;
    }

    // Check if line is an option (A-D or Hindi letters)
    const isOptA = /^\s*(?:__OPT_A__|[Aa][.)\s]|(?:\([Aa]\))|(?:[कअउ][.)\s]|ए\.\s+|एक[।.]|(?:\([कअउ]\))|[कअउ]\)))\s*/i.test(line);
    const isOptB = /^\s*(?:__OPT_B__|[Bb][.)\s]|(?:\([Bb]\))|(?:(?:[खब]|बी)[.)\s]|दो[।.]|(?:\((?:[खब]|बी)\))|(?:[खब]|बी)\)))\s*/i.test(line);
    const isOptC = /^\s*(?:__OPT_C__|[Cc][.)\s]|(?:\([Cc]\))|(?:(?:[गस]|सी)[.)\s]|तीन[।.]|(?:\((?:[गस]|सी)\))|(?:[गस]|सी)\)))\s*/i.test(line);
    const isOptD = /^\s*(?:__OPT_D__|[Dd][.)\s]|(?:\([Dd]\))|(?:(?:[घद]|डी)[.)\s]|चार[।.]|(?:\((?:[घद]|डी)\))|(?:[घद]|डी)\)))\s*/i.test(line);

    if (isOptA || isOptB || isOptC || isOptD) {
      seenOptions = true;
    }

    // Sub-statement normalization: BEFORE options have appeared
    // Format must strictly be "1 <text>", "2 <text>", "3 <text>" with NO symbol like . or , or ) after the number
    if (!seenOptions) {
      // Ignore question trailer phrases like "उपर्युक्त कथनों में से कौन-सा/से सही है/हैं?"
      if (!/^(?:उपर्युक्त|उपरोक्त|इनमें|निम्न|Which of the|Of the above)/i.test(trimmed)) {
        const subPointMatch = trimmed.match(/^(\((?:[1-9]|10|i{1,3}|iv|v|vi)\)|([1-9]|10|i{1,3}|iv|v|vi))\s*[.,):\-–—]?\s+(.*)$/i);
        if (subPointMatch) {
          const rawNum = (subPointMatch[2] || subPointMatch[1]).replace(/[\(\)]/g, "");
          lines[i] = `${rawNum} ${subPointMatch[3].trim()}`;
          continue;
        }
      }
    }

    // Replace __OPT_X__ translation placeholders first if present
    if (/^\s*__OPT_A__\s*/i.test(line)) {
      lines[i] = line.replace(/^\s*__OPT_A__\s*/i, "A. ");
      continue;
    }
    if (/^\s*__OPT_B__\s*/i.test(line)) {
      lines[i] = line.replace(/^\s*__OPT_B__\s*/i, "B. ");
      continue;
    }
    if (/^\s*__OPT_C__\s*/i.test(line)) {
      lines[i] = line.replace(/^\s*__OPT_C__\s*/i, "C. ");
      continue;
    }
    if (/^\s*__OPT_D__\s*/i.test(line)) {
      lines[i] = line.replace(/^\s*__OPT_D__\s*/i, "D. ");
      continue;
    }

    // Option A: A., (A), (a), A), a., उ., (उ), उ), क., (क), क), अ., (अ), अ), ए., (ए), ए), एक।, एक.
    if (isOptA) {
      lines[i] = line.replace(/^\s*(?:[Aa][.)\s]|(?:\([Aa]\))|(?:[कअउ][.)\s]|ए\.\s+|एक[।.]|(?:\([कअउ]\))|[कअउ]\)))\s*/i, "A. ");
      continue;
    }

    // Option B: B., (B), (b), B), b., ख., (ख), ख), ब., (ब), ब), बी., (बी), बी), दो।, दो.
    if (isOptB) {
      lines[i] = line.replace(/^\s*(?:[Bb][.)\s]|(?:\([Bb]\))|(?:(?:[खब]|बी)[.)\s]|दो[।.]|(?:\((?:[खब]|बी)\))|(?:[खब]|बी)\)))\s*/i, "B. ");
      continue;
    }

    // Option C: C., (C), (c), C), c., ग., (ग), ग), स., (स), स), सी., (सी), सी), तीन।, तीन.
    if (isOptC) {
      lines[i] = line.replace(/^\s*(?:[Cc][.)\s]|(?:\([Cc]\))|(?:(?:[गस]|सी)[.)\s]|तीन[।.]|(?:\((?:[गस]|सी)\))|(?:[गस]|सी)\)))\s*/i, "C. ");
      continue;
    }

    // Option D: D., (D), (d), D), d., घ., (घ), घ), द., (द), द), डी., (डी), डी), चार।, चार.
    if (isOptD) {
      lines[i] = line.replace(/^\s*(?:[Dd][.)\s]|(?:\([Dd]\))|(?:(?:[घद]|डी)[.)\s]|चार[।.]|(?:\((?:[घद]|डी)\))|(?:[घद]|डी)\)))\s*/i, "D. ");
      continue;
    }
  }

  return lines.join("\n");
}

export function normalizeAnswerInText(text: string): string {
  let s = text;
  // Replace translation marker if present
  s = s.replace(/^\s*__ANS__\s*/gim, "Answer: ");
  // Match Answer line with English or Hindi option label
  s = s.replace(/^\s*(?:Ans(?:wer)?|उत्तर)\s*[:.-]\s*(?:Option\s*)?(?:[\(]?([A-Da-d1-4कअउएखबगसघद]|बी|सी|डी)[\)]?\.?)(?:\s|$|\.)/gim, (m, g1) => {
    let letter = g1.toUpperCase();
    if (/[1Aकअउए]/.test(letter)) letter = "A";
    else if (/[2Bखब]|बी/.test(letter)) letter = "B";
    else if (/[3Cगस]|सी/.test(letter)) letter = "C";
    else if (/[4Dघद]|डी/.test(letter)) letter = "D";
    return `Answer: ${letter}\n`;
  });
  return s;
}

export function protectOptionsForTranslation(text: string): string {
  return text
    .replace(/(?:^|\n)\s*A\.\s+/g, "\n__OPT_A__ ")
    .replace(/(?:^|\n)\s*B\.\s+/g, "\n__OPT_B__ ")
    .replace(/(?:^|\n)\s*C\.\s+/g, "\n__OPT_C__ ")
    .replace(/(?:^|\n)\s*D\.\s+/g, "\n__OPT_D__ ")
    .replace(/(?:^|\n)\s*Answer:\s*/gi, "\n__ANS__ ");
}

// Canonical Option and Answer Normalizer
// Enforces A., B., C., D. Latin option prefixes across all questions,
// preventing Hindi letters (उ., ख., क., अ., ए., बी., सी., डी., etc.)
// from appearing as options, and normalizing Answer: labels end-to-end.

export function normalizeOptionsInText(text: string): string {
  let s = text;

  // First split horizontal options on same line (e.g. "(a) Opt 1   (b) Opt 2" or "(क) Opt 1   (ख) Opt 2")
  s = s.replace(/(?<!Answer:)(?<=\S)[^\S\r\n]{2,}(?=(?:[A-Ha-h][.)](?!\s*[A-Za-z]\.)|\([a-hA-H1-8]\)|(?:[कअउएखबगसघद]|बी|सी|डी)[.)]|\((?:[कअउएखबगसघद]|बी|सी|डी)\))(?:\s+|$))/g, "\n");

  let lines = s.split("\n");
  let inColumn = false;
  let inSolution = false;
  let seenAnswer = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Column table detection: ignore lines inside Column A/B table
    if (/^(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*\(?(?:A|I|1)\)?/i.test(trimmed)) {
      inColumn = true;
      continue;
    }
    if (inColumn && /^(?:उत्तर\s*|सही\s*)?(?:कूट|कोड|Code|Codes)\s*[:.\-]?/i.test(trimmed)) {
      inColumn = false;
    }
    if (/^\s*(?:Answer|Ans|उत्तर)\s*[:.-]/i.test(trimmed)) {
      inColumn = false;
      seenAnswer = true;
    }
    if (/^\s*(?:Solution|Sol|हल|समाधान)\s*[:.-]/i.test(trimmed)) {
      inSolution = true;
    }
    if (seenAnswer || inSolution || inColumn) {
      continue;
    }

    // Skip assertion/reason lines
    if (/^(\s*(?:अभिकथन|कथन|कारण|दलील|Assertion|Reason|Statement)\s*(?:[\-–—\s]*(?:I{1,3}|IV|V|[A-Za-z0-9])|\([A-Za-z0-9]+\))\s*[:.\-]?)/i.test(trimmed)) {
      continue;
    }

    // Skip lines starting with abbreviations like B.C., A.D., C.E.
    if (/^\s*[A-Za-z]\.(?:\s*[A-Za-z]\.)+/i.test(trimmed)) {
      continue;
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
    if (/^\s*(?:[Aa][.)\s]|(?:\([Aa]\))|(?:[कअउए][.)\s]|एक[।.]|(?:\([कअउए]\))|[कअउए]\)))\s*/i.test(line)) {
      lines[i] = line.replace(/^\s*(?:[Aa][.)\s]|(?:\([Aa]\))|(?:[कअउए][.)\s]|एक[।.]|(?:\([कअउए]\))|[कअउए]\)))\s*/i, "A. ");
      continue;
    }

    // Option B: B., (B), (b), B), b., ख., (ख), ख), ब., (ब), ब), बी., (बी), बी), दो।, दो.
    if (/^\s*(?:[Bb][.)\s]|(?:\([Bb]\))|(?:(?:[खब]|बी)[.)\s]|दो[।.]|(?:\((?:[खब]|बी)\))|(?:[खब]|बी)\)))\s*/i.test(line)) {
      lines[i] = line.replace(/^\s*(?:[Bb][.)\s]|(?:\([Bb]\))|(?:(?:[खब]|बी)[.)\s]|दो[।.]|(?:\((?:[खब]|बी)\))|(?:[खब]|बी)\)))\s*/i, "B. ");
      continue;
    }

    // Option C: C., (C), (c), C), c., ग., (ग), ग), स., (स), स), सी., (सी), सी), तीन।, तीन.
    if (/^\s*(?:[Cc][.)\s]|(?:\([Cc]\))|(?:(?:[गस]|सी)[.)\s]|तीन[।.]|(?:\((?:[गस]|सी)\))|(?:[गस]|सी)\)))\s*/i.test(line)) {
      lines[i] = line.replace(/^\s*(?:[Cc][.)\s]|(?:\([Cc]\))|(?:(?:[गस]|सी)[.)\s]|तीन[।.]|(?:\((?:[गस]|सी)\))|(?:[गस]|सी)\)))\s*/i, "C. ");
      continue;
    }

    // Option D: D., (D), (d), D), d., घ., (घ), घ), द., (द), द), डी., (डी), डी), चार।, चार.
    if (/^\s*(?:[Dd][.)\s]|(?:\([Dd]\))|(?:(?:[घद]|डी)[.)\s]|चार[।.]|(?:\((?:[घद]|डी)\))|(?:[घद]|डी)\)))\s*/i.test(line)) {
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

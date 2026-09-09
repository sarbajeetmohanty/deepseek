// Canonical Option, Statement, Table, and Answer Normalizer
// - Enforces A., B., C., D. Latin option prefixes across all questions
// - Preserves lowercase (a., b., c., d.) for Column A match-the-column items ("a chota aaye bas")
// - Unglues Column B and numbered items into side-by-side table rows ("amnae samne")
// - Prevents Hindi letters (उ., ख., क., अ., ए., बी., सी., डी., etc.) from appearing as options
// - Splits inline/horizontal options, unglues sub-statements ("1वैगनर" -> "1 वैगनर")
// - Normalizes Assertion-Reason headers and Answer: labels end-to-end.

export function healSolutionTables(text: string): string {
  const solIdx = text.search(/(?:^|\n)\s*(?:Solution|Sol|हल|समाधान)\s*[:.-]/i);
  if (solIdx === -1) return text;

  const preSol = text.slice(0, solIdx);
  const solPart = text.slice(solIdx);

  // Check if Solution part contains bogus Column A / Column B headers or table markers
  if (!/(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*\(?(?:A|B|I{1,3}|1|2)\)?/i.test(solPart)) {
    return text;
  }

  const solLines = solPart.split("\n");
  const cleanedSolLines: string[] = [];
  let inBogusTable = false;
  let bogusColA: string[] = [];
  let bogusColB: string[] = [];
  let inBogusColA = false;
  let inBogusColB = false;

  for (let i = 0; i < solLines.length; i++) {
    const l = solLines[i];
    const trimmed = l.trim();

    if (/^(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*\(?(?:A|I|1|ए)\)?[:.\-]?/i.test(trimmed)) {
      inBogusTable = true;
      inBogusColA = true;
      inBogusColB = false;
      continue;
    }
    if (/^(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*\(?(?:B|II|2|बी)\)?[:.\-]?/i.test(trimmed)) {
      inBogusColA = false;
      inBogusColB = true;
      continue;
    }

    if (inBogusTable) {
      if (inBogusColA) {
        bogusColA.push(trimmed);
      } else if (inBogusColB) {
        bogusColB.push(trimmed);
      }
    } else {
      cleanedSolLines.push(l);
    }
  }

  if (bogusColA.length > 0 || bogusColB.length > 0) {
    const reconstructed: string[] = [];

    // Clean Col A items: strip dummy "a. " or "b. "
    const cleanA = bogusColA.map(item => {
      return item.replace(/^\s*(?:[a-hA-H][.)]|\([a-hA-H]\))\s*/i, "").trim();
    }).filter(Boolean);

    // Clean Col B items:
    const cleanB: string[] = [];
    for (let k = 0; k < bogusColB.length; k++) {
      let item = bogusColB[k].trim();
      if (!item) continue;

      // Check if item has double numbering from table row index e.g. "2 7 यह सूची..." -> "7 यह सूची..."
      const doubleNumMatch = item.match(/^\s*\d{1,2}\s+([1-9]|10)\s+(.*)$/);
      if (doubleNumMatch) {
        cleanB.push(`${doubleNumMatch[1]} ${doubleNumMatch[2]}`);
        continue;
      }

      // Check if item is a trailing verb fragment e.g. "1 है।" or "1. है।" or "है।"
      const fragmentMatch = item.match(/^\s*(?:\d{1,2}[.)]?\s*)?(है[।.]?|होता[।.]?|होती[।.]?|थे[।.]?|थी[।.]?)$/);
      if (fragmentMatch && cleanA.length > 0 && cleanB.length === 0) {
        // Attach to last cleanA item
        let lastA = cleanA[cleanA.length - 1];
        if (/,\s*[a-d]$/i.test(lastA) || /\s+[a-d]$/i.test(lastA)) {
          lastA = lastA + "-4 " + fragmentMatch[1];
        } else {
          lastA = lastA + " " + fragmentMatch[1];
        }
        cleanA[cleanA.length - 1] = lastA;
        continue;
      }

      // Otherwise strip leading table row index if item already starts with or is text
      const singleNum = item.match(/^\s*(\d{1,2})[.)]?\s+(.*)$/);
      if (singleNum) {
        cleanB.push(`${singleNum[1]} ${singleNum[2]}`);
      } else {
        cleanB.push(item);
      }
    }

    reconstructed.push(...cleanA, ...cleanB);
    cleanedSolLines.push(...reconstructed);
  }

  // Renumber and clean points inside Solution so they are strictly sequential "1 ...", "2 ..."
  let currentStep = 0;
  for (let i = 0; i < cleanedSolLines.length; i++) {
    const line = cleanedSolLines[i].trim();
    if (!line) continue;
    if (/^(?:Solution|Sol|हल|समाधान)\s*[:.-]/i.test(line)) continue;
    
    // Check if line starts with a number e.g. "1 ...", "6 ...", "7 ..."
    const numMatch = line.match(/^(\d{1,2})\s*[.,):\-–—]?\s+(.*)$/);
    if (numMatch) {
      currentStep++;
      cleanedSolLines[i] = `${currentStep} ${numMatch[2].trim()}`;
    } else if (currentStep > 0 && !/^[-•·●○◦]\s+/.test(line)) {
      // Continuation or unnumbered step
      currentStep++;
      cleanedSolLines[i] = `${currentStep} ${line}`;
    }
  }

  return preSol + cleanedSolLines.join("\n");
}

export function healCorruptedMatchTitle(text: string): string {
  let s = text;

  // 1. Case where question line 1 is "<num>. Column A:" and lines 2+ contain title keywords before real Column A
  const lines = s.split("\n");
  if (lines.length > 3 && /^\s*(\d{1,4})[.)]?\s*Column\s*A:\s*$/i.test(lines[0].trim())) {
    const qNumMatch = lines[0].match(/^\s*(\d{1,4})/);
    if (qNumMatch) {
      const qNum = qNumMatch[1];
      let realColAIdx = -1;
      for (let k = 1; k < lines.length && k < 10; k++) {
        if (/^(?:\d{1,2}[.)]?\s*)?Column\s*A:\s*$/i.test(lines[k].trim())) {
          realColAIdx = k;
          break;
        }
      }
      if (realColAIdx > 0) {
        const titleLines = lines.slice(1, realColAIdx)
          .map(l => l.replace(/^\s*(?:[A-Da-d1-4][.)\s]|\([A-Da-d1-4]\)|Column\s*[AB]:?)\s*/gi, "").trim())
          .filter(Boolean);

        let titleText = titleLines.join(" ")
          .replace(/\s+/g, " ")
          .replace(/^सूची\s+I\b/i, "सूची-I")
          .replace(/सूची\s+II\b/i, "सूची-II");

        if (!titleText.startsWith("सूची") && /I\s*\(/.test(titleText)) {
          titleText = "सूची-" + titleText;
        }

        const newQLine = `${qNum}. ${titleText}`;
        const after = lines.slice(realColAIdx + 1);
        s = [newQLine, "Column A:", ...after].join("\n");
      }
    }
  }

  // 2. Pattern: Question number followed immediately by Column A: etc in one line or multiline
  const matchCorruptedPattern = /^\s*(\d{1,4})[.)]?\s*(?:Column\s*A:)?\s*(?:[A-Da-d1-4][.)]?\s*)?(?:सूची|कॉलम|स्तंभ|List|Column)\s*(?:Column\s*A:)?\s*(?:Column\s*B:)?\s*(?:[1-4][.)]?\s*)?([I1A]\s*\([^\)\n]+\)[^\n]*?(?:सूची|कॉलम|स्तंभ|List|Column)\s*[-–—]?\s*[II2B]\s*\([^\)\n]+\)[^\n]*?[:.\-])\s*(?:\d{1,2}[.)]?\s*)?(?:Column\s*A:)?/i;
  const m = s.match(matchCorruptedPattern);
  if (m) {
    const qNum = m[1];
    const fullTitle = `${qNum}. सूची-${m[2].trim()}`;
    s = s.replace(matchCorruptedPattern, `${fullTitle}\nColumn A:`);
  }

  // 3. Fix 'उसने इसे बनाया' mistranslation of 'बनावली'
  s = s.replace(/(?:^|\n)\s*([A-Da-d][.)\s]|\([A-Da-d]\))\s*उसने इसे बनाया/gi, "\n$1 बनावली");
  s = s.replace(/उसने इसे बनाया/g, "बनावली");

  return s;
}

export function normalizeOptionsInText(text: string): string {
  let s = text;

  // -2. Heal corrupted match-the-column titles and translations
  s = healCorruptedMatchTitle(s);

  // -1. Clean any bogus match-the-column tables from inside the Solution section
  s = healSolutionTables(s);

  // 0. Restore translation option & answer placeholders in any variant (e.g. __OPT_A__, _OPTA_, _OPT_A_, _OPTA, OPTA)
  s = s.replace(/(?:^|\n)\s*[_*]*OPT[_\s\-]*A[_*]*[:.\s]*/gim, "\nA. ");
  s = s.replace(/(?:^|\n)\s*[_*]*OPT[_\s\-]*B[_*]*[:.\s]*/gim, "\nB. ");
  s = s.replace(/(?:^|\n)\s*[_*]*OPT[_\s\-]*C[_*]*[:.\s]*/gim, "\nC. ");
  s = s.replace(/(?:^|\n)\s*[_*]*OPT[_\s\-]*D[_*]*[:.\s]*/gim, "\nD. ");
  s = s.replace(/(?:^|\n)\s*(?:__ANS__|_ANS_|[_*]+ANS[_\s\-*]*|(?:Answer|Ans|उत्तर)\s*[:.\-])\s*/gim, "\nAnswer: ");

  // 0.1 Reunite stranded question number on line 1: "22.\nText..." -> "22. Text..."
  s = s.replace(/^\s*(\d{1,4}[.:\-)\]])\s*\n\s*(?=\S)/, "$1 ");

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
  // Unglue Column B if stuck to end of Column A item (e.g. "...हड़प्पा कॉलम बी: 1 बढ़िया..." or "...बदला Column B:")
  s = s.replace(/(?<=\S)[^\S\r\n]+((?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*\(?(?:B|II|2|बी)\)?(?:\([^\)\n]+\))?\s*[:.-]\s*)/gim, "\n$1\n");

  // Normalize standalone Column A and Column B headers
  s = s.replace(/(?:^|\n)\s*(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*\(?(?:A|I|1|ए)\)?(?:\([^\)\n]+\))?\s*[:.-]\s*/gim, "\nColumn A:\n");
  s = s.replace(/(?:^|\n)\s*(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*\(?(?:B|II|2|बी)\)?(?:\([^\)\n]+\))?\s*[:.-]\s*/gim, "\nColumn B:\n");

  // If there are two "Column A:" headers before Answer/Solution, convert the second one to "Column B:"
  const colLinesHeaders = s.split("\n");
  let hasColAHeader = false;
  let inAnsOrSolHead = false;
  for (let i = 0; i < colLinesHeaders.length; i++) {
    const l = colLinesHeaders[i].trim();
    if (/^(?:Answer|Ans|उत्तर|Solution|Sol|हल|समाधान)\s*[:.-]/i.test(l)) {
      inAnsOrSolHead = true;
    }
    if (inAnsOrSolHead) continue;
    if (/^Column\s*A:/i.test(l)) {
      if (!hasColAHeader) {
        hasColAHeader = true;
      } else {
        colLinesHeaders[i] = "Column B:";
      }
    }
    if (/^Column\s*B:/i.test(l)) {
      hasColAHeader = false;
    }
  }
  s = colLinesHeaders.join("\n");

  // Heal match-the-column questions where Column A was generated with dummy items or Column A is missing
  let healLines = s.split("\n");
  // Step A: If Column B exists without a preceding Column A, recover items above Column B
  let inAnsOrSolA = false;
  for (let i = 0; i < healLines.length; i++) {
    const l = healLines[i].trim();
    if (/^(?:Answer|Ans|उत्तर|Solution|Sol|हल|समाधान)\s*[:.-]/i.test(l)) {
      inAnsOrSolA = true;
    }
    if (inAnsOrSolA) continue;
    if (/^Column\s*B:/i.test(l)) {
      let hasColA = false;
      for (let j = i - 1; j >= 0; j--) {
        if (/^Column\s*A:/i.test(healLines[j].trim())) {
          hasColA = true;
          break;
        }
        if (/^\s*(?:#+\s*)?(?:(?:[Qq]\.?(?:uestion)?|प्रश्न|सवाल)\s*[:.-]?\s*\d+|\d{1,4}[.:\-)\]]\s+)/i.test(healLines[j].trim())) {
          break;
        }
      }

      if (!hasColA) {
        let startPre = i - 1;
        const preItems = [];
        while (startPre >= 0) {
          const prev = healLines[startPre].trim();
          if (!prev) {
            startPre--;
            continue;
          }
          if (/^\s*(?:#+\s*)?(?:(?:[Qq]\.?(?:uestion)?|प्रश्न|सवाल)\s*[:.-]?\s*\d+|\d{1,4}[.:\-)\]]\s+)/i.test(prev)) {
            break;
          }
          if (/^\s*(?:Answer|Ans|उत्तर|Solution|Sol|हल|Code|Codes|कूट|कोड)\s*[:.-]/i.test(prev)) {
            break;
          }
          const isItem = /^\s*(?:\(?\d{1,2}\)?|\d{1,2}[.)]?|[a-hA-H][.)]?|\([a-hA-H]\)|[ivxIVX]{1,4}[.)]?)\s+\S+/.test(prev);
          if (isItem) {
            preItems.unshift({ lineIndex: startPre, text: prev });
            startPre--;
          } else {
            break;
          }
        }

        if (preItems.length > 0) {
          const newColALines = preItems.map((item, idx) => {
            const stripped = item.text.replace(/^\s*(?:\(?\d{1,2}\)?|\d{1,2}[.)]?|[a-hA-H][.)]?|\([a-hA-H]\)|[ivxIVX]{1,4}[.)]?)\s+/i, "").trim();
            const letter = String.fromCharCode(97 + idx);
            return `${letter}. ${stripped}`;
          });

          const firstPreIdx = preItems[0].lineIndex;
          const before = healLines.slice(0, firstPreIdx).filter(l => l.trim().length > 0);
          const after = healLines.slice(i);
          healLines = [...before, "Column A:", ...newColALines, ...after];
          i = before.length + 1 + newColALines.length;
          continue;
        }
      }
    }
  }

  // Step B: If Column A exists but its items are dummy/empty, recover descriptive items from above Column A
  let inAnsOrSolB = false;
  for (let i = 0; i < healLines.length; i++) {
    const l = healLines[i].trim();
    if (/^(?:Answer|Ans|उत्तर|Solution|Sol|हल|समाधान)\s*[:.-]/i.test(l)) {
      inAnsOrSolB = true;
    }
    if (inAnsOrSolB) continue;
    if (/^Column\s*A:/i.test(l)) {
      let colBIdx = -1;
      for (let j = i + 1; j < healLines.length; j++) {
        if (/^Column\s*B:/i.test(healLines[j].trim())) {
          colBIdx = j;
          break;
        }
        if (/^(?:Answer|Ans|उत्तर|Solution|Sol|हल)\s*[:.-]/i.test(healLines[j].trim())) break;
      }

      if (colBIdx !== -1) {
        const colAItems = healLines.slice(i + 1, colBIdx).map(s => s.trim()).filter(Boolean);
        
        const isColADummy = colAItems.length === 0 || colAItems.every(item => {
          const stripped = item.replace(/^\s*(?:[A-Da-d1-5][.)\s]|\([A-Da-d1-5]\)|(?:[क-ङअ-द]|ए|बी|सी|डी|ई)[.)\s]|\((?:[क-ङअ-द]|ए|बी|सी|डी|ई)\))\s*/i, "").trim();
          return stripped.length <= 1 || /^\d+$/.test(stripped);
        });

        if (isColADummy) {
          let startPre = i - 1;
          const preItems = [];
          while (startPre >= 0) {
            const prev = healLines[startPre].trim();
            if (!prev) {
              startPre--;
              continue;
            }
            if (/^\s*(?:#+\s*)?(?:(?:[Qq]\.?(?:uestion)?|प्रश्न|सवाल)\s*[:.-]?\s*\d+|\d{1,4}[.:\-)\]]\s+)/i.test(prev)) {
              break;
            }
            if (/^\s*(?:Answer|Ans|उत्तर|Solution|Sol|हल|Code|Codes|कूट|कोड)\s*[:.-]/i.test(prev)) {
              break;
            }
            const isItem = /^\s*(?:\(?\d{1,2}\)?|\d{1,2}[.)]?|[a-hA-H][.)]?|\([a-hA-H]\)|[ivxIVX]{1,4}[.)]?)\s+\S+/.test(prev);
            if (isItem) {
              preItems.unshift({ lineIndex: startPre, text: prev });
              startPre--;
            } else {
              break;
            }
          }

          if (preItems.length > 0) {
            const newColALines = preItems.map((item, idx) => {
              const stripped = item.text.replace(/^\s*(?:\(?\d{1,2}\)?|\d{1,2}[.)]?|[a-hA-H][.)]?|\([a-hA-H]\)|[ivxIVX]{1,4}[.)]?)\s+/i, "").trim();
              const letter = String.fromCharCode(97 + idx);
              return `${letter}. ${stripped}`;
            });

            const firstPreIdx = preItems[0].lineIndex;
            const before = healLines.slice(0, firstPreIdx).filter(l => l.trim().length > 0);
            const after = healLines.slice(colBIdx);
            healLines = [...before, "Column A:", ...newColALines, ...after];
            i = before.length + 1 + newColALines.length;
          }
        }
      }
    }
  }
  s = healLines.join("\n");

  // Split inline numbered items in Column B (e.g. "1 item 2 item 3 item 4 item")
  const colLines = s.split("\n");
  let inColB = false;
  for (let i = 0; i < colLines.length; i++) {
    const l = colLines[i].trim();
    if (/^Column\s*B:/i.test(l)) {
      inColB = true;
      continue;
    }
    if (inColB && (/^\s*(?:उत्तर\s*|सही\s*)?(?:कूट|कोड|Code|Codes)\s*[:.\-]?/i.test(l) || /^\s*[A-D]\.\s+\S/i.test(l) || /^\s*(?:Answer|Ans|उत्तर)\s*[:.-]/i.test(l))) {
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
  let colAItemIdx = 0;
  const colALetters = ["a. ", "b. ", "c. ", "d. "];
  for (let i = 0; i < colLines2.length; i++) {
    const l = colLines2[i].trim();
    if (/^Column\s*A:/i.test(l)) {
      inColA = true;
      colAItemIdx = 0;
      continue;
    }
    if (/^Column\s*B:/i.test(l) || /^\s*(?:Answer|Ans|उत्तर|Solution|Sol|हल)\s*[:.-]/i.test(l)) {
      inColA = false;
      continue;
    }
    if (inColA && l.length > 0) {
      // Strip any existing prefix: Devanagari (ए., बी., क., ख.), letters (A., B., a.), numbers (1., 2.)
      const stripped = l.replace(/^\s*(?:[A-Da-d1-4][.)\s]|\([A-Da-d1-4]\)|(?:[क-घअ-द]|ए|बी|सी|डी)[.)\s]|\((?:[क-घअ-द]|ए|बी|सी|डी)\))\s*/i, "");
      if (colAItemIdx < colALetters.length) {
        colLines2[i] = colALetters[colAItemIdx] + stripped;
        colAItemIdx++;
      }
    }
  }
  s = colLines2.join("\n");

  // Ensure Column B items use numbers: 1., 2., 3., 4.
  const colLines3 = s.split("\n");
  let inColB2 = false;
  let colBItemIdx = 0;
  const colBNumbers = ["1. ", "2. ", "3. ", "4. "];
  for (let i = 0; i < colLines3.length; i++) {
    const l = colLines3[i].trim();
    if (/^Column\s*B:/i.test(l)) {
      inColB2 = true;
      colBItemIdx = 0;
      continue;
    }
    if (inColB2 && (/^\s*(?:उत्तर\s*|सही\s*)?(?:कूट|कोड|Code|Codes)\s*[:.\-]?/i.test(l) || /^\s*[A-D]\.\s+\S/i.test(l) || /^\s*(?:Answer|Ans|उत्तर)\s*[:.-]/i.test(l))) {
      inColB2 = false;
      continue;
    }
    if (inColB2 && l.length > 0) {
      const stripped = l.replace(/^\s*(?:[A-Da-d1-4][.)\s]|\([A-Da-d1-4]\)|(?:[क-घअ-द]|ए|बी|सी|डी)[.)\s]|\((?:[क-घअ-द]|ए|बी|सी|डी)\))\s*/i, "");
      if (colBItemIdx < colBNumbers.length) {
        colLines3[i] = colBNumbers[colBItemIdx] + stripped;
        colBItemIdx++;
      }
    }
  }
  s = colLines3.join("\n");

  // 5. Split horizontal sub-statements (e.g. "...पहला कथन। 2. दूसरा कथन", never splitting decimal numbers)
  s = s.replace(/(?<=[।;]|(?<!\d)\.(?!\d)|\S[^\S\r\n]{2,})(?=(?:\(([2-9]|10)\)|([2-9]|10))[.,):\-–—]?\s+[^\s\d])/g, "\n");

  // 6. Split horizontal options on the same line (e.g. "...है। बी. ..." or "...है। B. ..." or "A. 68.2 B. 71.2 C. 77.8 D. 62.5")
  const splitPattern = /(?<!Answer:)(?:(?<=[।\?!;])\s*|(?<=[^A-Da-d0-9]\.)\s*|(?<=\S)\s+)(?=(?:[B-Db-d][.)](?!\s*[A-Za-z]\.)|\([b-dB-D]\)|[B-Db-d]\)|(?:[खबगसघद]|बी|सी|डी)[.)]|\((?:[खबगसघद]|बी|सी|डी)\)|(?:[खबगसघद]|बी|सी|डी)\))\s+)/g;
  s = s.replace(splitPattern, "\n");
  s = s.replace(/(?<=\S)\s+(?=(?:Answer|Ans)\s*[:.-])/gi, "\n");

  let lines = s.split("\n");
  let inColumn = false;
  let inSolution = false;
  let seenAnswer = false;
  let seenQuestionTitle = false;
  let seenOptions = false;
  let seenOptA = false;
  let seenOptB = false;
  let seenOptC = false;
  let seenOptD = false;

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
      seenOptA = true;
      lines[i] = line.replace(/^\s*__OPT_A__\s*/i, "A. ");
      continue;
    }
    if (/^\s*__OPT_B__\s*/i.test(line)) {
      seenOptB = true;
      lines[i] = line.replace(/^\s*__OPT_B__\s*/i, "B. ");
      continue;
    }
    if (/^\s*__OPT_C__\s*/i.test(line)) {
      seenOptC = true;
      lines[i] = line.replace(/^\s*__OPT_C__\s*/i, "C. ");
      continue;
    }
    if (/^\s*__OPT_D__\s*/i.test(line)) {
      seenOptD = true;
      lines[i] = line.replace(/^\s*__OPT_D__\s*/i, "D. ");
      continue;
    }

    // Option A: A., (A), (a), A), a., उ., (उ), उ), क., (क), क), अ., (अ), अ), ए., (ए), ए), एक।, एक.
    if (isOptA) {
      seenOptA = true;
      lines[i] = line.replace(/^\s*(?:[Aa][.)\s]|(?:\([Aa]\))|(?:[कअउ][.)\s]|ए\.\s+|एक[।.]|(?:\([कअउ]\))|[कअउ]\)))\s*/i, "A. ");
      continue;
    }

    // Option B: B., (B), (b), B), b., ख., (ख), ख), ब., (ब), ब), बी., (बी), बी), दो।, दो.
    if (isOptB) {
      seenOptB = true;
      lines[i] = line.replace(/^\s*(?:[Bb][.)\s]|(?:\([Bb]\))|(?:(?:[खब]|बी)[.)\s]|दो[।.]|(?:\((?:[खब]|बी)\))|(?:[खब]|बी)\)))\s*/i, "B. ");
      continue;
    }

    // Option C: C., (C), (c), C), c., ग., (ग), ग), स., (स), स), सी., (सी), सी), तीन।, तीन.
    if (isOptC) {
      seenOptC = true;
      lines[i] = line.replace(/^\s*(?:[Cc][.)\s]|(?:\([Cc]\))|(?:(?:[गस]|सी)[.)\s]|तीन[।.]|(?:\((?:[गस]|सी)\))|(?:[गस]|सी)\)))\s*/i, "C. ");
      continue;
    }

    // Option D: D., (D), (d), D), d., घ., (घ), घ), द., (द), द), डी., (डी), डी), चार।, चार.
    if (isOptD) {
      seenOptD = true;
      lines[i] = line.replace(/^\s*(?:[Dd][.)\s]|(?:\([Dd]\))|(?:(?:[घद]|डी)[.)\s]|चार[।.]|(?:\((?:[घद]|डी)\))|(?:[घद]|डी)\)))\s*/i, "D. ");
      continue;
    }

    // Option D fallback: If A, B, and C have appeared, but D was unlabelled (e.g. "1, 2, 3 और 4" or "4. 1, 2, 3 और 4")
    if (seenOptA && seenOptB && seenOptC && !seenOptD && !seenAnswer && !inSolution && !inColumn) {
      if (!/^\s*(?:Answer|Ans|उत्तर|Solution|Sol|हल|समाधान)\s*[:.-]/i.test(trimmed)) {
        const cleanContent = trimmed.replace(/^\s*(?:[Dd4][.)\s]|\([Dd4]\)|(?:[घद]|डी|चार)[.)\s]|\((?:[घद]|डी|चार)\))\s*/i, "");
        lines[i] = `D. ${cleanContent}`;
        seenOptD = true;
        continue;
      }
    }
  }

  return lines.join("\n");
}

export function normalizeAnswerInText(text: string): string {
  let s = text;
  // Replace translation marker if present
  s = s.replace(/^\s*(?:__ANS__|_ANS_|[_*]+ANS[_\s\-*]*)\s*/gim, "Answer: ");
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

import {
  Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel, LevelFormat,
  Table, TableRow, TableCell, WidthType, BorderStyle,
} from "docx";
import { normalizeOptionsInText, normalizeAnswerInText, healCorruptedMatchTitle } from "./normalize-options";

const FONT = "Noto Sans Devanagari";

function run(text: string, bold = false): TextRun {
  return new TextRun({ text, bold, font: FONT });
}

function runsFromMarkdown(text: string, defaultBold = false): TextRun[] {
  if (!text) return [new TextRun({ text: "", font: FONT })];
  const parts = text.split(/(\*\*.*?\*\*)/g);
  const runs: TextRun[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**") && part.length >= 4) {
      runs.push(new TextRun({ text: part.slice(2, -2), bold: true, font: FONT }));
    } else {
      runs.push(new TextRun({ text: part, bold: defaultBold, font: FONT }));
    }
  }
  return runs.length > 0 ? runs : [new TextRun({ text, bold: defaultBold, font: FONT })];
}

function parseFormatted(text: string, isMath: boolean): (Paragraph | Table)[] {
  const paragraphs: (Paragraph | Table)[] = [];
  // Normalize: strip blank lines from source, we control spacing via paragraph spacing.
  let cleanText = healCorruptedMatchTitle(text);

  // Reunite orphaned numbers that are on a line by themselves: "1\nText..." -> "1 Text..."
  cleanText = cleanText.replace(/(?:^|\n)\s*(\((?:[1-9]|10|i{1,3}|iv|v)\)|[1-9]|10)[.)]?\s*\n\s*(?=\S)/g, "\n$1 ");

  // Break inline numbered statements inside question body before options (protect decimal numbers!)
  cleanText = cleanText.replace(/([:：])\s*(?=(?:[1-9]|10|\((?:[1-9]|10|i{1,3}|iv|v)\))[.)]?\s+)/g, "$1\n");
  cleanText = cleanText.replace(/([।\?!;]|(?<!\d)\.(?!\d))\s*(?=(?:[2-9]|10|\((?:[2-9]|10|i{1,3}|iv|v)\))[.)]?\s+[^\s\d])/g, "$1\n");
  cleanText = cleanText.replace(/([।\?!;]|(?<!\d)\.(?!\d))\s*(?=(?:उपर्युक्त|उपरोक्त|इनमें|निम्न|Which of the|Of the above)[^\n]*[\?？:])/gi, "$1\n");

  cleanText = cleanText.replace(/(?<=\S)[^\S\r\n]+((?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*(?:A|B|I{1,3}|1|2)(?:[\s.:\-]+(?=\(?[a-zA-Z1-9]\)?[\s.)])|[\s.:\-]*$))/gim, "\n$1");
  cleanText = cleanText.replace(/^((?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*(?:A|B|I{1,3}|1|2)[\s.:\-]*)[^\S\r\n]+(?=\(?[a-zA-Z1-9]\)?[\s.)])/gim, "$1\n");
  cleanText = cleanText.replace(/(?<=\S)[^\S\r\n]+((?:उत्तर\s*|सही\s*)?(?:कूट|कोड|Code|Codes)\s*(?::|:-|[-–—]|(?=\s*(?:[A-Ha-h]\.|\([a-hA-H1-8]\)|[A-Ha-h]\)))))/gim, "\n$1");
  cleanText = cleanText.replace(/^((?:उत्तर\s*|सही\s*)?(?:कूट|कोड|Code|Codes)\s*[:.\-]*)[^\S\r\n]+(?=(?:[A-Ha-h]\.|\([a-hA-H1-8]\)|[A-Ha-h]\)))/gim, "$1\n");

  // Only add space after option label if at line start or after 2+ spaces, and NOT followed by period or digit (avoids breaking B.C., A.D., C.E., B.C.E., or A.1)
  cleanText = cleanText.replace(/(?:^|[^\S\r\n]{2,})([A-Ha-h]\.)([^\s.0-9])/gm, (m, g1, g2) => {
    return m.slice(0, m.length - g1.length - g2.length) + g1 + " " + g2;
  });
  cleanText = cleanText.replace(/(?<![A-Za-z0-9])(\([a-hA-H1-8]\)|[A-Ha-h]\))(?=\S)/g, "$1 ");
  cleanText = cleanText.replace(/(?<=\S)[^\S\r\n]{2,}(?=(?:[1-9]|10|i{1,3}|iv|v|vi)\)\s+)/gi, "\n");

  // Split options (A-H) horizontally, with negative lookahead to protect abbreviations (B.C., A.D., C.E., etc.)
  cleanText = cleanText.replace(/(?<!Answer:)(?<=\S)\s+(?=(?:[B-Db-d][.)](?!\s*[A-Za-z]\.)|\([b-dB-D]\)|[B-Db-d]\))\s+)/g, "\n");
  cleanText = cleanText.replace(/(?<=\S)\s+(?=(?:Answer|Ans)\s*[:.-])/gi, "\n");
  cleanText = cleanText.replace(/^((?:[A-Ha-h]\.)|(?:\([a-h1-8]\)))\s*\n\s*/gm, "$1 ");

  let cleanLines = cleanText.split("\n");

  // Fix pipe-separated match-the-column items (e.g. "a. Item | 1. Item")
  for (let i = 0; i < cleanLines.length; i++) {
    let line = cleanLines[i].trim();
    if (line.startsWith("|") && line.endsWith("|")) {
      line = line.substring(1, line.length - 1).trim();
    }
    
    if (line.includes("|") || line.includes("｜") || line.includes("│")) {
      const parts = line.split(/\s*[|｜│]\s*/);
      
      if (parts.length >= 2 && /^\s*([a-hA-H1-9]\.|I{1,3}\.|IV\.|V\.|VI\.|\([a-hA-H1-9]\)|\(I{1,3}\)|\(IV\)|\(V\)|\(VI\)|[a-hA-H1-9]\)|I{1,3}\)|IV\)|V\)|VI\))\s*/i.test(parts[0])) {
        let startIndex = i;
        while (startIndex > 0) {
          const prev = cleanLines[startIndex - 1].trim();
          if (/^\s*(?:\|\s*)?(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*(?:A|I|1)[:.\-]?/i.test(prev)) {
            startIndex--;
            break;
          }
          if (prev === "" || /^\s*\|?[\s\-:]+\|[\s\-:|]+\s*$/.test(prev)) {
            startIndex--;
            continue;
          }
          if (/^\s*(?:\|\s*)?(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*(?:B|II|2)[:.\-]?/i.test(prev)) {
            startIndex--;
            continue;
          }
          break;
        }

        let j = i;
        const newColA = [];
        const newColB = [];
        
        while (j < cleanLines.length) {
          let currLine = cleanLines[j].trim();
          
          if (/^\s*(?:उत्तर\s*|सही\s*)?(?:कूट|कोड|Code|Codes)\s*[:.\-]?/i.test(currLine) || /^\s*(?:Answer|Ans|उत्तर|Solution|Sol|हल|समाधान)[:.\-]/i.test(currLine)) {
            break;
          }

          if (currLine.startsWith("|") && currLine.endsWith("|")) {
            currLine = currLine.substring(1, currLine.length - 1).trim();
          }

          const p = currLine.split(/\s*[|｜│]\s*/);
          if (p.length >= 2) {
            newColA.push(p[0].trim());
            newColB.push(p.slice(1).join(" | ").trim());
          } else if (p.length === 1 && p[0] === "") {
            j++;
            continue;
          } else {
            break;
          }
          j++;
        }
        
        if (newColA.length > 0) {
          const replacement = ["Column A:", ...newColA, "Column B:", ...newColB];
          cleanLines.splice(startIndex, j - startIndex, ...replacement);
          i = startIndex + replacement.length - 1;
        }
      }
    }
  }

  // Fix dash/hyphen/colon separated match-the-column items on the same line (e.g. "a Item - 1 Item")
  const dashSplitRegex = /\s*(?:[-–—:;]|\t+)\s*(?=\(?(?:[1-9]|10|[a-hA-H]|i{1,3}|iv|v)\)?[.)]?\s+)/i;
  const leftItemRegex = /^\s*(?:[a-hA-H][.)]?|\([a-hA-H]\)|[ivxIVX]{1,4}[.)]?|\([ivxIVX]{1,4}\)|(?:[1-9]|10)[.)]?|\((?:[1-9]|10)\))\s+/i;
  const isQuestionPromptRegex = /(?:सुमेलित|सुमेल|मिलान|Match\b|Match the|निम्नलिखित|निम्न में|सूची\s*[-–—]?\s*[I1A].*सूची\s*[-–—]?\s*[II2B])/i;
  const isStatementQuestion = /(?:केवल|सभी\s*सही|कोई\s*नहीं|\bदोनों\b|कथन\s*\d|उपर्युक्त|उपरोक्त|Only\b|All\s+of\s+the\s+above|None\s+of\s+the\s+above|Both\s+\d)/i.test(cleanText);

  if (!isStatementQuestion) {
    let inSolutionOrAnswer = false;
    for (let i = 0; i < cleanLines.length; i++) {
      const line = cleanLines[i].trim();
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
            const prev = cleanLines[startIndex - 1].trim();
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
          while (j < cleanLines.length) {
            const curr = cleanLines[j].trim();
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
            const precedingText = cleanLines.slice(0, startIndex).join(" ");
            const m1 = precedingText.match(/((?:सूची|कॉलम|स्तंभ|List|Column)[\s\-]*(?:I|A|1)(?:\s*\([^\)\n]+\))?)/i);
            const m2 = precedingText.match(/((?:सूची|कॉलम|स्तंभ|List|Column)[\s\-]*(?:II|B|2)(?:\s*\([^\)\n]+\))?)/i);
            const headerA = m1 ? `${m1[1]}:` : "Column A:";
            const headerB = m2 ? `${m2[1]}:` : "Column B:";

            const replacement = [headerA, ...colAItems, headerB, ...colBItems];
            cleanLines.splice(startIndex, j - startIndex, ...replacement);
            i = startIndex + replacement.length - 1;
          }
        }
      }
    }
  }

  // Fix interleaved match-the-column items (a., 1., b., 2.) that missed Column headers
  let inSolutionOrAnswer2 = false;
  for (let i = 0; i < cleanLines.length - 3; i++) {
    if (/^\s*(?:Answer|Ans|उत्तर|Solution|Sol|हल|समाधान)[:.-]/i.test(cleanLines[i].trim())) {
      inSolutionOrAnswer2 = true;
    }
    if (inSolutionOrAnswer2) break;
    const m1 = cleanLines[i].match(/^\s*((?:[a-hA-H]\.)|(?:\([a-hA-H]\)))\s*(.*)$/);
    const m2 = cleanLines[i+1].match(/^\s*((?:[1-8]\.)|(?:\([1-8]\)))\s*(.*)$/);
    const m3 = cleanLines[i+2].match(/^\s*((?:[a-hA-H]\.)|(?:\([a-hA-H]\)))\s*(.*)$/);
    const m4 = cleanLines[i+3].match(/^\s*((?:[1-8]\.)|(?:\([1-8]\)))\s*(.*)$/);
    if (m1 && m2 && m3 && m4) {
      let colA = [];
      let colB = [];
      let j = i;
      while (j < cleanLines.length - 1) {
        const mA = cleanLines[j].match(/^\s*((?:[a-hA-H]\.)|(?:\([a-hA-H]\)))\s*(.*)$/);
        const mB = cleanLines[j+1].match(/^\s*((?:[1-8]\.)|(?:\([1-8]\)))\s*(.*)$/);
        if (mA && mB) {
          colA.push(cleanLines[j]);
          colB.push(cleanLines[j+1]);
          j += 2;
        } else {
          break;
        }
      }
      let startIndex = i;
      let countToRemove = j - i;
      while (startIndex > 0 && /^\s*(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*(?:A|B|I{1,3}|1|2)[:.\-]?/i.test(cleanLines[startIndex - 1])) {
        startIndex--;
        countToRemove++;
      }
      const replacement = ["Column A:", ...colA, "Column B:", ...colB];
      cleanLines.splice(startIndex, countToRemove, ...replacement);
      i = startIndex + replacement.length - 1;
    }
  }
  cleanText = cleanLines.join("\n");
  cleanText = normalizeAnswerInText(cleanText);
  cleanText = normalizeOptionsInText(cleanText);
  cleanText = cleanText.replace(/^\s*(\d{1,4}[.:\-)\]])\s*\n\s*(?=\S)/, "$1 ");
  const lines = cleanText
    .split("\n")
    .map((l) => l.replace(/\s+$/g, ""))
    .filter((l) => l.trim().length > 0);

  let seenQuestion = false;
  let inSolution = false;
  let seenAnswer = false;
  let seenSolution = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Question line: "374. ..." or "Question 1: ..."
    const q = line.match(/^\s*(?:(?:[Qq]\.?(?:uestion|ue|ues)?|Problem|Prob|MCQ|Item|Task|Case)(?:[ \t]*(?:No|Num|Number|#)\.?)?|प्रश्न(?:[ \t]*(?:संख्या|सं\.?|क्र\.?|क्रमांक))?|प्र\.?[ \t]*(?:संख्या|सं\.?|क्र\.?|क्रमांक)?|सवाल(?:[ \t]*(?:संख्या|सं\.?|क्र\.?|क्रमांक))?|क्र\.?[ \t]*(?:सं\.?|संख्या)?|[?¿\uFFFD]+)?[ \t]*[:.-]?[ \t]*(\d{1,4})[.:\-)\]]\s+(.*)$/i);
    if (q && !seenQuestion) {
      seenQuestion = true;
      inSolution = false;
      paragraphs.push(
        new Paragraph({
          spacing: { before: 240, after: 160, line: 320 },
          children: [run(`${q[1]}. `, true), ...runsFromMarkdown(q[2], true)],
        }),
      );
      continue;
    }

    if (!seenAnswer && !seenSolution && !inSolution && /^\s*(?:Column|कॉलम|स्तंभ|List|सूची|[?¿\uFFFD]+)[\s\-]*\(?(?:A|I{1,3}|1|ए)\)?/i.test(line)) {
      inSolution = false;
      let headerA = line.replace(/[:.\-]+$/, "").trim() || "Column A";
      let headerB = "Column B";
      const colA: string[] = [];
      const colB: string[] = [];
      let j = i + 1;
      while (
        j < lines.length &&
        !/^\s*(?:Column|कॉलम|स्तंभ|List|सूची|[?¿\uFFFD]+)[\s\-]*\(?(?:B|II|2|बी)\)?/i.test(lines[j]) &&
        !/^\s*(?:Answer|Ans|उत्तर)\s*[:.-]/i.test(lines[j]) &&
        !/^\s*(?:Solution|Sol|हल|समाधान)\s*[:.-]/i.test(lines[j]) &&
        !/^\s*(?:उत्तर\s*|सही\s*)?(?:कूट|कोड|Code|Codes)\s*[:.\-]?/i.test(lines[j])
      ) {
        // If this line has an embedded "Column B:" header, split it!
        const colBMatch = lines[j].match(/^(.*?)[^\S\r\n]+((?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*\(?(?:B|II|2|बी)\)?(?:\([^\)\n]+\))?\s*[:.-]?\s*)$/i);
        if (colBMatch) {
          if (colBMatch[1].trim()) colA.push(colBMatch[1].trim());
          lines[j] = colBMatch[2].trim();
          break;
        }
        // If this line is another "Column A:" / "सूची-I" header (e.g. from an earlier duplicate header), reset colA
        if (/^\s*(?:Column|कॉलम|स्तंभ|List|सूची|[?¿\uFFFD]+)[\s\-]*\(?(?:A|I{1,3}|1|ए)\)?[:.\-]?/i.test(lines[j])) {
          colA.length = 0;
          headerA = lines[j].replace(/[:.\-]+$/, "").trim() || "Column A";
          j++;
          continue;
        }
        colA.push(lines[j]);
        j++;
      }
      if (j < lines.length && /^\s*(?:Column|कॉलम|स्तंभ|List|सूची|[?¿\uFFFD]+)[\s\-]*\(?(?:B|II|2|बी)\)?/i.test(lines[j])) {
        headerB = lines[j].replace(/[:.\-]+$/, "").trim() || "Column B";
        j++;
        while (
          j < lines.length &&
          !/^\s*(?:Answer|Ans|उत्तर)\s*[:.-]/i.test(lines[j]) &&
          !/^\s*(?:Solution|Sol|हल|समाधान)\s*[:.-]/i.test(lines[j]) &&
          !/^\s*(?:उत्तर\s*|सही\s*)?(?:कूट|कोड|Code|Codes)\s*[:.\-]?/i.test(lines[j]) &&
          !/^\s*[A-D]\.\s+\S/.test(lines[j]) &&
          !/^\s*\([A-D]\)\s+(?:[a-dA-D1-4]\s*[-–—]|\d\s*,\s*\d|\S+)/.test(lines[j]) &&
          !/^\s*[_*]*OPT[_\s\-]*[A-D]/i.test(lines[j])
        ) {
          colB.push(lines[j]);
          j++;
        }
      }

      // If Column B is empty, check if colA contains numbered items belonging to Column B or embedded dash items
      if (colB.length === 0 && colA.length > 0) {
        const firstNumIdx = colA.findIndex((item, idx) => idx > 0 && /^\s*(?:\(?\d{1,2}\)?|\d{1,2}[.)])\s+/.test(item));
        if (firstNumIdx > 0) {
          const itemsForB = colA.splice(firstNumIdx);
          colB.push(...itemsForB);
          if (colA.length > 0) {
            colA[colA.length - 1] = colA[colA.length - 1].replace(/[^\S\r\n]*(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*\(?(?:B|II|2|बी)\)?(?:\([^\)\n]+\))?\s*[:.-]?\s*$/i, "").trim();
          }
        } else {
          const splitMatches = colA.filter(item => dashSplitRegex.test(item));
          const canSplit = splitMatches.length >= 3 && splitMatches.length >= colA.length - 1;
          if (canSplit) {
            const splitColA: string[] = [];
            for (const item of colA) {
              const parts = item.split(dashSplitRegex);
              if (parts.length >= 2) {
                splitColA.push(parts[0].trim());
                colB.push(parts.slice(1).join(" - ").trim());
              } else {
                splitColA.push(item);
              }
            }
            colA.length = 0;
            colA.push(...splitColA);
          }
        }
      }

      // If generic header, extract custom subtitles from preceding question prompt if available
      if (/^(?:Column\s*A|कॉलम\s*A|स्तंभ\s*1)$/i.test(headerA)) {
        const fullQ = lines.slice(0, i + 1).join(" ");
        const m1 = fullQ.match(/((?:सूची|कॉलम|स्तंभ|List|Column)[\s\-]*(?:I|A|1)(?:\s*\([^\)\n]+\))?)/i);
        const m2 = fullQ.match(/((?:सूची|कॉलम|स्तंभ|List|Column)[\s\-]*(?:II|B|2)(?:\s*\([^\)\n]+\))?)/i);
        if (m1 && m2) {
          headerA = m1[1];
          headerB = m2[1];
        }
      }

      // Ensure lowercase letters for Column A items and numbers for Column B items
      const colALetters = ["a. ", "b. ", "c. ", "d. ", "e. "];
      const colBNumbers = ["1. ", "2. ", "3. ", "4. ", "5. "];
      for (let k = 0; k < colA.length; k++) {
        const stripped = colA[k].replace(/^\s*(?:[A-Da-d1-5][.)\s]|\([A-Da-d1-5]\)|(?:[क-ङअ-द]|ए|बी|सी|डी|ई)[.)\s]|\((?:[क-ङअ-द]|ए|बी|सी|डी|ई)\))\s*/i, "").trim();
        if (k < colALetters.length) colA[k] = colALetters[k] + stripped;
      }
      for (let k = 0; k < colB.length; k++) {
        const stripped = colB[k].replace(/^\s*(?:[A-Da-d1-5][.)\s]|\([A-Da-d1-5]\)|(?:[क-ङअ-द]|ए|बी|सी|डी|ई)[.)\s]|\((?:[क-ङअ-द]|ए|बी|सी|डी|ई)\))\s*/i, "").trim();
        if (k < colBNumbers.length) colB[k] = colBNumbers[k] + stripped;
      }

      const maxRows = Math.max(colA.length, colB.length);
      const labelRegex = /^(\(?(?:[0-9]{1,2}|[a-zA-Z]|[ivxIVX]{1,4})\)?|[0-9]{1,2}[.)]?|[a-zA-Z][.)]|[ivxIVX]{1,4}[.)]?)\s+(.*)$/;
      const tableRows: TableRow[] = [
        new TableRow({
          children: [
            new TableCell({
              width: { size: 50, type: WidthType.PERCENTAGE },
              children: [new Paragraph({ spacing: { before: 120, after: 60, line: 300 }, children: [run(headerA, true)] })],
            }),
            new TableCell({
              width: { size: 50, type: WidthType.PERCENTAGE },
              children: [new Paragraph({ spacing: { before: 120, after: 60, line: 300 }, children: [run(headerB, true)] })],
            }),
          ],
        }),
        ...Array.from({ length: maxRows }).map((_, rIdx) => {
          const itemA = colA[rIdx] || "";
          const itemB = colB[rIdx] || "";
          const mA = itemA ? itemA.match(labelRegex) : null;
          const mB = itemB ? itemB.match(labelRegex) : null;
          return new TableRow({
            children: [
              new TableCell({
                width: { size: 50, type: WidthType.PERCENTAGE },
                children: [
                  new Paragraph({
                    spacing: { before: 30, after: 30, line: 300 },
                    indent: { left: 360 },
                    children: mA ? [run(`${mA[1]} `, true), ...runsFromMarkdown(mA[2])] : runsFromMarkdown(itemA),
                  }),
                ],
              }),
              new TableCell({
                width: { size: 50, type: WidthType.PERCENTAGE },
                children: [
                  new Paragraph({
                    spacing: { before: 30, after: 30, line: 300 },
                    indent: { left: 360 },
                    children: mB ? [run(`${mB[1]} `, true), ...runsFromMarkdown(mB[2])] : runsFromMarkdown(itemB),
                  }),
                ],
              }),
            ],
          });
        }),
      ];

      paragraphs.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: {
            top: { style: BorderStyle.NONE, size: 0, color: "auto" },
            bottom: { style: BorderStyle.NONE, size: 0, color: "auto" },
            left: { style: BorderStyle.NONE, size: 0, color: "auto" },
            right: { style: BorderStyle.NONE, size: 0, color: "auto" },
            insideHorizontal: { style: BorderStyle.NONE, size: 0, color: "auto" },
            insideVertical: { style: BorderStyle.NONE, size: 0, color: "auto" },
          },
          rows: tableRows,
        })
      );
      i = j - 1;
      continue;
    }

    // Code header: "कूट :", "Code:", "उत्तर कूट:", "सही कूट:"
    const isCodeHeader = /^\s*(?:उत्तर\s*|सही\s*)?(?:कूट|कोड|Code|Codes)(?:\s*\([a-zA-Z]+\))?\s*[:.\-]/i.test(line) || /^\s*(?:उत्तर\s*|सही\s*)?(?:कूट|कोड|Code|Codes)\s*[:.\-]?$/i.test(line);
    if (isCodeHeader) {
      inSolution = false;
      paragraphs.push(
        new Paragraph({
          spacing: { before: 120, after: 60, line: 300 },
          children: runsFromMarkdown(line, true),
        }),
      );
      continue;
    }

    // Assertion / Reason: "कथन (A):", "कारण (R):", "अभिकथन (A):", "कथन-I:", "कथन II:", "Statement I:"
    const assertionRegex = /^(\s*(?:अभिकथन|कथन|कारण|दलील|Assertion|Reason|Statement)\s*(?:[\-–—\s]*(?:I{1,3}|IV|V|[A-Za-z0-9]|ए|आर)|\((?:[A-Za-z0-9]|ए|आर)+\))\s*[:.\-]?)\s*(.*)$/i;
    const isAssertionReason = (!seenAnswer && !seenSolution) && assertionRegex.test(line);
    if (isAssertionReason) {
      inSolution = false;
      const m = line.match(assertionRegex);
      paragraphs.push(
        new Paragraph({
          spacing: { before: 40, after: 40, line: 300 },
          indent: { left: 360 },
          children: m ? [run(`${m[1]} `, true), ...runsFromMarkdown(m[2])] : runsFromMarkdown(line, true),
        }),
      );
      continue;
    }

    // Check if line starts with an abbreviation like B.C., B. C., A.D., C.E., B.C.E. (not an option)
    const isAbbrev = /^\s*[A-Za-z]\.(?:\s*[A-Za-z]\.)+/i.test(line);

    // Check if line is an option A., B., C., D. or (a), (b), (c), (d) or A) Option
    const letterOptMatch = (!seenAnswer && !seenSolution && !isAbbrev) ? line.match(/^\s*((?:[A-Ha-h]\.)|(?:\([a-hA-H]\))|(?:[A-Ha-h]\)))\s+(.*)$/) : null;

    // Check if line is a sub-statement (1), (2), (3), (4) or (i), (ii), etc. or "1 ", "2 " before options
    const statementMatch = (!seenAnswer && !seenSolution && !letterOptMatch) ? line.match(/^\s*(\((?:[1-9]|10|i{1,3}|iv|v|vi)\)|(?:[1-9]|10)[.,):\-–—]?|(?:i{1,3}|iv|v|vi)[.,):\-–—]?)\s+(.*)$/i) : null;

    if (letterOptMatch) {
      inSolution = false;
      const options: { label: string; text: string }[] = [];
      let j = i;
      while (j < lines.length) {
        const currLine = lines[j];
        const m = currLine.match(/^\s*((?:[A-Ha-h]\.)|(?:\([a-hA-H]\))|(?:[A-Ha-h]\)))\s*(.*)$/);
        if (m) {
          const label = m[1];
          let text = m[2] ? m[2].trim() : "";
          j++;
          while (
            j < lines.length &&
            !/^\s*(?:(?:[A-Ha-h]\.)|(?:\([a-hA-H1-8]\))|(?:[A-Ha-h]\))|(?:[1-8]\.))\s+/i.test(lines[j]) &&
            !/^\s*(?:उत्तर\s*|सही\s*)?(?:कूट|कोड|Code|Codes)\s*[:.\-]?/i.test(lines[j]) &&
            !/^\s*(?:Answer|Ans|उत्तर)\s*[:.-]/i.test(lines[j]) &&
            !/^\s*(?:Solution|Sol|हल|समाधान)\s*[:.-]/i.test(lines[j])
          ) {
            text += (text ? " " : "") + lines[j].trim();
            j++;
          }
          options.push({ label, text });
        } else {
          break;
        }
      }
      for (const o of options) {
        paragraphs.push(
          new Paragraph({
            spacing: { before: 120, after: 120, line: 300 },
            indent: { left: 720, hanging: 360 },
            children: [run(`${o.label}   `, true), ...runsFromMarkdown(o.text)],
          }),
        );
      }
      i = j - 1;
      continue;
    }

    if (statementMatch) {
      inSolution = false;
      const rawNum = statementMatch[1].replace(/[\(\)\.,:;\-–—]/g, "").trim();
      paragraphs.push(
        new Paragraph({
          spacing: { before: 40, after: 40, line: 300 },
          indent: { left: 360 },
          children: [run(`${rawNum} `, true), ...runsFromMarkdown(statementMatch[2])],
        }),
      );
      continue;
    }

    // Answer: Answer:, Ans:, उत्तर:
    if (/^\s*(?:Answer|Ans|उत्तर)\s*[:.-]/i.test(line)) {
      inSolution = false;
      seenAnswer = true;
      const ansVal = line.replace(/^\s*(?:Answer|Ans|उत्तर)\s*[:.-]\s*/i, "");
      paragraphs.push(
        new Paragraph({
          spacing: { before: 200, after: 80, line: 320 },
          children: [run("Answer: ", true), ...runsFromMarkdown(ansVal)],
        }),
      );
      continue;
    }

    // Solution: Solution:, Sol:, हल:, समाधान:
    if (/^\s*(?:Solution|Sol|हल|समाधान)\s*[:.-]/i.test(line)) {
      inSolution = true;
      seenSolution = true;
      const rest = line.replace(/^\s*(?:Solution|Sol|हल|समाधान)\s*[:.-]\s*/i, "");
      paragraphs.push(
        new Paragraph({
          spacing: { before: 80, after: 120, line: 320 },
          children: rest
            ? [run("Solution: ", true), ...runsFromMarkdown(rest)]
            : [run("Solution:", true)],
        }),
      );
      continue;
    }

    // Solution step "1. …" or "1 …" inside Solution block
    const step = inSolution ? line.match(/^\s*(\((?:\d{1,2})\)|\d{1,2})\s*[.,):\-–—]?\s+(.*)$/) : null;
    if (step) {
      const stepNum = step[1].replace(/[\(\)]/g, "");
      if (isMath) {
        paragraphs.push(
          new Paragraph({
            spacing: { before: 40, after: 40, line: 300 },
            indent: { left: 540, hanging: 220 },
            children: [
              new TextRun({ text: "-  ", bold: true, font: FONT, color: "C00000" }),
              ...runsFromMarkdown(step[2]),
            ],
          }),
        );
        continue;
      }
      paragraphs.push(
        new Paragraph({
          spacing: { before: 40, after: 40, line: 300 },
          indent: { left: 540, hanging: 220 },
          children: [run(`${stepNum} `, true), ...runsFromMarkdown(step[2])],
        }),
      );
      continue;
    }

    // Dash-bulleted solution step "- ..." (math). Red dash marker.
    const dashStep = inSolution ? line.match(/^\s*-\s+(.*)$/) : null;
    if (dashStep) {
      paragraphs.push(
        new Paragraph({
          spacing: { before: 40, after: 40, line: 300 },
          indent: { left: 540, hanging: 220 },
          children: [
            new TextRun({ text: "-  ", bold: true, font: FONT, color: "C00000" }),
            ...runsFromMarkdown(dashStep[1]),
          ],
        }),
      );
      continue;
    }

    // Bullet line "* ..."
    const bullet = line.match(/^\s*\*\s+(.*)$/);
    if (bullet) {
      inSolution = false;
      paragraphs.push(
        new Paragraph({
          numbering: { reference: "bullets", level: 0 },
          spacing: { before: 40, after: 40, line: 300 },
          children: runsFromMarkdown(bullet[1]),
        }),
      );
      continue;
    }

    paragraphs.push(
      new Paragraph({
        spacing: { line: 320 },
        children: runsFromMarkdown(line),
      }),
    );
  }
  return paragraphs;
}

export async function downloadBatchAsDocx(
  title: string,
  questions: { formatted_output: string | null }[],
  subjectType?: "gk_english" | "math",
) {
  const isMath = subjectType === "math";
  const safeTitle = (title && title.trim()) || "Batch";
  const valid = (questions ?? []).filter((q) => q && typeof q.formatted_output === "string" && q.formatted_output.trim().length > 0);
  if (valid.length === 0) throw new Error("Nothing to export yet — no completed questions.");

  const body: (Paragraph | Table)[] = [];

  for (let i = 0; i < valid.length; i++) {
    const q = valid[i];
    try {
      body.push(...parseFormatted(q.formatted_output as string, isMath));
    } catch (e) {
      console.error("docx parseFormatted failed", e);
      body.push(new Paragraph({ children: [run("[Skipped: could not render this question]")] }));
    }
    if (i < valid.length - 1) {
      body.push(new Paragraph({ spacing: { before: 120, after: 120 }, children: [run("")] }));
    }
  }

  const doc = new Document({
    styles: {
      default: { document: { run: { font: "Noto Sans Devanagari", size: 22 } } },
    },
    numbering: {
      config: [{
        reference: "bullets",
        levels: [{
          level: 0, format: LevelFormat.BULLET, text: "*", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      }],
    },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 }, // Standard A4 (210mm x 297mm)
          margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 },
        },
      },
      children: body,
    }],
  });

  let blob: Blob;
  try {
    blob = await Packer.toBlob(doc);
  } catch (e) {
    throw new Error(`Could not build .docx: ${e instanceof Error ? e.message : String(e)}`);
  }
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeTitle.replace(/[^\w\-. ]/g, "_")}.docx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
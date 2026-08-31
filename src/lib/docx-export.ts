import {
  Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel, LevelFormat,
  Table, TableRow, TableCell, WidthType, BorderStyle,
} from "docx";

const FONT = "Noto Sans Devanagari";

function run(text: string, bold = false): TextRun {
  return new TextRun({ text, bold, font: FONT });
}

function parseFormatted(text: string, isMath: boolean): (Paragraph | Table)[] {
  const paragraphs: (Paragraph | Table)[] = [];
  // Normalize: strip blank lines from source, we control spacing via paragraph spacing.
  let cleanText = text.replace(/(?<=\S)[^\S\r\n]+((?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*(?:A|B|I{1,3}|1|2)(?:[\s.:\-]+(?=\(?[a-zA-Z1-9]\)?[\s.)])|[\s.:\-]*$))/gim, "\n$1");
  cleanText = cleanText.replace(/^((?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*(?:A|B|I{1,3}|1|2)[\s.:\-]*)[^\S\r\n]+(?=\(?[a-zA-Z1-9]\)?[\s.)])/gim, "$1\n");
  cleanText = cleanText.replace(/(?<=\S)[^\S\r\n]+((?:उत्तर\s*)?(?:कूट|कोड|Code|Codes)\s*(?::|:-|[-–—]|(?=\s*(?:[A-Ha-h]\.|\([a-hA-H1-8]\)|[A-Ha-h]\)))))/gim, "\n$1");
  cleanText = cleanText.replace(/^((?:उत्तर\s*)?(?:कूट|कोड|Code|Codes)\s*[:.\-]*)[^\S\r\n]+(?=(?:[A-Ha-h]\.|\([a-hA-H1-8]\)|[A-Ha-h]\)))/gim, "$1\n");
  cleanText = cleanText.replace(/(?<![A-Za-z0-9])([A-Ha-h]\.)(?=\S)/g, "$1 ");
  cleanText = cleanText.replace(/(?<![A-Za-z0-9])(\([a-hA-H1-8]\)|[A-Ha-h]\))(?=\S)/g, "$1 ");
  cleanText = cleanText.replace(/(?<=\S)[^\S\r\n]{2,}(?=\((?:[1-9]|10|i{1,3}|iv|v|vi)\)\s+)/gi, "\n");
  cleanText = cleanText.replace(/(?<!Answer:)(?<=\S)[^\S\r\n]{2,}(?=(?:[A-Ha-h][.)]|\([a-hA-H1-8]\))(?:\s+|$))/g, "\n");
  cleanText = cleanText.replace(/^((?:[A-Ha-h]\.)|(?:\([a-h1-8]\)))\s*\n\s*/gm, "$1 ");

  // Fix interleaved match-the-column items (a., 1., b., 2.) that missed Column headers
  let cleanLines = cleanText.split("\n");
  for (let i = 0; i < cleanLines.length - 3; i++) {
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
    // Question line: "374. ..."
    const q = line.match(/^\s*(\d{1,4})\.\s+(.*)$/);
    if (q && !seenQuestion) {
      seenQuestion = true;
      inSolution = false;
      paragraphs.push(
        new Paragraph({
          spacing: { before: 240, after: 160, line: 320 },
          children: [run(`${q[1]}. ${q[2]}`, true)],
        }),
      );
      continue;
    }

    if (/^\s*(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*(?:A|I|1)[:.\-]?/i.test(line)) {
      inSolution = false;
      const colA: string[] = [];
      const colB: string[] = [];
      let j = i + 1;
      while (j < lines.length && !/^\s*(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*(?:B|II|2)[:.\-]?/i.test(lines[j])) {
        colA.push(lines[j]);
        j++;
      }
      if (j < lines.length && /^\s*(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*(?:B|II|2)[:.\-]?/i.test(lines[j])) {
        j++;
        while (j < lines.length && colB.length < colA.length && !/^\s*Answer:/i.test(lines[j]) && !/^\s*Solution:/i.test(lines[j])) {
          colB.push(lines[j]);
          j++;
        }
      }
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
          rows: [
            new TableRow({
              children: [
                new TableCell({
                  width: { size: 50, type: WidthType.PERCENTAGE },
                  children: [
                    new Paragraph({ spacing: { before: 120, after: 60, line: 300 }, children: [run("Column A", true)] }),
                    ...colA.map(c => {
                       const m = c.match(/^(\(?[1-9a-hA-H]\)?|[1-9a-hA-H][.)]?)\s+(.*)$/);
                       return new Paragraph({
                         spacing: { before: 30, after: 30, line: 300 },
                         indent: { left: 360 },
                         children: m ? [run(`${m[1]} `, true), run(m[2])] : [run(c)],
                       });
                    }),
                  ],
                }),
                new TableCell({
                  width: { size: 50, type: WidthType.PERCENTAGE },
                  children: [
                    new Paragraph({ spacing: { before: 120, after: 60, line: 300 }, children: [run("Column B", true)] }),
                    ...colB.map(c => {
                       const m = c.match(/^(\(?[1-9a-hA-H]\)?|[1-9a-hA-H][.)]?)\s+(.*)$/);
                       return new Paragraph({
                         spacing: { before: 30, after: 30, line: 300 },
                         indent: { left: 360 },
                         children: m ? [run(`${m[1]} `, true), run(m[2])] : [run(c)],
                       });
                    }),
                  ],
                }),
              ],
            }),
          ],
        })
      );
      i = j - 1;
      continue;
    }

    // Code header: "कूट :", "Code:", "उत्तर कूट:"
    if (/^\s*(?:उत्तर\s*)?(?:कूट|कोड|Code|Codes)\s*[:.\-]?$/i.test(line)) {
      inSolution = false;
      paragraphs.push(
        new Paragraph({
          spacing: { before: 120, after: 60, line: 300 },
          children: [run(line, true)],
        }),
      );
      continue;
    }

    // Check if line is a sub-statement (1), (2), (3), (4) or (i), (ii), etc.
    const statementMatch = (!seenAnswer && !seenSolution) ? line.match(/^\s*(\((?:[1-9]|10|i{1,3}|iv|v|vi)\))\s*(.*)$/i) : null;

    // Check if line is an option A, B, C, D or (a), (b), (c), (d) or A) Option
    const letterOptMatch = (!seenAnswer && !seenSolution) ? line.match(/^\s*((?:[A-Ha-h]\.?)|(?:\([a-hA-H]\))|(?:[A-Ha-h]\)))\s*(.*)$/) : null;

    // Check if line is a numeric option 1., 2., 3., 4. (when no letters exist and not a statement)
    const numOptMatch = (!seenAnswer && !seenSolution && !statementMatch) ? line.match(/^\s*((?:[1-8]\.)|(?:\([1-8]\)))\s*(.*)$/) : null;

    if (letterOptMatch || numOptMatch) {
      inSolution = false;
      const isLetter = !!letterOptMatch;
      const options: { label: string; text: string }[] = [];
      let j = i;
      while (j < lines.length) {
        const currLine = lines[j];
        const m = isLetter
          ? currLine.match(/^\s*((?:[A-Ha-h]\.)|(?:\([a-hA-H]\))|(?:[A-Ha-h]\)))\s*(.*)$/)
          : currLine.match(/^\s*((?:[1-8]\.)|(?:\([1-8]\)))\s*(.*)$/);
        if (m) {
          const label = m[1];
          let text = m[2] ? m[2].trim() : "";
          j++;
          while (
            j < lines.length &&
            !/^\s*(?:(?:[A-Ha-h]\.)|(?:\([a-hA-H1-8]\))|(?:[A-Ha-h]\))|(?:[1-8]\.))\s+/i.test(lines[j]) &&
            !/^\s*(?:उत्तर\s*)?(?:कूट|कोड|Code|Codes)\s*[:.\-]?$/i.test(lines[j]) &&
            !/^\s*Answer:/i.test(lines[j]) &&
            !/^\s*Solution:/i.test(lines[j])
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
            children: [run(`${o.label}   `, true), run(o.text)],
          }),
        );
      }
      i = j - 1;
      continue;
    }

    if (statementMatch) {
      inSolution = false;
      paragraphs.push(
        new Paragraph({
          spacing: { before: 40, after: 40, line: 300 },
          indent: { left: 360 },
          children: [run(`${statementMatch[1]} `, true), run(statementMatch[2])],
        }),
      );
      continue;
    }

    // Answer
    if (/^\s*Answer:/i.test(line)) {
      inSolution = false;
      seenAnswer = true;
      paragraphs.push(
        new Paragraph({
          spacing: { before: 200, after: 80, line: 320 },
          children: [run("Answer: ", true), run(line.replace(/^\s*Answer:\s*/i, ""))],
        }),
      );
      continue;
    }

    // Solution
    if (/^\s*Solution:/i.test(line)) {
      inSolution = true;
      seenSolution = true;
      const rest = line.replace(/^\s*Solution:\s*/i, "");
      paragraphs.push(
        new Paragraph({
          spacing: { before: 80, after: 120, line: 320 },
          children: rest
            ? [run("Solution: ", true), run(rest)]
            : [run("Solution:", true)],
        }),
      );
      continue;
    }

    // Solution step "1. …" or "1 …" inside Solution block
    const step = inSolution ? line.match(/^\s*(\d{1,2})[.)]?\s+(.*)$/) : null;
    if (step) {
      if (isMath) {
        paragraphs.push(
          new Paragraph({
            spacing: { before: 40, after: 40, line: 300 },
            indent: { left: 540, hanging: 220 },
            children: [
              new TextRun({ text: "-  ", bold: true, font: FONT, color: "C00000" }),
              run(step[2]),
            ],
          }),
        );
        continue;
      }
      paragraphs.push(
        new Paragraph({
          spacing: { before: 40, after: 40, line: 300 },
          indent: { left: 540, hanging: 220 },
          children: [run(`${step[1]} `, true), run(step[2])],
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
            run(dashStep[1]),
          ],
        }),
      );
      continue;
    }
    if (dashStep) {
      paragraphs.push(
        new Paragraph({
          spacing: { before: 40, after: 40, line: 300 },
          indent: { left: 540, hanging: 220 },
          children: [
            new TextRun({ text: "-  ", bold: true, font: FONT, color: "C00000" }),
            run(dashStep[1]),
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
          children: [run(bullet[1])],
        }),
      );
      continue;
    }

    paragraphs.push(
      new Paragraph({
        spacing: { line: 320 },
        children: [run(line)],
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
          size: { width: 12240, height: 15840 },
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
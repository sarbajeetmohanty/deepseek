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
  cleanText = cleanText.replace(/(?<!Answer:)(?<=\S)[^\S\r\n]+(?=(?:\(?[a-dA-D1-4]\)?|[a-dA-D1-4][.)])[^\S\r\n])/g, "\n");
  const lines = cleanText
    .split("\n")
    .map((l) => l.replace(/\s+$/g, ""))
    .filter((l) => l.trim().length > 0);

  let seenQuestion = false;
  let inSolution = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Question line: "374. ..."
    const q = line.match(/^(\d{1,4})\.\s+(.*)$/);
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

    if (/^(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*(?:A|I|1)[:.\-]?/i.test(line)) {
      inSolution = false;
      const colA: string[] = [];
      const colB: string[] = [];
      let j = i + 1;
      while (j < lines.length && !/^(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*(?:B|II|2)[:.\-]?/i.test(lines[j])) {
        colA.push(lines[j]);
        j++;
      }
      if (j < lines.length && /^(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*(?:B|II|2)[:.\-]?/i.test(lines[j])) {
        j++;
        while (j < lines.length && colB.length < colA.length && !/^Answer:/i.test(lines[j]) && !/^Solution:/i.test(lines[j])) {
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

    // Option line: "A. ..."
    const optMatch = line.match(/^(\(?[a-dA-D1-4]\)?|[a-dA-D1-4][.)])(?:\s+(.*))?$/);
    if (optMatch) {
      inSolution = false;
      const options: { label: string; text: string }[] = [];
      let j = i;
      while (j < lines.length) {
        const m = lines[j].match(/^(\(?[a-dA-D1-4]\)?|[a-dA-D1-4][.)])(?:\s+(.*))?$/);
        if (m) {
          const label = m[1];
          let text = m[2] ? m[2].trim() : "";
          j++;
          while (
            j < lines.length &&
            !/^(\(?[a-dA-D1-4]\)?|[a-dA-D1-4][.)])(?:\s+|$)/.test(lines[j]) &&
            !/^Answer:/i.test(lines[j]) &&
            !/^Solution:/i.test(lines[j])
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

    // Answer
    if (/^Answer:/i.test(line)) {
      inSolution = false;
      paragraphs.push(
        new Paragraph({
          spacing: { before: 200, after: 80, line: 320 },
          children: [run("Answer: ", true), run(line.replace(/^Answer:\s*/i, ""))],
        }),
      );
      continue;
    }

    // Solution
    if (/^Solution:/i.test(line)) {
      inSolution = true;
      const rest = line.replace(/^Solution:\s*/i, "");
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

    // Solution step "1. …" inside Solution block
    const step = inSolution ? line.match(/^(\d{1,2})\.\s+(.*)$/) : null;
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
          children: [run(`${step[1]}. `, true), run(step[2])],
        }),
      );
      continue;
    }

    // Dash-bulleted solution step "- ..." (math). Red dash marker.
    const dashStep = inSolution ? line.match(/^-\s+(.*)$/) : null;
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
    const bullet = line.match(/^\*\s+(.*)$/);
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
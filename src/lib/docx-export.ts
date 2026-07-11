import {
  Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel, LevelFormat,
} from "docx";

const FONT = "Noto Sans Devanagari";

function run(text: string, bold = false): TextRun {
  return new TextRun({ text, bold, font: FONT });
}

function parseFormatted(text: string, isMath: boolean): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  // Normalize: strip blank lines from source, we control spacing via paragraph spacing.
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\s+$/g, ""))
    .filter((l) => l.trim().length > 0);

  let seenQuestion = false;
  let inSolution = false;
  for (const line of lines) {
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

    // Column heading: "Column A:" / "Column B:"
    if (/^Column\s+[AB]:/i.test(line)) {
      inSolution = false;
      paragraphs.push(
        new Paragraph({
          spacing: { before: 120, after: 60, line: 300 },
          children: [run(line, true)],
        }),
      );
      continue;
    }

    // Match-column item inside a Column block: "1. ..." or "a. ..."
    // Only treat single-digit "1." … "9." (or "a." … "h.") as match items when
    // we're NOT inside the Solution block (Solution has numbered steps).
    const matchItem = line.match(/^([1-9]|[a-h])\.\s+(.*)$/);
    if (matchItem && seenQuestion && !inSolution) {
      paragraphs.push(
        new Paragraph({
          spacing: { before: 30, after: 30, line: 300 },
          indent: { left: 540 },
          children: [run(`${matchItem[1]}. `, true), run(matchItem[2])],
        }),
      );
      continue;
    }

    // Option line: "A. ..."
    const opt = line.match(/^([A-D])\.\s+(.*)$/);
    if (opt) {
      inSolution = false;
      paragraphs.push(
        new Paragraph({
          spacing: { before: 120, after: 120, line: 300 },
          indent: { left: 360 },
          children: [run(`${opt[1]}. ${opt[2]}`, true)],
        }),
      );
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

  const body: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
      children: [new TextRun({ text: safeTitle, bold: true, font: FONT, size: 32 })],
    }),
  ];

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
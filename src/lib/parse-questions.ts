// Parses a raw pasted MCQ dump into individual question blocks.
// A question starts with a line beginning with `<number>.` and ends
// before the next such line.
export function parseQuestions(raw: string): { idx: number; text: string }[] {
  if (typeof raw !== "string") return [];
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const blocks: { idx: number; text: string; startLine: number }[] = [];
  let current: { idx: number; text: string; startLine: number } | null = null;

  // m[1]: leading spaces, m[2]: optional Q prefix, m[3]: digits
  const startRe = /^([ \t]*)(?:#+[ \t]*)?([Qq][ \t]*)?(\d{1,4})\.\s+/;
  let docPrefixType: "Q" | "NUM" | null = null;
  let baseIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Skip chat-log timestamps like "[11-07-2026 14:05] TEX QR:"
    if (/^\[\d{2}-\d{2}-\d{4} \d{2}:\d{2}\] /.test(line)) continue;

    const m = line.match(startRe);
    if (m) {
      const leadingSpaces = m[1].length;
      const hasQ = !!m[2];
      const idx = Number(m[3]);

      if (!Number.isFinite(idx)) continue;

      if (!current) {
        docPrefixType = hasQ ? "Q" : "NUM";
        baseIndent = leadingSpaces;
      } else {
        let isSubPoint = false;
        if (!hasQ && leadingSpaces > baseIndent) {
          // Sub-points (e.g. statement 1, 2) never have Q prefixes and are typically indented 
          // more than the actual question number.
          isSubPoint = true;
        }

        if (isSubPoint) {
          current.text += "\n" + line;
          continue;
        }
      }

      if (current) blocks.push(current);
      current = { idx, text: line, startLine: i };
    } else if (current) {
      current.text += "\n" + line;
    }
  }
  if (current) blocks.push(current);

  // Trim + drop blocks with empty body
  const cleaned = blocks
    .map((b) => ({ idx: b.idx, text: b.text.trim() }))
    .filter((b) => b.text.length > 0);

  // If the source has duplicate or non-monotonic numbering (e.g. every
  // question pasted as "1."), renumber sequentially starting from 1 so the
  // output stays coherent. Otherwise keep the source numbers (e.g. 374, 375…).
  const idxs = cleaned.map((b) => b.idx);
  const hasDupes = new Set(idxs).size !== idxs.length;
  const monotonic = idxs.every((v, i) => i === 0 || v > idxs[i - 1]);
  if (hasDupes || !monotonic) {
    return cleaned.map((b, i) => ({ idx: i + 1, text: b.text }));
  }
  return cleaned;
}
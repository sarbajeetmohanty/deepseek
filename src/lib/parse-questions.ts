// Parses a raw pasted MCQ dump into individual question blocks.
// A question starts with a line beginning with `<number>.` and ends
// before the next such line.
export function parseQuestions(raw: string): { idx: number; text: string }[] {
  if (typeof raw !== "string") return [];
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const blocks: { idx: number; text: string; startLine: number }[] = [];
  let current: { idx: number; text: string; startLine: number } | null = null;

  // m[1]: leading spaces
  // m[2]: optional Q prefix
  // m[3]: digits
  // m[4]: optional punctuation
  const startRe = /^([ \t]*)(?:#+[ \t]*)?((?:[Qq](?:uestion)?|प्रश्न|प्र\.?)[ \t]*[.-]?[ \t]*|)(\d{1,4})(?:\s*([.:\-)\]])\s*|\s+)/i;
  let docPrefixType: "Q" | "NUM" | null = null;
  let baseIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Skip chat-log timestamps like "[11-07-2026 14:05] TEX QR:"
    if (/^\[\d{2}-\d{2}-\d{4} \d{2}:\d{2}\] /.test(line)) continue;

    const m = line.match(startRe);
    
    let isStart = false;
    let leadingSpaces = 0;
    let hasQ = false;
    let idx = 0;
    
    if (m) {
      leadingSpaces = m[1].length;
      hasQ = m[2].trim().length > 0;
      idx = Number(m[3]);
      const hasPunct = !!m[4];
      
      // A line is only a question start if it has a explicit "Q" prefix, or if it is followed by list punctuation.
      // E.g., "1. " is a question. "Q1 " is a question. "1998 " is NOT a question.
      if (Number.isFinite(idx) && (hasQ || hasPunct)) {
        isStart = true;
      }
    }

    if (isStart) {
      if (!current) {
        docPrefixType = hasQ ? "Q" : "NUM";
        baseIndent = leadingSpaces;
      } else {
        let isSubPoint = false;
        if (!hasQ && docPrefixType === "Q") {
          // If the document uses Q prefixes (e.g. Q1., Q2.), then any numbered line without a Q prefix 
          // is definitely a sub-point, even if it's not indented.
          isSubPoint = true;
        } else if (!hasQ && leadingSpaces > baseIndent) {
          // Fallback: if it's indented more than the base question, it's a sub-point.
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
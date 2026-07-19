
exports.parseQuestions = function parseQuestions(raw) {
  if (typeof raw !== "string") return [];
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const blocks = [];
  let current = null;

  const startRe = /^([ \t]*)(?:#+[ \t]*)?((?:[Qq](?:uestion)?|??????|???\.?)[ \t]*[.-]?[ \t]*)?(\d{1,4})(?:[.:\-)\]]\s*)/i;
  let docPrefixType = null;
  let baseIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
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

  const cleaned = blocks
    .map((b) => ({ idx: b.idx, text: b.text.trim() }))
    .filter((b) => b.text.length > 0);

  const idxs = cleaned.map((b) => b.idx);
  const hasDupes = new Set(idxs).size !== idxs.length;
  const monotonic = idxs.every((v, i) => i === 0 || v > idxs[i - 1]);
  if (hasDupes || !monotonic) {
    return cleaned.map((b, i) => ({ idx: i + 1, text: b.text }));
  }
  return cleaned;
}


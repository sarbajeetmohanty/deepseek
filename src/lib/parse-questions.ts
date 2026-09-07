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
  const startRe = /^([ \t]*)(?:#+[ \t]*)?((?:(?:[Qq]\.?(?:uestion|ue|ues)?|Problem|Prob|MCQ)(?:[ \t]*(?:No|Num|Number|#)\.?)?|प्रश्न(?:[ \t]*(?:संख्या|सं\.?|क्र\.?|क्रमांक))?|प्र\.?[ \t]*(?:सं\.?|क्र\.?)?)[ \t]*[:.-]?[ \t]*|)(\d{1,4})(?:\s*([.:\-)\]])\s*|\s+)/i;
  let docPrefixType: "Q" | "NUM" | null = null;
  let baseIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    // Strip chat-log timestamps like "[11-07-2026 14:05] TEX QR:" without dropping the rest of the line
    let line = (lines[i] ?? "").replace(/^\[\d{2}[-./]\d{2}[-./]\d{4}\s+\d{2}:\d{2}(?::\d{2})?\]\s*(?:[A-Za-z0-9_ \-]+:\s*)?/, "");
    if (!line.trim()) continue;

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
      
      // A line is only a question start if it has an explicit "Q" prefix, or if it is followed by list punctuation.
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
        
        // Check if current question already has options or an answer
        const hasColA = /(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*(?:A|I|1)/i.test(current.text);
        const hasColB = /(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*(?:B|II|2)/i.test(current.text);
        const hasCode = /(?:उत्तर\s*|सही\s*)?(?:कूट|कोड|Code|Codes)/i.test(current.text);
        const hasAnswer = /^\s*(?:Answer|Ans|उत्तर)\s*[:.-]/im.test(current.text);
        
        // In match-the-column, only true options after Code: or after Column B count as options
        let hasOptions = false;
        if (hasColA) {
          if (hasCode) {
            const afterCode = current.text.slice(current.text.search(/(?:उत्तर\s*|सही\s*)?(?:कूट|कोड|Code|Codes)/i));
            hasOptions = /^\s*(?:[A-D]\.|\([a-dA-D]\)|[A-D]\))\s+\S/m.test(afterCode);
          } else if (hasColB) {
            const afterColB = current.text.slice(current.text.search(/(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*(?:B|II|2)/i));
            hasOptions = /^\s*(?:[A-D]\.|\([a-dA-D]\))\s+(?:[A-Za-z0-9]\s*[-–—]|\d\s*,\s*\d|\S+)/m.test(afterColB);
          }
        } else {
          hasOptions = /^\s*(?:[A-D]\.|\([a-dA-D]\)|[A-D]\))\s+\S/m.test(current.text);
        }

        const hasExplanation = /(?:Explanation|व्याख्या|Solution|हल|विवरण)\s*[:.-]/i.test(current.text);

        if (hasQ) {
          // Explicit Q prefix (e.g. Q1, Q2, प्रश्न 1, Question No. 1) is always a new question
          isSubPoint = false;
        } else if (hasAnswer && !hasExplanation) {
          // If current question already has an answer and no explanation header follows,
          // any subsequent numbered line is the start of the next question.
          isSubPoint = false;
        } else if (hasAnswer && hasExplanation) {
          // Look ahead to check if candidate line is followed by options (meaning it's an MCQ question)
          let hasOptsAhead = false;
          for (let k = i + 1; k < lines.length && k < i + 15; k++) {
            const nextL = lines[k].trim();
            if (!nextL) continue;
            if (startRe.test(nextL)) break;
            if (/^\s*(?:[A-D]\.|\([a-dA-D]\)|[A-D]\))\s+\S/i.test(nextL)) {
              hasOptsAhead = true;
              break;
            }
          }

          if (hasOptsAhead) {
            isSubPoint = false;
          } else if (idx <= 10 && (leadingSpaces > baseIndent || idx === 1 || /^\s*1[.)]\s+/m.test(current.text.slice(current.text.search(/(?:Explanation|व्याख्या|Solution|हल|विवरण)/i))))) {
            isSubPoint = true;
          } else if (idx === current.idx + 1 && leadingSpaces <= baseIndent) {
            isSubPoint = false;
          } else {
            isSubPoint = false;
          }
        } else if (hasOptions) {
          // Sub-points always appear BEFORE options. Once options have appeared,
          // a numbered line cannot be a premise sub-point.
          isSubPoint = false;
        } else if (docPrefixType === "Q") {
          // If document uses Q prefixes, any numbered line before options/answers is a sub-point
          isSubPoint = true;
        } else if (leadingSpaces > baseIndent) {
          // Indented more than the base question -> sub-point
          isSubPoint = true;
        } else {
          const endsWithIntro = /[:：]\s*$|(?:कथन|विचार|सुमेलित|statement|following|column|सूची|कॉलम|स्तंभ)[^.\n]*$/i.test(current.text.trim());

          if (hasColA) {
            // Any numbered lines inside a match-the-column table before options are Column B items
            isSubPoint = true;
          } else if (idx === current.idx) {
            isSubPoint = true;
          } else if (idx === 1 && current.idx > 1) {
            isSubPoint = true;
          } else if (endsWithIntro && idx <= 10) {
            isSubPoint = true;
          } else if (idx <= 10 && /^\s*([1-9]|10)[.)]\s+/m.test(current.text)) {
            isSubPoint = true;
          }
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
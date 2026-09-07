// Convert LaTeX-ish math to plain-text Unicode that survives copy/paste
// into MS Word / Google Docs without breaking layout.

const SUPER: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
  a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ",
  g: "ᵍ", h: "ʰ", i: "ⁱ", j: "ʲ", k: "ᵏ", l: "ˡ",
  m: "ᵐ", n: "ⁿ", o: "ᵒ", p: "ᵖ", r: "ʳ", s: "ˢ",
  t: "ᵗ", u: "ᵘ", v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ",
};
const SUB: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
  "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
};

function mapChars(s: string, m: Record<string, string>): string {
  let out = "";
  for (const ch of s) out += m[ch] ?? ch;
  return out;
}

const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", iota: "ι", kappa: "κ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ",
  sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Alpha: "Α", Beta: "Β", Gamma: "Γ", Delta: "Δ", Theta: "Θ",
  Lambda: "Λ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Omega: "Ω",
};

export function latexToText(input: string): string {
  let s = input;

  // Protect literal escaped characters before processing math delimiters and tabular &
  s = s.replace(/\\\$/g, "@@DOLLAR@@");
  s = s.replace(/\\&/g, "@@AMP@@");
  s = s.replace(/\\%/g, "%");
  s = s.replace(/\\_/g, "@@UNDERSCORE@@");
  s = s.replace(/\\#/g, "#");

  // Clean matrix environments
  s = s.replace(/\\begin\s*\{(?:pmatrix|bmatrix|vmatrix|matrix|align|aligned|equation|gather)\*?\}/g, "");
  s = s.replace(/\\end\s*\{(?:pmatrix|bmatrix|vmatrix|matrix|align|aligned|equation|gather)\*?\}/g, "");
  s = s.replace(/\\\\/g, "\n");
  s = s.replace(/&/g, "  ");

  // Strip font/accent wrappers: \text{...}, \mathrm{...}, \vec{...}, \bar{...}, etc.
  s = s.replace(/\\(text|mathrm|operatorname|mathbf|mathit|overline|bar|vec|hat|tilde)\s*\{([^{}]*)\}/g, "$2");

  // Strip \left, \right
  s = s.replace(/\\(left|right)\s*/g, "");

  // \frac{a}{b}, \dfrac{a}{b}, \tfrac{a}{b} -> (a)/(b) (handles nested fractions up to 3 passes)
  for (let iter = 0; iter < 3; iter++) {
    if (!/\\(frac|dfrac|tfrac)\s*\{/.test(s)) break;
    s = s.replace(/\\(frac|dfrac|tfrac)\s*\{\s*([^{}]*?)\s*\}\s*\{\s*([^{}]*?)\s*\}/g, (_, _cmd, a, b) => `(${a.trim()})/(${b.trim()})`);
  }

  // \over fractions: {a \over b} -> (a)/(b)
  s = s.replace(/\{\s*([^{}]*?)\s*\\over\s*([^{}]*?)\s*\}/g, (_, a, b) => `(${a.trim()})/(${b.trim()})`);

  // \sqrt[n]{x} -> √[n](x)
  s = s.replace(/\\sqrt\s*\[([^{}]*)\]\s*\{([^{}]*)\}/g, "√[$1]($2)");
  // \sqrt{x} -> √(x)
  s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, "√($1)");
  // \sqrt x -> √x
  s = s.replace(/\\sqrt\s+(\S+)/g, "√$1");

  // Greek letters & Math symbols / operators
  s = s.replace(/\\([a-zA-Z]+)/g, (m, name) => {
    if (GREEK[name]) return GREEK[name];
    const common: Record<string, string> = {
      sin: "sin", cos: "cos", tan: "tan", cot: "cot",
      sec: "sec", csc: "cosec", cosec: "cosec",
      log: "log", ln: "ln", cdot: "·", times: "×", div: "÷",
      pm: "±", mp: "∓",
      le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠",
      approx: "≈", sim: "∼", cong: "≅", equiv: "≡",
      infty: "∞", to: "→", rightarrow: "→", leftarrow: "←",
      angle: "∠", degree: "°", circ: "°",
      triangle: "△", perp: "⊥", parallel: "∥",
      in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆",
      cup: "∪", cap: "∩",
      int: "∫", iint: "∬", sum: "∑", prod: "∏",
      therefore: "∴", because: "∵",
      forall: "∀", exists: "∃",
      dots: "...", ldots: "...", cdots: "...",
      implies: "⇒", iff: "⇔", leftrightarrow: "↔",
      partial: "∂", prime: "′", nabla: "∇",
      quad: " ", qquad: "  ",
    };
    return common[name] ?? name;
  });

  // Handle ^\circ or ^\degree -> °
  s = s.replace(/\^\{?\\(?:circ|degree)\}?/g, "°");

  // ^{...} superscript
  s = s.replace(/\^\{([^{}]*)\}/g, (_m, g1) => mapChars(g1, SUPER));
  // ^x single
  s = s.replace(/\^(\S)/g, (_m, g1) => mapChars(g1, SUPER));
  // _{...} subscript
  s = s.replace(/_\{([^{}]*)\}/g, (_m, g1) => mapChars(g1, SUB));
  s = s.replace(/_(\S)/g, (_m, g1) => mapChars(g1, SUB));

  // Strip stray $...$ math delimiters
  s = s.replace(/\$+/g, "");

  // Restore protected literal characters
  s = s.replace(/@@DOLLAR@@/g, "$");
  s = s.replace(/@@AMP@@/g, "&");
  s = s.replace(/@@UNDERSCORE@@/g, "_");

  // Collapse leftover braces
  s = s.replace(/[{}]/g, "");
  // Common leftovers
  s = s.replace(/\\,|\\;|\\!|\\ /g, " ");
  // Preserve newlines — they define paragraph structure in the AI output.
  // Collapse runs of spaces/tabs, but keep \n intact. Also strip trailing spaces per line.
  s = s.replace(/[ \t]+/g, " ");
  s = s.split("\n").map((l) => l.replace(/[ \t]+$/g, "")).join("\n");
  // Collapse 3+ blank lines to at most one blank line.
  s = s.replace(/\n{3,}/g, "\n\n").trim();

  return s;
}

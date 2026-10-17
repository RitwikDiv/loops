import { createRequire } from "node:module";
import { Resvg } from "@resvg/resvg-js";

const require = createRequire(import.meta.url);

type Converter = (tex: string, display: boolean) => string;
let converter: Converter | undefined;

/** MathJax in pure Node (no DOM, no browser): TeX with physics, mhchem, ams, cancel. */
function mathjax(): Converter {
  if (converter) return converter;
  const { mathjax } = require("mathjax-full/js/mathjax.js");
  const { TeX } = require("mathjax-full/js/input/tex.js");
  const { SVG } = require("mathjax-full/js/output/svg.js");
  const { liteAdaptor } = require("mathjax-full/js/adaptors/liteAdaptor.js");
  const { RegisterHTMLHandler } = require("mathjax-full/js/handlers/html.js");
  // Each TeX package must be loaded (registered) before the TeX input jax can use it.
  for (const cfg of ["ams/AmsConfiguration", "newcommand/NewcommandConfiguration", "physics/PhysicsConfiguration", "mhchem/MhchemConfiguration", "cancel/CancelConfiguration", "boldsymbol/BoldsymbolConfiguration", "noundefined/NoUndefinedConfiguration"]) {
    require(`mathjax-full/js/input/tex/${cfg}.js`);
  }
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const doc = mathjax.document("", {
    InputJax: new TeX({ packages: ["base", "ams", "newcommand", "physics", "mhchem", "cancel", "boldsymbol", "noundefined"] }),
    OutputJax: new SVG({ fontCache: "none" }),
  });
  converter = (tex, display) => {
    const html: string = adaptor.innerHTML(doc.convert(tex, { display }));
    if (/data-mjx-error|<merror/.test(html)) throw new Error("TeX error");
    return html.replace(/^<mjx-container[^>]*>/, "").replace(/<\/mjx-container>$/, "");
  };
  return converter;
}

const PX_PER_EX = 9;

/** TeX → standalone SVG with pixel sizes (resvg doesn't understand ex), padded on white. */
export function texToSvg(tex: string, display = true): string {
  const inner = mathjax()(tex, display);
  const w = parseFloat(inner.match(/width="([\d.]+)ex"/)?.[1] ?? "10") * PX_PER_EX;
  const h = parseFloat(inner.match(/height="([\d.]+)ex"/)?.[1] ?? "2") * PX_PER_EX;
  const body = inner
    .replace(/ style="[^"]*"/, "")
    .replace(/width="[\d.]+ex"/, `width="${w}"`)
    .replace(/height="[\d.]+ex"/, `height="${h}"`)
    .replace("<svg ", '<svg color="#1a1a2e" ');
  const pad = 10;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w + 2 * pad}" height="${h + 2 * pad}" viewBox="0 0 ${w + 2 * pad} ${h + 2 * pad}"><rect width="100%" height="100%" rx="8" fill="#ffffff"/><g transform="translate(${pad} ${pad})">${body}</g></svg>`;
}

export interface Raster {
  png: Buffer;
  width: number; // 1x logical pixels
}

export function svgToPng(svg: string, zoom = 2.5): Raster {
  const r = new Resvg(svg, {
    background: "#ffffff",
    fitTo: { mode: "zoom", value: zoom },
    font: { loadSystemFonts: true, defaultFontFamily: "Helvetica" },
  });
  const out = r.render();
  return { png: Buffer.from(out.asPng()), width: Math.round(out.width / zoom) };
}

export const texToPng = (tex: string, display = true): Raster => svgToPng(texToSvg(tex, display), 3);

// ---------------------------------------------------------------------------------------------
// Unicode fallback: a small TeX layout engine for terminals without image support.
// ---------------------------------------------------------------------------------------------

const unicodeit: { replace: (s: string) => string } = require("unicodeit");

interface Box {
  l: string[];
  b: number; // baseline row
}
const width = (s: string) => [...s.replace(/\p{M}/gu, "")].length;
const pad = (s: string, n: number, side: "l" | "r" | "c" = "r") => {
  const gap = Math.max(0, n - width(s));
  return side === "r" ? s + " ".repeat(gap) : side === "l" ? " ".repeat(gap) + s : " ".repeat(Math.floor(gap / 2)) + s + " ".repeat(Math.ceil(gap / 2));
};
const txt = (s: string): Box => ({ l: [s], b: 0 });
const boxW = (b: Box) => Math.max(...b.l.map(width));

function hcat(boxes: Box[]): Box {
  const live = boxes.filter((b) => b.l.length);
  if (!live.length) return txt("");
  const above = Math.max(...live.map((b) => b.b));
  const below = Math.max(...live.map((b) => b.l.length - b.b - 1));
  const rows: string[] = [];
  for (let r = 0; r < above + below + 1; r++) {
    rows.push(live.map((b) => pad(b.l[r - (above - b.b)] ?? "", boxW(b))).join(""));
  }
  return { l: rows, b: above };
}

function frac(n: Box, d: Box): Box {
  const w = Math.max(boxW(n), boxW(d)) + 2;
  return { l: [...n.l.map((s) => pad(s, w, "c")), "─".repeat(w), ...d.l.map((s) => pad(s, w, "c"))], b: n.l.length };
}

function sqrtBox(x: Box): Box {
  const w = boxW(x);
  const rows = x.l.map((s, i) => (i === 0 ? "√" : " ") + pad(s, w));
  return { l: [" " + "‾".repeat(w), ...rows.map((r, i) => (i === 0 ? "√" + r.slice(1) : r))], b: x.b + 1 };
}

const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ";
const SUB = "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓᵢⱼₙₖₗₘₚₛₜ";
const RELATIONS = new Set(["=", "≈", "≠", "≤", "≥", "→", "←", "↔", "⇒", "∝", "∼", "≡", "∈", "⊂", "⊆"]);
const BIG_OPS: Record<string, string> = { sum: "∑", prod: "∏", int: "∫", oint: "∮", lim: "lim" };

/** Try to write `s` entirely as unicode super/subscript characters. */
function script(kind: "^" | "_", s: string): string | null {
  const out = unicodeit.replace(`${kind}{${s}}`);
  return out && !/[\^_{}\\]/.test(out) ? out : null;
}

class Parser {
  i = 0;
  constructor(private s: string, private inline: boolean) {}

  group(): Box {
    // consumes one TeX argument: {…} or a single token
    this.ws();
    if (this.s[this.i] === "{") {
      this.i++;
      const b = this.seq("}");
      this.i++;
      return b;
    }
    if (this.s[this.i] === "\\") return this.token();
    return txt(this.s[this.i++] ?? "");
  }
  raw(): string {
    // raw text of one argument (for \text, \mathrm, accents …)
    this.ws();
    if (this.s[this.i] !== "{") return this.s[this.i++] ?? "";
    let depth = 0;
    const start = this.i + 1;
    for (; this.i < this.s.length; this.i++) {
      if (this.s[this.i] === "{") depth++;
      else if (this.s[this.i] === "}" && --depth === 0) break;
    }
    return this.s.slice(start, this.i++);
  }
  /** Raw TeX of one argument: {balanced}, a \\command, or a single character. */
  rawArg(): string {
    this.ws();
    if (this.s[this.i] === "{") return this.raw();
    const m = this.s.slice(this.i).match(/^\\(?:[a-zA-Z]+|.)/);
    if (m) {
      this.i += m[0].length;
      return m[0];
    }
    return this.s[this.i++] ?? "";
  }
  sub(tex: string): Box {
    return new Parser(tex, this.inline).seq();
  }
  ws() {
    while (/\s/.test(this.s[this.i] ?? "")) this.i++;
  }
  token(): Box {
    const m = this.s.slice(this.i).match(/^\\([a-zA-Z]+|.)/);
    if (!m) return txt(this.s[this.i++]);
    this.i += m[0].length;
    const name = m[1];
    if (name === "frac" || name === "dfrac" || name === "tfrac") {
      const n = this.group();
      const d = this.group();
      return this.inline ? txt(`${flat(n)}/${flat(d)}`.replace(/^(.{2,})\/(.+)$/, (_, a, b) => `${a.length > 1 && /[+\-−]/.test(a) ? `(${a})` : a}/${/[+\-−]/.test(b) ? `(${b})` : b}`)) : frac(n, d);
    }
    if (name === "sqrt") {
      const x = this.group();
      return this.inline ? txt(`√(${flat(x)})`) : sqrtBox(x);
    }
    if (name === "left" || name === "right") {
      const ch = this.s[this.i++];
      return txt(ch === "." ? "" : ch === "\\" ? this.s[this.i++] : ch);
    }
    if (["text", "mathrm", "operatorname", "textbf", "mathbf", "boldsymbol", "mathbb", "mathcal", "vec", "hat", "bar", "dot", "ddot", "tilde", "overline", "mathit", "mathsf", "mathscr", "mathfrak"].includes(name)) {
      return txt(unicodeit.replace(`\\${name}{${this.raw()}}`).replace(/^\\(?:text|mathrm|operatorname|overline)\{(.*)\}$/, "$1").replace(/^\\\w+\{(.*)\}$/, "$1"));
    }
    const phys = this.physics(name);
    if (phys) return phys;
    if (name in BIG_OPS) return this.bigOp(BIG_OPS[name], name);
    if (name === "\\" || name === "," || name === ";" || name === ":" || name === "!" || name === "quad" || name === "qquad") return txt(name === "quad" ? "  " : name === "qquad" ? "    " : name === "," || name === ";" || name === ":" ? " " : "");
    if (name === "begin" || name === "end") {
      this.raw();
      return txt(name === "begin" ? "" : "");
    }
    if (name === "&") return txt("  ");
    const u = unicodeit.replace(`\\${name}`);
    return txt(u.startsWith("\\") ? name : u);
  }
  physics(name: string): Box | null {
    const bold = (x: string) => unicodeit.replace(`\\mathbf{${x}}`);
    switch (name) {
      case "ket": return txt(`|${flat(this.sub(this.rawArg()))}⟩`);
      case "bra": return txt(`⟨${flat(this.sub(this.rawArg()))}|`);
      case "braket": { const a = flat(this.sub(this.rawArg())); const b = flat(this.sub(this.rawArg())); return txt(`⟨${a}|${b}⟩`); }
      case "expval": return txt(`⟨${flat(this.sub(this.rawArg()))}⟩`);
      case "abs": return txt(`|${flat(this.sub(this.rawArg()))}|`);
      case "norm": return txt(`‖${flat(this.sub(this.rawArg()))}‖`);
      case "vb": case "vu": return txt(name === "vb" ? bold(this.rawArg()) : unicodeit.replace(`\\hat{${this.rawArg()}}`));
      case "grad": return txt("∇");
      case "curl": return txt("∇×");
      case "div": return txt("∇·");
      case "laplacian": return txt("∇²");
      case "qty": return txt("");
      case "pdv": case "dv": {
        const d = name === "pdv" ? "∂" : "d";
        const f = this.rawArg();
        this.ws();
        const g = this.s[this.i] === "{" || this.s[this.i] === "\\" ? this.rawArg() : "";
        return this.inline ? txt(g ? `${d}${flat(this.sub(f))}/${d}${flat(this.sub(g))}` : `${d}/${d}${flat(this.sub(f))}`) : g ? frac(txt(`${d}${flat(this.sub(f))}`), txt(`${d}${flat(this.sub(g))}`)) : frac(txt(d), txt(`${d}${flat(this.sub(f))}`));
      }
      case "ce": return txt(chem(this.raw()));
    }
    return null;
  }
  bigOp(sym: string, name: string): Box {
    let lo: Box | undefined;
    let hi: Box | undefined;
    for (let k = 0; k < 2; k++) {
      this.ws();
      const c = this.s[this.i];
      if (c === "_" && !lo) (this.i++, (lo = this.group()));
      else if (c === "^" && !hi) (this.i++, (hi = this.group()));
    }
    if (this.inline) {
      const lim = lo || hi ? `[${lo ? flat(lo) : ""}${hi ? `→${flat(hi)}` : ""}]` : "";
      return txt(sym + lim);
    }
    const w = Math.max(width(sym), lo ? boxW(lo) : 0, hi ? boxW(hi) : 0);
    const rows = [...(hi ? hi.l.map((s) => pad(s, w, "c")) : []), pad(sym, w, "c"), ...(lo ? lo.l.map((s) => pad(s, w, "c")) : [])];
    return { l: rows, b: hi ? hi.l.length : 0 };
  }
  seq(stop?: string): Box {
    const parts: Box[] = [];
    while (this.i < this.s.length && this.s[this.i] !== stop) {
      const c = this.s[this.i];
      if (/\s/.test(c)) {
        this.i++;
      } else if (c === "{") {
        parts.push(this.group());
      } else if (c === "^" || c === "_") {
        this.i++;
        const rawTex = this.rawArg();
        const mapped = script(c, rawTex);
        const inner = flat(this.sub(rawTex));
        parts.push(txt(mapped ?? (/^[A-Za-z0-9]+$/.test(inner) ? `${c}${inner}` : `${c}(${inner})`)));
      } else if (c === "\\") {
        parts.push(this.token());
      } else {
        this.i++;
        const prev = parts[parts.length - 1];
        const before = prev ? flat(prev) : "";
        const binary = (c === "+" || c === "-") && before !== "" && !/[=≈≠≤≥→←(,\[]$/.test(before);
        const rel = RELATIONS.has(c);
        parts.push(txt(rel || binary ? ` ${c === "-" ? "−" : c} ` : c === "," ? ", " : c));
      }
    }
    // relations produced by commands (\approx, \to …) also get spacing
    const spaced = parts.map((p) => (p.l.length === 1 && RELATIONS.has(p.l[0]) ? txt(` ${p.l[0]} `) : p));
    return hcat(spaced);
  }
}

/** \\ce{2H2 + O2 -> 2H2O} → 2H₂ + O₂ → 2H₂O */
const chem = (s: string) =>
  s
    .replace(/<->|<=>/g, "⇌")
    .replace(/->/g, "→")
    .replace(/<-/g, "←")
    .replace(/([A-Za-z)])(\d+)/g, (_, a, n) => a + [...n].map((d: string) => SUB[+d]).join(""))
    .replace(/\^\{?([+-]?\d*[+-]?)\}?/g, (_, c) => script("^", c) ?? c);

const flat = (b: Box) => b.l.join(" ").replace(/\s+/g, " ").trim();

/** Display equation as multi-line Unicode art. */
export function texToLines(tex: string): string[] {
  const clean = tex.replace(/\\(?:label|tag)\{[^}]*\}/g, "").trim();
  const box = new Parser(clean, false).seq();
  return box.l.map((l) => l.replace(/\s+$/, ""));
}

/** Inline equation as one line of Unicode. */
export function texToInline(tex: string): string {
  return flat(new Parser(tex.trim(), true).seq());
}

/** Replace $…$, $$…$$, \(…\) in a plain string with Unicode (for prompts, options, flashcards). */
export function mathToText(s: string): string {
  const conv = (tex: string) => {
    try {
      return texToInline(tex);
    } catch {
      return tex;
    }
  };
  return s
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => conv(t))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => conv(t))
    .replace(/\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g, (m, t) => (/^\d/.test(t) && !/[\\^_{}]/.test(t) ? m : conv(t)));
}

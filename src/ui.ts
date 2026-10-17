import * as p from "@clack/prompts";
import pc from "picocolors";
import { renderDiagram } from "./diagram.js";
import { parsePlot, plotToBraille, renderPlot, sanitizeSvg, svgCaption } from "./figures.js";
import { mathToText, svgToPng, texToLines, texToPng, type Raster } from "./math.js";
import { drawImage, imageProtocol } from "./termimg.js";

const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;
const c256 = (n: number) => (s: string) => (useColor ? `\x1b[38;5;${n}m${s}\x1b[39m` : s);

export const t = {
  accent: c256(141),
  pink: c256(213),
  cyan: c256(87),
  ok: c256(78),
  warn: c256(215),
  bad: c256(203),
  dim: pc.dim,
  bold: pc.bold,
  italic: pc.italic,
};

const LOGO = [
  "  ██╗      ██████╗  ██████╗ ██████╗ ███████╗",
  "  ██║     ██╔═══██╗██╔═══██╗██╔══██╗██╔════╝",
  "  ██║     ██║   ██║██║   ██║██████╔╝███████╗",
  "  ██║     ██║   ██║██║   ██║██╔═══╝ ╚════██║",
  "  ███████╗╚██████╔╝╚██████╔╝██║     ███████║",
  "  ╚══════╝ ╚═════╝  ╚═════╝ ╚═╝     ╚══════╝",
];
const GRADIENT = [93, 99, 105, 141, 177, 213];

export function banner(subtitle = "learn anything, properly") {
  console.log();
  LOGO.forEach((line, i) => console.log(c256(GRADIENT[i])(line)));
  console.log(t.dim(`  ${subtitle}\n`));
}

/** Unwrap a clack prompt result; exit cleanly on Ctrl+C. */
export function must<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) {
    p.cancel("Progress saved. See you next time ✦");
    process.exit(0);
  }
  return value as Exclude<T, symbol>;
}

export async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const s = p.spinner();
  s.start(label);
  try {
    const r = await fn();
    s.stop(t.ok("✓ ") + label.replace(/\.\.\.$/, ""));
    return r;
  } catch (e) {
    s.stop(t.bad("✗ ") + label);
    throw e;
  }
}

export function bar(done: number, total: number, width = 20): string {
  const filled = total === 0 ? 0 : Math.round((done / total) * width);
  return t.accent("█".repeat(filled)) + t.dim("░".repeat(width - filled)) + t.dim(` ${done}/${total}`);
}

let tipShown = false;

/** Draw a raster inline if the terminal can; returns null otherwise. */
function inlineImage(r: Raster, maxCells: number): string | null {
  const proto = imageProtocol();
  if (!proto) return null;
  const cols = process.stdout.columns ?? 100;
  const cells = Math.max(8, Math.min(Math.ceil(r.width / 8), maxCells, cols - 4));
  return "  " + drawImage(r.png, cells, proto);
}

function figureNote(what: string, caption: string): string[] {
  const lines = ["  " + t.pink(`◆ ${what}`) + (caption ? t.dim(` — ${caption}`) : "") + t.dim("  (saved in the lesson's markdown file)")];
  if (!tipShown) {
    tipShown = true;
    lines.push("  " + t.dim("tip: iTerm2, WezTerm, Kitty and Ghostty draw figures inline; elsewhere open the .md file"));
  }
  return lines;
}

function renderEquation(tex: string): string[] {
  try {
    const img = imageProtocol() ? inlineImage(texToPng(tex, true), 60) : null;
    if (img) return ["", img, ""];
    return ["", ...texToLines(tex).map((l) => "    " + t.cyan(l)), ""];
  } catch {
    return ["", "    " + t.dim(tex.trim()), ""];
  }
}

function renderFigure(kind: "svg" | "plot", src: string): string[] {
  if (kind === "plot") {
    const p = renderPlot(src);
    if (!p) return figureNote("plot", "couldn't be drawn");
    const img = imageProtocol() ? inlineImage(p.raster, 70) : null;
    if (img) return ["", img, ""];
    const braille = plotToBraille(parsePlot(src)!, Math.min(64, (process.stdout.columns ?? 100) - 14), 14, useColor);
    return braille ? ["", ...braille.map((l) => "  " + l), ""] : figureNote("plot", p.caption);
  }
  const svg = sanitizeSvg(src);
  if (!svg) return figureNote("figure", "couldn't be drawn");
  const img = imageProtocol() ? inlineImage(svgToPng(svg, 2), 70) : null;
  return ["", img ?? figureNote("figure", svgCaption(svg)).join("\n"), ""];
}

/** Terminal markdown renderer: styling, mermaid, TeX equations, SVG figures and plots. */
export function renderMd(md: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  let buf: string[] = [];
  let math: string[] | null = null;
  const inline = (s: string) =>
    mathToText(s)
      .replace(/\*\*(.+?)\*\*/g, (_, x) => t.bold(x))
      .replace(/`([^`]+)`/g, (_, x) => t.cyan(x))
      .replace(/(?<![*\w])\*([^*]+)\*(?!\w)/g, (_, x) => t.italic(x));
  for (const raw of md.split("\n")) {
    // display math: $$ … $$ (one or many lines) and \[ … \]
    if (math) {
      const close = raw.match(/^(.*?)(\$\$|\\\])\s*$/);
      if (close) {
        math.push(close[1]);
        out.push(...renderEquation(math.join("\n")));
        math = null;
      } else math.push(raw);
      continue;
    }
    if (fence === null) {
      const one = raw.match(/^\s*(?:\$\$|\\\[)(.+?)(?:\$\$|\\\])\s*$/);
      if (one) {
        out.push(...renderEquation(one[1]));
        continue;
      }
      const open = raw.match(/^\s*(\$\$|\\\[)(.*)$/);
      if (open) {
        math = open[2].trim() ? [open[2]] : [];
        continue;
      }
    }
    const fm = raw.match(/^```(\w*)/);
    if (fm) {
      if (fence === null) {
        fence = fm[1] || "code";
        buf = [];
      } else {
        if (fence === "mermaid") {
          const art = renderDiagram(buf.join("\n"));
          out.push("", ...(art ? art.split("\n").map((l) => "  " + l) : ["  " + t.pink("◆ diagram ") + t.dim("(too wide for this terminal — open the markdown file)")]), "");
        } else if (fence === "svg" || fence === "plot") out.push(...renderFigure(fence, buf.join("\n")));
        fence = null;
      }
      continue;
    }
    if (fence === "mermaid" || fence === "svg" || fence === "plot") {
      buf.push(raw);
      continue;
    }
    if (fence !== null) {
      out.push("  " + t.dim("│ ") + t.cyan(raw));
      continue;
    }
    const h = raw.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      out.push("", "  " + (h[1].length <= 2 ? t.bold(t.accent(inline(h[2]))) : t.bold(inline(h[2]))));
      continue;
    }
    const li = raw.match(/^(\s*)[-*]\s+(.*)/);
    if (li) {
      out.push("  " + li[1] + t.accent("• ") + inline(li[2]));
      continue;
    }
    const q = raw.match(/^>\s?(.*)/);
    if (q) {
      out.push("  " + t.warn("▌ ") + t.italic(inline(q[1])));
      continue;
    }
    out.push(raw.trim() ? "  " + inline(raw) : "");
  }
  return out.join("\n");
}

/** Plain-text math for prompts, options and flashcards. */
export const m = mathToText;

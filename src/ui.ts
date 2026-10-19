import * as p from "@clack/prompts";
import pc from "picocolors";
import { renderDiagram } from "./diagram.js";
import { parsePlot, plotToBraille, renderPlot, sanitizeSvg, svgCaption } from "./figures.js";
import { mathToText, svgToPng, texToLines, texToPng, type Raster } from "./math.js";
import { isTableLine, renderTable } from "./table.js";
import { drawImage, imageProtocol } from "./termimg.js";
import { writeReading, type ReadingChunk } from "./reading.js";

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
  return renderMdChunks(md).map((chunk) => chunk.text).join("");
}

/** Keep prose separate from complete terminal blocks, including image escape sequences. */
export function renderMdChunks(md: string): ReadingChunk[] {
  const out: ReadingChunk[] = [];
  const emit = (animate: boolean, ...lines: string[]) => {
    if (!lines.length) return;
    const text = (out.length ? "\n" : "") + lines.join("\n");
    const last = out.at(-1);
    if (last?.animate === animate) last.text += text;
    else out.push({ text, animate });
  };
  let fence: string | null = null;
  let buf: string[] = [];
  let math: string[] | null = null;
  const inline = (s: string) =>
    mathToText(s)
      .replace(/\*\*(.+?)\*\*/g, (_, x) => t.bold(x))
      .replace(/`([^`]+)`/g, (_, x) => t.cyan(x))
      .replace(/(?<![*\w])\*([^*]+)\*(?!\w)/g, (_, x) => t.italic(x));
  let tableBuf: string[] = [];
  const flushTable = () => {
    const cols = process.stdout.columns ?? 100;
    emit(false, ...renderTable(tableBuf, inline, (x) => t.bold(t.accent(inline(x))), t.dim, cols - 4).map((l) => "  " + l));
    tableBuf = [];
  };
  for (const raw of md.split("\n")) {
    if (tableBuf.length && !isTableLine(raw)) flushTable();
    // display math: $$ … $$ (one or many lines) and \[ … \]
    if (math) {
      const close = raw.match(/^(.*?)(\$\$|\\\])\s*$/);
      if (close) {
        math.push(close[1]);
        emit(false, ...renderEquation(math.join("\n")));
        math = null;
      } else math.push(raw);
      continue;
    }
    if (fence === null) {
      const one = raw.match(/^\s*(?:\$\$|\\\[)(.+?)(?:\$\$|\\\])\s*$/);
      if (one) {
        emit(false, ...renderEquation(one[1]));
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
          emit(false, "", ...(art ? art.split("\n").map((l) => "  " + l) : ["  " + t.pink("◆ diagram ") + t.dim("(too wide for this terminal — open the markdown file)")]), "");
        } else if (fence === "svg" || fence === "plot") emit(false, ...renderFigure(fence, buf.join("\n")));
        fence = null;
      }
      continue;
    }
    if (fence === "mermaid" || fence === "svg" || fence === "plot") {
      buf.push(raw);
      continue;
    }
    if (fence !== null) {
      emit(false, "  " + t.dim("│ ") + t.cyan(raw));
      continue;
    }
    if (isTableLine(raw)) {
      tableBuf.push(raw);
      continue;
    }
    const h = raw.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      emit(false, "", "  " + (h[1].length <= 2 ? t.bold(t.accent(inline(h[2]))) : t.bold(inline(h[2]))));
      continue;
    }
    const li = raw.match(/^(\s*)[-*]\s+(.*)/);
    if (li) {
      emit(true, "  " + li[1] + t.accent("• ") + inline(li[2]));
      continue;
    }
    const q = raw.match(/^>\s?(.*)/);
    if (q) {
      emit(true, "  " + t.warn("▌ ") + t.italic(inline(q[1])));
      continue;
    }
    emit(!!raw.trim(), raw.trim() ? "  " + inline(raw) : "");
  }
  if (tableBuf.length) flushTable();
  return out;
}

/** Pace lesson explanations; prompts and other UI continue to render immediately. */
export async function readLesson(md: string): Promise<void> {
  const chunks = renderMdChunks(md);
  chunks.push({ text: "\n\n", animate: false });
  const completed = await writeReading(chunks, () => p.log.message(t.dim("Reading · Space to pause/resume · Enter to show all")));
  if (!completed) {
    p.cancel("Progress saved. See you next time ✦");
    process.exit(0);
  }
}

/** Plain-text math for prompts, options and flashcards. */
export const m = mathToText;

import { compile } from "mathjs";
import { svgToPng, type Raster } from "./math.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Model-drawn diagrams (free-body, ray, circuit, field, wave...) arrive as raw SVG. Keep only static
 * vector content: no scripts, event handlers, foreign objects or external references. Returns null
 * if it isn't usable SVG or resvg can't render it.
 */
export function sanitizeSvg(src: string): string | null {
  let svg = src.trim();
  const start = svg.indexOf("<svg");
  const end = svg.lastIndexOf("</svg>");
  if (start === -1 || end === -1) return null;
  svg = svg.slice(start, end + 6);
  svg = svg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, "")
    .replace(/\s(?:xlink:)?href\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*')/gi, "");
  if (!/xmlns=/.test(svg)) svg = svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  if (!/viewBox=/.test(svg) && !/width=/.test(svg)) svg = svg.replace("<svg", '<svg viewBox="0 0 640 360"');
  // A white page behind it, so line art is legible in light and dark viewers alike.
  svg = svg.replace(/(<svg[^>]*>)/, '$1<rect width="100%" height="100%" fill="#ffffff"/>');
  try {
    svgToPng(svg, 1);
  } catch {
    return null;
  }
  return svg;
}

export const svgCaption = (svg: string) => svg.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? "";

export interface PlotSpec {
  title?: string;
  xlabel?: string;
  ylabel?: string;
  xmin: number;
  xmax: number;
  ymin?: number;
  ymax?: number;
  series: { label?: string; expr: string }[];
}

export function parsePlot(src: string): PlotSpec | null {
  try {
    const x = JSON.parse(src);
    if (!Number.isFinite(x.xmin) || !Number.isFinite(x.xmax) || x.xmax <= x.xmin || !Array.isArray(x.series) || !x.series.length) return null;
    return x as PlotSpec;
  } catch {
    return null;
  }
}

const COLORS = ["#4c78a8", "#e45756", "#54a24b", "#b279a2", "#f58518"];

const niceStep = (range: number, target = 6) => {
  const raw = range / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * pow;
};
const fmt = (v: number) => (Math.abs(v) < 1e-9 ? "0" : String(Number(v.toPrecision(3))));

/** Exact function plot: the model supplies expressions, mathjs evaluates them, we draw the SVG. */
export function plotToSvg(spec: PlotSpec): string | null {
  const W = 640, H = 360, L = 62, R = 24, T = spec.title ? 44 : 24, B = 56;
  const N = 480;
  const xs = Array.from({ length: N + 1 }, (_, i) => spec.xmin + ((spec.xmax - spec.xmin) * i) / N);
  const curves: { label: string; pts: (number | null)[] }[] = [];
  for (const s of spec.series.slice(0, 5)) {
    let f;
    try {
      f = compile(s.expr.replace(/^\s*(?:y|f\(x\))\s*=\s*/, ""));
    } catch {
      return null;
    }
    curves.push({
      label: s.label ?? s.expr,
      pts: xs.map((x) => {
        try {
          const v = f.evaluate({ x, pi: Math.PI, e: Math.E });
          return typeof v === "number" && Number.isFinite(v) ? v : null;
        } catch {
          return null;
        }
      }),
    });
  }
  const vals = curves.flatMap((c) => c.pts.filter((v): v is number => v !== null));
  if (!vals.length) return null;
  let ymin = spec.ymin ?? Math.min(...vals);
  let ymax = spec.ymax ?? Math.max(...vals);
  if (ymax - ymin < 1e-9) (ymin -= 1), (ymax += 1);
  if (spec.ymin === undefined) ymin -= (ymax - ymin) * 0.06;
  if (spec.ymax === undefined) ymax += (ymax - ymin) * 0.06;
  const px = (x: number) => L + ((x - spec.xmin) / (spec.xmax - spec.xmin)) * (W - L - R);
  const py = (y: number) => H - B - ((y - ymin) / (ymax - ymin)) * (H - T - B);
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif" font-size="12">`, '<rect width="100%" height="100%" fill="#ffffff"/>'];
  const xstep = niceStep(spec.xmax - spec.xmin);
  for (let v = Math.ceil(spec.xmin / xstep) * xstep; v <= spec.xmax + 1e-9; v += xstep) out.push(`<line x1="${px(v)}" y1="${T}" x2="${px(v)}" y2="${H - B}" stroke="#e6e6ee"/><text x="${px(v)}" y="${H - B + 16}" text-anchor="middle" fill="#555">${fmt(v)}</text>`);
  const ystep = niceStep(ymax - ymin);
  for (let v = Math.ceil(ymin / ystep) * ystep; v <= ymax + 1e-9; v += ystep) out.push(`<line x1="${L}" y1="${py(v)}" x2="${W - R}" y2="${py(v)}" stroke="#e6e6ee"/><text x="${L - 8}" y="${py(v) + 4}" text-anchor="end" fill="#555">${fmt(v)}</text>`);
  if (ymin < 0 && ymax > 0) out.push(`<line x1="${L}" y1="${py(0)}" x2="${W - R}" y2="${py(0)}" stroke="#888"/>`);
  if (spec.xmin < 0 && spec.xmax > 0) out.push(`<line x1="${px(0)}" y1="${T}" x2="${px(0)}" y2="${H - B}" stroke="#888"/>`);
  out.push(`<rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="none" stroke="#999"/>`);
  curves.forEach((c, k) => {
    let d = "";
    let pen = false;
    c.pts.forEach((v, i) => {
      if (v === null || v < ymin - (ymax - ymin) || v > ymax + (ymax - ymin)) return void (pen = false);
      d += `${pen ? "L" : "M"}${px(xs[i]).toFixed(1)},${py(v).toFixed(1)}`;
      pen = true;
    });
    out.push(`<path d="${d}" fill="none" stroke="${COLORS[k % COLORS.length]}" stroke-width="2.4" stroke-linejoin="round"/>`);
  });
  if (spec.title) out.push(`<text x="${W / 2}" y="24" text-anchor="middle" font-size="15" font-weight="bold" fill="#222">${esc(spec.title)}</text>`);
  if (spec.xlabel) out.push(`<text x="${(L + W - R) / 2}" y="${H - 12}" text-anchor="middle" fill="#333">${esc(spec.xlabel)}</text>`);
  if (spec.ylabel) out.push(`<text transform="translate(16 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle" fill="#333">${esc(spec.ylabel)}</text>`);
  if (curves.length > 1 || spec.series[0].label)
    curves.forEach((c, k) => out.push(`<rect x="${W - R - 150}" y="${T + 8 + k * 18}" width="12" height="4" fill="${COLORS[k % COLORS.length]}"/><text x="${W - R - 132}" y="${T + 14 + k * 18}" fill="#333">${esc(c.label)}</text>`));
  out.push("</svg>");
  return out.join("");
}

export function renderPlot(src: string): { svg: string; raster: Raster; caption: string } | null {
  const spec = parsePlot(src);
  const svg = spec && plotToSvg(spec);
  if (!spec || !svg) return null;
  return { svg, raster: svgToPng(svg, 2), caption: spec.title ?? "plot" };
}

const BRAILLE = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];
const CURVE_ANSI = [75, 203, 114, 176, 208];

/** Plot as braille dots (2x4 per cell): decent line art in any Unicode terminal. */
export function plotToBraille(spec: PlotSpec, cols = 64, rows = 14, color = true): string[] | null {
  const Wd = cols * 2, Hd = rows * 4;
  const curves = spec.series.slice(0, 5).map((s) => {
    try {
      const f = compile(s.expr.replace(/^\s*(?:y|f\(x\))\s*=\s*/, ""));
      return Array.from({ length: Wd }, (_, i) => {
        const v = f.evaluate({ x: spec.xmin + ((spec.xmax - spec.xmin) * i) / (Wd - 1), pi: Math.PI, e: Math.E });
        return typeof v === "number" && Number.isFinite(v) ? v : null;
      });
    } catch {
      return null;
    }
  });
  if (curves.some((c) => c === null)) return null;
  const vals = (curves as (number | null)[][]).flat().filter((v): v is number => v !== null);
  if (!vals.length) return null;
  let ymin = spec.ymin ?? Math.min(...vals), ymax = spec.ymax ?? Math.max(...vals);
  if (ymax - ymin < 1e-9) (ymin -= 1), (ymax += 1);
  const dots = new Map<number, { mask: number; series: number }>();
  const plot = (x: number, y: number, k: number) => {
    if (x < 0 || x >= Wd || y < 0 || y >= Hd) return;
    const key = Math.floor(y / 4) * cols + Math.floor(x / 2);
    const cur = dots.get(key) ?? { mask: 0, series: k };
    cur.mask |= BRAILLE[y % 4][x % 2];
    dots.set(key, cur);
  };
  (curves as (number | null)[][]).forEach((c, k) => {
    let prev: number | null = null;
    c.forEach((v, x) => {
      if (v === null) return void (prev = null);
      const y = Math.round((1 - (v - ymin) / (ymax - ymin)) * (Hd - 1));
      const from = prev ?? y;
      for (let yy = Math.min(from, y); yy <= Math.max(from, y); yy++) plot(x, yy, k);
      prev = y;
    });
  });
  const paint = (s: string, k: number) => (color ? `\x1b[38;5;${CURVE_ANSI[k % CURVE_ANSI.length]}m${s}\x1b[39m` : s);
  const lab = (v: number) => fmt(v).padStart(7);
  const lines: string[] = [];
  if (spec.title) lines.push(" ".repeat(8) + spec.title);
  for (let r = 0; r < rows; r++) {
    let row = "";
    for (let c = 0; c < cols; c++) {
      const d = dots.get(r * cols + c);
      row += d ? paint(String.fromCharCode(0x2800 + d.mask), d.series) : " ";
    }
    lines.push((r === 0 ? lab(ymax) : r === rows - 1 ? lab(ymin) : r === Math.floor(rows / 2) ? lab((ymin + ymax) / 2) : " ".repeat(7)) + " │" + row);
  }
  lines.push(" ".repeat(8) + "└" + "─".repeat(cols));
  lines.push(" ".repeat(9) + fmt(spec.xmin) + " ".repeat(Math.max(1, cols - fmt(spec.xmin).length - fmt(spec.xmax).length)) + fmt(spec.xmax) + (spec.xlabel ? `   ${spec.xlabel}` : ""));
  if (spec.series.length > 1 || spec.series[0].label) lines.push(" ".repeat(9) + spec.series.slice(0, 5).map((s, k) => paint("━ " + (s.label ?? s.expr), k)).join("   "));
  return lines;
}

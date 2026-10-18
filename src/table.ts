import Table from "cli-table3";

type Align = "left" | "center" | "right";

export const isTableLine = (s: string) => /^\s*\|.*\|\s*$/.test(s);

const ANSI = /\x1b\[[0-9;]*m/g;
const visible = (s: string) => s.replace(ANSI, "").length;

function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return body.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

const alignOf = (c: string): Align => (/^:-+:$/.test(c) ? "center" : /^-+:$/.test(c) ? "right" : "left");

/**
 * Draw a markdown table (consecutive `| a | b |` lines) as a bordered, aligned box that wraps to maxWidth.
 * `cell` styles a cell's text (e.g. inline bold/code/math); `head` styles header cells.
 */
export function renderTable(lines: string[], cell: (s: string) => string, head: (s: string) => string, border: (s: string) => string, maxWidth: number): string[] {
  const rows = lines.map(splitRow);
  const hasHeader = rows.length > 1 && rows[1].every((c) => /^:?-+:?$/.test(c));
  const aligns = hasHeader ? rows[1].map(alignOf) : [];
  const data = hasHeader ? [rows[0], ...rows.slice(2)] : rows;
  const n = Math.max(...data.map((r) => r.length));
  const grid = data.map((r, i) => Array.from({ length: n }, (_, c) => (hasHeader && i === 0 ? head : cell)(r[c] ?? "")));

  const widths = Array.from({ length: n }, (_, c) => Math.max(1, ...grid.map((r) => Math.max(...r[c].split("\n").map(visible)))));
  const budget = maxWidth - (3 * n + 1);
  if (budget < 5 * n) return stacked(data, hasHeader, cell, head);
  while (widths.reduce((a, b) => a + b, 0) > budget) widths[widths.indexOf(Math.max(...widths))]--;

  const table = new Table({
    chars: { top: "─", "top-mid": "┬", "top-left": "╭", "top-right": "╮", bottom: "─", "bottom-mid": "┴", "bottom-left": "╰", "bottom-right": "╯", left: "│", "left-mid": "├", mid: "─", "mid-mid": "┼", right: "│", "right-mid": "┤", middle: "│" },
    style: { head: [], border: [], "padding-left": 1, "padding-right": 1 },
    colWidths: widths.map((w) => w + 2),
    colAligns: Array.from({ length: n }, (_, c) => aligns[c] ?? "left"),
    wordWrap: true,
  });
  grid.forEach((r) => table.push(r));
  let drawn = table.toString().split("\n");
  // keep the rule under the header; drop the ones between single-line rows (they only add noise)
  const wrapped = drawn.length - (grid.length * 2 + 1) > 0;
  if (!wrapped) drawn = drawn.filter((l, i) => !l.startsWith("├") || i === drawn.findIndex((x) => x.startsWith("├")));
  return drawn.map((l) => l.replace(/[─│╭╮╰╯├┤┬┴┼]+/g, border));
}

/** Fallback for terminals too narrow for a grid: one "header: value" block per row. */
function stacked(data: string[][], hasHeader: boolean, cell: (s: string) => string, head: (s: string) => string): string[] {
  const out: string[] = [];
  const keys = hasHeader ? data[0] : [];
  for (const r of hasHeader ? data.slice(1) : data) {
    out.push(...r.map((v, c) => (keys[c] ? `${head(keys[c])}: ${cell(v)}` : cell(v))), "");
  }
  return out.slice(0, -1);
}

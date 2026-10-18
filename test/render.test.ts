import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson, repairLatexEscapes } from "../src/llm.ts";
import { mathToText, texToLines, texToPng, texToInline } from "../src/math.ts";
import { parsePlot, plotToBraille, plotToSvg, sanitizeSvg } from "../src/figures.ts";
import { drawImage, imageProtocol } from "../src/termimg.ts";
import { materializeFigures } from "../src/markdown.ts";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("LaTeX backslashes the model forgot to double survive JSON parsing", () => {
  const raw = String.raw`{"markdown":"Use $\theta$, $\nabla \times \vec{E}$, $\frac{a}{b}$, $\rho$, $\beta$, $\upsilon$ and $\\frac{x}{y}$.\nNext line","n":1}`;
  const got = extractJson(raw) as { markdown: string };
  assert.equal(got.markdown, String.raw`Use $\theta$, $\nabla \times \vec{E}$, $\frac{a}{b}$, $\rho$, $\beta$, $\upsilon$ and $\frac{x}{y}$.` + "\nNext line");
});

test("repair leaves already-correct JSON alone", () => {
  const ok = String.raw`{"a":"\\theta \\nabla","b":"line\nbreak \"q\" \u00e9"}`;
  assert.equal(repairLatexEscapes(ok), ok);
});

test("equations: stacked fractions, roots, sums and physics macros in the unicode fallback", () => {
  const f = texToLines(String.raw`\frac{a}{b}`).map((l) => l.trim());
  assert.equal(f[0], "a");
  assert.match(f[1], /^─+$/);
  assert.equal(f[2], "b");
  assert.match(texToLines(String.raw`\sum_{n=1}^{\infty}\frac{1}{n^2}`).join("\n"), /∑/);
  assert.equal(texToInline(String.raw`E = mc^2`), "E = mc²");
  assert.match(texToInline(String.raw`\ket{\psi}`), /\|ψ⟩/);
  assert.match(texToInline(String.raw`\ce{2H2 + O2 -> 2H2O}`), /2H₂ \+ O₂ → 2H₂O/);
});

test("mathToText converts math but not dollar amounts", () => {
  assert.equal(mathToText("costs $5 and $6, but $x^2$ is math"), "costs $5 and $6, but x² is math");
});

test("MathJax renders physics TeX to a PNG, and rejects broken TeX", () => {
  const r = texToPng(String.raw`\pdv{f}{x} = \vb{F}\cdot\ket{\psi}`);
  assert.equal(r.png.subarray(1, 4).toString(), "PNG");
  assert.throws(() => texToPng(String.raw`\frac{1}{`));
});

test("plots: exact evaluation, svg and braille output", () => {
  const spec = parsePlot('{"xmin":0,"xmax":6.28,"series":[{"label":"sin","expr":"sin(x)"}]}')!;
  assert.match(plotToSvg(spec)!, /<path d="M/);
  const b = plotToBraille(spec, 40, 8, false)!;
  assert.ok(b.some((l) => /[\u2801-\u28ff]/.test(l)));
  assert.equal(parsePlot('{"xmin":1,"xmax":0,"series":[]}'), null);
  assert.equal(plotToSvg({ xmin: 0, xmax: 1, series: [{ expr: "((" }] }), null);
});

test("svg sanitiser strips scripts/handlers/external refs and rejects junk", () => {
  const dirty = `<svg viewBox='0 0 100 100'><script>alert(1)</script><circle cx='50' cy='50' r='20' onclick='x()'/><image href='http://evil/x.png'/></svg>`;
  const clean = sanitizeSvg(dirty)!;
  assert.doesNotMatch(clean, /script|onclick|evil/);
  assert.equal(sanitizeSvg("not svg at all"), null);
  assert.equal(sanitizeSvg("<svg><rect width='bad'"), null);
});

test("image protocol detection and escape sequences", () => {
  assert.equal(imageProtocol({ TERM_PROGRAM: "iTerm.app" } as any, true), "iterm");
  assert.equal(imageProtocol({ TERM: "xterm-kitty" } as any, true), "kitty");
  assert.equal(imageProtocol({ TERM_PROGRAM: "Apple_Terminal" } as any, true), null);
  assert.equal(imageProtocol({ TERM_PROGRAM: "iTerm.app", TMUX: "1" } as any, true), null);
  assert.equal(imageProtocol({ TERM_PROGRAM: "iTerm.app" } as any, false), null);
  assert.match(drawImage(Buffer.from("x"), 30, "iterm"), /^\x1b\]1337;File=inline=1;width=30/);
  assert.match(drawImage(Buffer.alloc(6000), 30, "kitty"), /^\x1b_Ga=T,f=100,c=30,m=1;/);
});

test("materializeFigures writes svg files and swaps in image links", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loops-t-"));
  const md = "Intro\n```plot\n" + '{"title":"Wave","xmin":0,"xmax":3,"series":[{"expr":"sin(x)"}]}' + "\n```\n$$E=mc^2$$\n```svg\nnope\n```\n";
  const out = await materializeFigures(md, dir, "deep/a/01-x.md");
  assert.match(out, /!\[Wave\]\(\.\.\/\.\.\/figures\/deep-a-01-x-1\.svg\)/);
  assert.match(out, /\$\$E=mc\^2\$\$/);
  assert.match(out, /could not be rendered/);
  assert.ok(existsSync(join(dir, "figures/deep-a-01-x-1.svg")));
  assert.match(readFileSync(join(dir, "figures/deep-a-01-x-1.svg"), "utf8"), /<svg/);
});

test("markdown tables render as an aligned box", async () => {
  const { renderTable } = await import("../src/table.ts");
  const id = (s: string) => s;
  const rows = ["| Class | What you own | Example |", "|---|---|---|", "| Equities | Slice of a company | Apple shares |", "| Bonds | A loan, paid back with interest | US Treasuries |"];
  const out = renderTable(rows, id, id, id, 100);
  assert.equal(out.length, 6); // top, header, rule, 2 rows, bottom
  assert.equal(new Set(out.map((l) => l.length)).size, 1); // every line the same width
  assert.ok(out[1].includes("Class") && !out.join("\n").includes("---"));
  const narrow = renderTable(rows, id, id, id, 40);
  assert.ok(narrow.every((l) => l.length <= 40));
  assert.ok(narrow.join(" ").includes("company"));
  assert.ok(renderTable(rows, id, id, id, 12).join("\n").includes("Class: Equities")); // stacked fallback
});

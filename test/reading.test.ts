import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeReading } from "../src/reading.ts";
import { renderMd, renderMdChunks } from "../src/ui.ts";

function terminal() {
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    paused: true,
    setRawMode(value: boolean) { this.isRaw = value; return this; },
    isPaused() { return this.paused; },
    resume() { this.paused = false; return this; },
    pause() { this.paused = true; return this; },
  });
  const writes: string[] = [];
  const output = { isTTY: true, write(text: string) { writes.push(text); return true; } };
  const key = (text: string) => input.emit("data", Buffer.from(text));
  return { input, output, writes, key };
}

test("lesson prose is paced while headings, code, tables, math and diagrams stay whole", () => {
  const md = [
    "## Read this", "", "An **important** idea.", "- A detail", "> An analogy", "",
    "| Name | Value |", "|---|---|", "| x | 2 |", "",
    "```ts", "const n = 2;", "```", "",
    "$$x^2$$", "", "```mermaid", "flowchart LR", "A --> B", "```", "",
    "```plot", '{"xmin":0,"xmax":1,"series":[{"expr":"x"}]}', "```", "",
    "More prose.",
  ].join("\n");
  const chunks = renderMdChunks(md);
  assert.equal(chunks.map((c) => c.text).join(""), renderMd(md));
  const prose = chunks.filter((c) => c.animate).map((c) => c.text).join("");
  assert.match(prose, /important/);
  assert.match(prose, /A detail/);
  assert.match(prose, /An analogy/);
  assert.match(prose, /More prose/);
  assert.doesNotMatch(prose, /Read this|Name|Value|const n|x²|[\u2801-\u28ff]/);
  const blocks = chunks.filter((c) => !c.animate).map((c) => c.text).join("");
  assert.match(blocks, /Read this/);
  assert.match(blocks, /Name/);
  assert.match(blocks, /const n = 2/);
  assert.match(blocks, /x²/);
  assert.match(blocks, /A/);
});

test("terminal images are emitted as complete blocks between prose", (t) => {
  const previous = process.env.LOOPS_IMAGES;
  process.env.LOOPS_IMAGES = "iterm";
  t.after(() => {
    if (previous === undefined) delete process.env.LOOPS_IMAGES;
    else process.env.LOOPS_IMAGES = previous;
  });
  const chunks = renderMdChunks('Before.\n```svg\n<svg width="20" height="20"><circle cx="10" cy="10" r="5"/></svg>\n```\nAfter.');
  const image = chunks.find((c) => c.text.includes("\x1b]1337;"))!;
  assert.ok(image);
  assert.equal(image.animate, false);
  assert.match(image.text, /\x1b\]1337;[^\x07]+\x07/);
  assert.equal(chunks.filter((c) => c.animate).length, 2);
});

test("prose types gradually, preserving graphemes and ANSI escapes; blocks write at once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const term = terminal();
  const result = writeReading([
    { text: "\x1b[1m👩‍💻é\x1b[22m", animate: true },
    { text: "\nwhole table\n", animate: false },
  ], undefined, { ...term, delayMs: 30 });
  assert.deepEqual(term.writes, ["\x1b[1m", "👩‍💻"]);
  t.mock.timers.tick(30);
  await Promise.resolve();
  assert.deepEqual(term.writes, ["\x1b[1m", "👩‍💻", "é"]);
  t.mock.timers.tick(30);
  assert.equal(await result, true);
  assert.deepEqual(term.writes, ["\x1b[1m", "👩‍💻", "é", "\x1b[22m", "\nwhole table\n"]);
  assert.equal(term.input.isRaw, false);
  assert.equal(term.input.isPaused(), true);
  assert.equal(term.input.listenerCount("data"), 0);
});

test("Space pauses across blocks and Enter reveals the rest without leaking into the next prompt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const term = terminal();
  const result = writeReading([
    { text: "ab", animate: true },
    { text: "[table]", animate: false },
    { text: "cd", animate: true },
  ], undefined, { ...term, delayMs: 30 });
  assert.equal(term.writes.join(""), "a");
  term.key(" ");
  await Promise.resolve();
  t.mock.timers.tick(10_000);
  await Promise.resolve();
  assert.equal(term.writes.join(""), "a");
  term.key(" ");
  await Promise.resolve();
  assert.equal(term.writes.join(""), "ab");
  term.key(" ");
  await Promise.resolve();
  assert.equal(term.writes.join(""), "ab");
  term.key("\r");
  assert.equal(await result, true);
  assert.equal(term.writes.join(""), "ab[table]cd");
  assert.equal(term.input.listenerCount("data"), 0);
  assert.equal(term.input.isRaw, false);
});

test("Ctrl+C interrupts even while paused and restores prior terminal state", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const term = terminal();
  term.input.isRaw = true;
  term.input.resume();
  const result = writeReading([{ text: "abc", animate: true }], undefined, { ...term, delayMs: 30 });
  term.key(" ");
  await Promise.resolve();
  term.key("\x03");
  assert.equal(await result, false);
  assert.equal(term.writes.join(""), "a");
  assert.equal(term.input.isRaw, true);
  assert.equal(term.input.isPaused(), false);
  assert.equal(term.input.listenerCount("data"), 0);
});

test("redirected output and zero delay print immediately without claiming stdin", async () => {
  for (const mode of ["pipe", "non-tty-input", "disabled"] as const) {
    const term = terminal();
    if (mode === "pipe") term.output.isTTY = false;
    if (mode === "non-tty-input") term.input.isTTY = false;
    let started = false;
    assert.equal(await writeReading([{ text: "Full lesson", animate: true }], () => { started = true; }, {
      ...term, delayMs: mode === "disabled" ? 0 : 30,
    }), true);
    assert.deepEqual(term.writes, ["Full lesson"]);
    assert.equal(started, false);
    assert.equal(term.input.isPaused(), true);
    assert.equal(term.input.listenerCount("data"), 0);
  }
});

test("write errors still release raw input", async () => {
  const term = terminal();
  term.output.write = () => { throw new Error("closed output"); };
  await assert.rejects(writeReading([{ text: "abc", animate: true }], undefined, { ...term, delayMs: 30 }), /closed output/);
  assert.equal(term.input.isRaw, false);
  assert.equal(term.input.isPaused(), true);
  assert.equal(term.input.listenerCount("data"), 0);
});

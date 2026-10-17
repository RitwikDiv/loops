import { test } from "node:test";
import assert from "node:assert/strict";
import { applyActivity, currentStreak, type Stats } from "../src/stats.ts";
import { interleave, pickCards } from "../src/flows/quiz.ts";
import { newCard } from "../src/srs.ts";
import { mistakesMarkdown } from "../src/markdown.ts";

const base: Stats = { streak: 0, longest: 0, lastDay: "", totalDays: 0 };
const d = (s: string) => new Date(`${s}T12:00:00`);

test("streak: grows on consecutive days, resets after a gap, idempotent within a day", () => {
  let s = applyActivity(base, d("2026-03-01")).stats;
  assert.equal(s.streak, 1);
  const again = applyActivity(s, d("2026-03-01"));
  assert.equal(again.extended, false);
  s = applyActivity(s, d("2026-03-02")).stats;
  s = applyActivity(s, d("2026-03-03")).stats;
  assert.equal(s.streak, 3);
  assert.equal(currentStreak(s, d("2026-03-04")), 3); // still savable
  assert.equal(currentStreak(s, d("2026-03-05")), 0); // lapsed
  const reset = applyActivity(s, d("2026-03-06")).stats;
  assert.equal(reset.streak, 1);
  assert.equal(reset.longest, 3);
});

test("interleave avoids same-source neighbours when possible", () => {
  const items = ["a", "a", "a", "b", "b", "c"].map((source) => ({ card: { source } }));
  const out = interleave(items);
  assert.equal(out.length, 6);
  assert.deepEqual(out.slice(0, 3).map((x) => x.card.source).sort(), ["a", "b", "c"]);
});

test("pickCards puts overconfident cards first and mixed mode includes not-due cards", () => {
  const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const mk = (src: string, flag?: "overconfident") => ({ ...newCard("q" + src + flag, "a", src), due: future, flag });
  const topic: any = { dir: "/x", state: { cards: [mk("x"), mk("y"), mk("z", "overconfident")] } };
  assert.equal(pickCards([topic], 5, "due").length, 0);
  const mixed = pickCards([topic], 5, "mixed");
  assert.equal(mixed.length, 3);
  assert.equal(mixed[0].card.flag, "overconfident");
});

test("mistakes journal groups by lesson", () => {
  const md = mistakesMarkdown({ dir: "/x", state: { title: "T", mistakes: [{ date: "2026-01-01", lesson: "L1", kind: "overconfident", what: "w", correction: "c", inMyWords: "mine" }] } } as any);
  assert.match(md, /## L1/);
  assert.match(md, /Sure, but wrong/);
  assert.match(md, /In my words: \*mine\*/);
});

import * as p from "@clack/prompts";
import { askJson } from "../llm.js";
import { gradeLabel, gradePrompt, personaPrompt, type Persona } from "../prompts.js";
import { schedule, isDue, type Rating } from "../srs.js";
import { m, must, t, withSpinner } from "../ui.js";
import type { Card, Check, Grade, Profile, Topic } from "../types.js";
import { saveTopic } from "../store.js";

export function validateGrade(x: any): Grade {
  const score = Number(x.score);
  if (![0, 1, 2, 3].includes(score)) throw new Error("score must be 0-3");
  const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  return { score: score as Grade["score"], right: arr(x.right), missing: arr(x.missing), misconceptions: arr(x.misconceptions), feedback: String(x.feedback ?? ""), followUp: String(x.followUp ?? "") };
}

export interface CheckResult {
  missed: Check[];
  overconfident: Check[]; // wrong while "pretty sure" or "certain"
  correct: number;
  total: number;
}

/** Multiple-choice checks with a confidence rating, so confident mistakes are caught and flagged. */
export async function runChecks(checks: Check[]): Promise<CheckResult> {
  const res: CheckResult = { missed: [], overconfident: [], correct: 0, total: checks.length };
  let sure = 0;
  let sureRight = 0;
  for (const [i, c] of checks.entries()) {
    // Models over-favour option A: shuffle what's shown, keep `c` untouched for logging.
    const order = c.options.map((_, idx) => idx).sort(() => Math.random() - 0.5);
    const shown = must(
      await p.select<number>({
        message: `${t.accent(`Q${i + 1}/${checks.length}`)}  ${m(c.q)}`,
        options: order.map((orig, pos) => ({ value: pos, label: m(c.options[orig]) })),
      }),
    );
    const picked = order[shown];
    const confidence = must(
      await p.select<number>({
        message: "How sure are you?",
        options: [
          { value: 1, label: "Guessing" },
          { value: 2, label: "Not sure" },
          { value: 3, label: "Pretty sure" },
          { value: 4, label: "Certain" },
        ],
      }),
    );
    const right = picked === c.answer;
    if (confidence >= 3) {
      sure++;
      if (right) sureRight++;
    }
    if (right) {
      res.correct++;
      p.log.success(t.ok("Correct. ") + t.dim(m(c.explain)));
    } else {
      res.missed.push(c);
      if (confidence >= 3) {
        res.overconfident.push(c);
        p.log.error(t.bad("Wrong — and you were sure. ") + t.warn("Those are the most valuable mistakes to catch.") + `\n  Answer: ${m(c.options[c.answer])}\n  ${t.dim(m(c.explain))}`);
      } else p.log.error(t.bad("Not quite. ") + `Answer: ${m(c.options[c.answer])}\n  ${t.dim(m(c.explain))}`);
    }
  }
  if (sure > 0 && checks.length > 1) p.log.info(t.dim(`Calibration: right on ${sureRight} of ${sure} answers you were sure about.`));
  return res;
}

export function showGrade(g: Grade) {
  const color = g.score >= 3 ? t.ok : g.score === 2 ? t.cyan : g.score === 1 ? t.warn : t.bad;
  const lines = [
    `${color(`${"●".repeat(g.score)}${"○".repeat(3 - g.score)} ${gradeLabel(g)}`)}`,
    "",
    m(g.feedback),
    ...g.right.map((r) => `${t.ok("✓")} ${m(r)}`),
    ...g.missing.map((r) => `${t.warn("△")} missing: ${m(r)}`),
    ...g.misconceptions.map((r) => `${t.bad("✗")} ${m(r)}`),
  ];
  p.note(lines.join("\n"), "Feedback");
}

/**
 * Feynman-style teach-back. With a persona, you explain to a character who then asks a follow-up
 * question about your biggest gap; the whole exchange is graded. Without, you get one graded retry.
 */
export async function teachBack(profile: Profile, title: string, prompt: string, keyPoints: string[], persona?: Persona): Promise<{ answer: string; grade: Grade }[]> {
  if (persona) {
    const first = must(
      await p.text({ message: `${t.pink("Explain it to " + persona.label)} — ${m(prompt)}`, placeholder: "in your own words (enter to submit, blank to skip)" }),
    ).trim();
    if (!first) return [];
    let transcript = first;
    try {
      const turn = await withSpinner(`${persona.label[0].toUpperCase() + persona.label.slice(1)} is thinking...`, () =>
        askJson(profile, personaPrompt(profile, persona, title, keyPoints, first), (x) => ({ reaction: String(x.reaction ?? ""), question: String(x.question ?? "") })),
      );
      p.log.message(`${t.pink(persona.label)}: ${m(turn.reaction)}\n${t.bold(m(turn.question))}`);
      const second = must(await p.text({ message: "Your reply", placeholder: "answer their question (blank to skip)" })).trim();
      if (second) transcript += `\n\n[Follow-up: ${turn.question}]\n${second}`;
    } catch {
      /* persona is a bonus; fall through to grading the first answer */
    }
    const grade = await withSpinner("Reading your explanation...", () => askJson(profile, gradePrompt(profile, title, prompt, keyPoints, transcript), validateGrade));
    showGrade(grade);
    return [{ answer: transcript, grade }];
  }

  const attempts: { answer: string; grade: Grade }[] = [];
  let ask = prompt;
  for (let i = 0; i < 2; i++) {
    const answer = must(
      await p.text({
        message: `${t.pink("In your own words")} — ${m(ask)}`,
        placeholder: "type your explanation (enter to submit, leave blank to skip)",
      }),
    ).trim();
    if (!answer) break;
    const grade = await withSpinner("Reading your explanation...", () => askJson(profile, gradePrompt(profile, title, prompt, keyPoints, answer), validateGrade));
    attempts.push({ answer, grade });
    showGrade(grade);
    if (grade.score >= 2 || i === 1) break;
    const again = must(
      await p.select({
        message: "Want another try with the feedback in mind? (struggling first is how it sticks)",
        options: [
          { value: true, label: "Try again" },
          { value: false, label: "Move on" },
        ],
      }),
    );
    if (!again) break;
    ask = grade.followUp || prompt;
  }
  return attempts;
}

type Entry = { tp: Topic; card: Card };

/** Round-robin across sources so related cards aren't back-to-back (interleaving). Stable per source order. */
export function interleave<T extends { card: { source: string } }>(items: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const it of items) groups.set(it.card.source, [...(groups.get(it.card.source) ?? []), it]);
  const queues = [...groups.values()].sort(() => Math.random() - 0.5);
  const out: T[] = [];
  while (queues.some((q) => q.length)) for (const q of queues) if (q.length) out.push(q.shift()!);
  return out;
}

/** Weak spots first: confident mistakes, lapses, then overdue. */
const weakness = (c: Card) => (c.flag === "overconfident" ? 4 : 0) + c.lapses * 1.5 + (isDue(c) ? 2 : 0) + Math.random();

export function pickCards(topics: Topic[], limit: number, mode: "due" | "mixed"): Entry[] {
  const all: Entry[] = topics.flatMap((tp) => tp.state.cards.map((card) => ({ tp, card })));
  const pool = mode === "due" ? all.filter((e) => isDue(e.card)) : all;
  const flagged = pool.filter((e) => e.card.flag === "overconfident").sort(() => Math.random() - 0.5);
  const rest = pool.filter((e) => e.card.flag !== "overconfident").sort((a, b) => weakness(b.card) - weakness(a.card));
  const chosen = [...flagged, ...rest].slice(0, limit);
  return [...chosen.filter((e) => e.card.flag === "overconfident"), ...interleave(chosen.filter((e) => e.card.flag !== "overconfident"))];
}

/** Spaced-repetition review (due cards) or an interleaved mixed quiz (any cards, weakest first). */
export async function reviewCards(topics: Topic[], limit = 20, mode: "due" | "mixed" = "due"): Promise<number> {
  const queue = pickCards(topics, limit, mode);
  let n = 0;
  for (const { tp, card } of queue) {
    console.log(t.dim(`\n  ${tp.state.title} · ${card.source}${card.flag ? " · " + t.warn("you were sure and wrong here before") : ""}`));
    must(await p.text({ message: `${t.accent("Recall")}  ${m(card.front)}`, placeholder: "type what you remember (enter to just think)" }));
    p.log.info(`${t.bold("Answer:")} ${m(card.back)}`);
    const rating = must(
      await p.select<Rating | "stop">({
        message: "How did that go?",
        options: [
          { value: "again", label: t.bad("Again"), hint: "forgot — see it in 10 min" },
          { value: "hard", label: t.warn("Hard"), hint: "got it with effort" },
          { value: "good", label: t.ok("Good") },
          { value: "easy", label: t.cyan("Easy"), hint: "push it further out" },
          { value: "stop", label: "Stop for now" },
        ],
      }),
    );
    if (rating === "stop") break;
    const idx = tp.state.cards.findIndex((c) => c.id === card.id);
    const next = schedule(card, rating);
    if (card.flag && (rating === "good" || rating === "easy")) delete next.flag; // earned its way out
    tp.state.cards[idx] = next;
    await saveTopic(tp);
    n++;
  }
  return n;
}

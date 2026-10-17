import * as p from "@clack/prompts";
import { askJson } from "../llm.js";
import { LENSES, challengePrompt, critiquePrompt, deeperPrompt, diagnoseQuestionsPrompt, diagnoseResultPrompt } from "../prompts.js";
import { m, must, renderMd, t, withSpinner } from "../ui.js";
import { runChecks } from "./quiz.js";
import type { Area, Check, LessonContent, Mistake, Profile, TopicState } from "../types.js";

const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

interface Critique {
  strong: string[];
  blindSpots: string[];
  pushback: string;
  feedback: string;
}
const validateCritique = (x: any): Critique => ({ strong: arr(x.strong), blindSpots: arr(x.blindSpots), pushback: String(x.pushback ?? ""), feedback: String(x.feedback ?? "") });

function showCritique(c: Critique) {
  p.note(
    [m(c.feedback), "", ...c.strong.map((s) => `${t.ok("✓")} ${m(s)}`), ...c.blindSpots.map((s) => `${t.warn("△ overlooked:")} ${m(s)}`), ...(c.pushback ? ["", `${t.pink("Push back:")} ${m(c.pushback)}`] : [])].join("\n"),
    "Thinking check",
  );
}

export interface DeeperRound {
  lens: string;
  question: string;
  answer: string;
  feedback: string;
  blindSpots: string[];
}

/**
 * Trade-offs, failure modes, scale and second-order effects. Round one uses the lesson's own question;
 * further rounds rotate through different lenses so the learner practises seeing a topic from many sides.
 */
export async function thinkDeeper(profile: Profile, s: TopicState, title: string, seed?: LessonContent["deeper"], maxRounds = 3): Promise<DeeperRound[]> {
  const rounds: DeeperRound[] = [];
  let lensIdx = Math.floor(Math.random() * LENSES.length);
  let current: { lens: string; question: string; considerations: string[] } | undefined = seed ? { lens: "Think deeper", ...seed } : undefined;
  for (let r = 0; r < maxRounds; r++) {
    if (!current) {
      const lens = LENSES[lensIdx % LENSES.length];
      const q = await withSpinner(`Finding a new angle (${lens.label.toLowerCase()})...`, () =>
        askJson(profile, deeperPrompt(profile, s, title, lens, rounds.map((x) => x.question)), (x) => ({ question: String(x.question), considerations: arr(x.considerations) })),
      );
      current = { lens: lens.label, ...q };
    }
    p.log.step(t.bold(t.accent(`Think deeper · ${current.lens}`)));
    const answer = must(await p.text({ message: m(current.question), placeholder: "no single right answer: weigh both sides, name what could go wrong (blank to skip)" })).trim();
    if (!answer) break;
    const c = await withSpinner("Weighing your reasoning...", () => askJson(profile, critiquePrompt(profile, title, current!.question, current!.considerations, answer), validateCritique));
    showCritique(c);
    rounds.push({ lens: current.lens, question: current.question, answer, feedback: c.feedback, blindSpots: c.blindSpots });
    // Let them answer the pushback, which is the real second-order step.
    if (c.pushback) {
      const reply = must(await p.text({ message: `${t.pink("Your response to the push back?")}`, placeholder: "optional (blank to skip)" })).trim();
      if (reply) rounds[rounds.length - 1].answer += `\n\n[Push back: ${c.pushback}]\n${reply}`;
    }
    if (r === maxRounds - 1) break;
    lensIdx++;
    const next = LENSES[lensIdx % LENSES.length];
    const more = must(
      await p.select({
        message: "Keep stretching your thinking?",
        options: [
          { value: true, label: `Another angle: ${next.label}` },
          { value: false, label: "That's enough" },
        ],
      }),
    );
    if (!more) break;
    current = undefined;
  }
  return rounds;
}

/** End-of-area scenario with no single right answer: apply what you learned and weigh trade-offs. */
export async function applicationChallenge(profile: Profile, s: TopicState, area: Area, covered: string[]) {
  const ch = await withSpinner("Designing a real-world challenge...", () =>
    askJson(profile, challengePrompt(profile, s, area, covered), (x) => ({ scenario: String(x.scenario), task: String(x.task), considerations: arr(x.considerations) })),
  );
  p.note(`${m(ch.scenario)}\n\n${t.bold("Your task:")} ${m(ch.task)}`, `Challenge · ${area.title}`);
  const answer = must(await p.text({ message: "What would you do, and why? What could go wrong?", placeholder: "reason it through (blank to skip)" })).trim();
  if (!answer) return null;
  const c = await withSpinner("Reviewing your reasoning...", () => askJson(profile, critiquePrompt(profile, area.title, ch.task, ch.considerations, answer), validateCritique));
  showCritique(c);
  return { ...ch, answer, critique: c };
}

/**
 * When a learner keeps missing, find the mental model that's wrong instead of repeating the lesson.
 * Returns the logged mistake (with the learner's corrected idea in their own words).
 */
export async function diagnose(profile: Profile, title: string, missed: Check[], explanationFeedback: string): Promise<Omit<Mistake, "date"> | null> {
  const questions = await withSpinner("Working out where the confusion is...", () =>
    askJson(profile, diagnoseQuestionsPrompt(profile, title, missed.map((m) => m.q), explanationFeedback), (x) => arr(x.questions).slice(0, 2)),
  );
  const qa: { q: string; a: string }[] = [];
  for (const q of questions) {
    const a = must(await p.text({ message: `${t.pink("Quick question")} — ${m(q)}`, placeholder: "just say what you picture or believe (blank to skip)" })).trim();
    qa.push({ q, a });
  }
  const res = await withSpinner("Finding the misconception...", () =>
    askJson(
      profile,
      diagnoseResultPrompt(profile, title, qa, missed.map((m) => m.q)),
      (x) => {
        const rt = x.retest;
        if (!rt || !Array.isArray(rt.options) || !Number.isInteger(rt.answer) || rt.answer < 0 || rt.answer >= rt.options.length) throw new Error("bad retest");
        return {
          misconception: String(x.misconception),
          reteach: String(x.reteach),
          retest: { q: String(rt.q), options: rt.options.map(String), answer: rt.answer as number, explain: String(rt.explain ?? "") } as Check,
        };
      },
    ),
  );
  p.note(`${t.warn("Likely snag:")} ${m(res.misconception)}`, "Diagnosis");
  console.log(renderMd(res.reteach) + "\n");
  await runChecks([res.retest]);
  const inMyWords = must(await p.text({ message: `${t.pink("Say the corrected idea in your own words")}`, placeholder: "one or two sentences (blank to skip)" })).trim();
  return {
    lesson: title,
    kind: "diagnosis",
    what: res.misconception,
    correction: res.reteach.split("\n").find((l) => l.trim() && !l.startsWith("#") && !l.startsWith("`")) ?? res.misconception,
    inMyWords: inMyWords || undefined,
  };
}

/** Socratic opener: leading questions the learner works through before the explanation. */
export async function socraticWarmup(items: NonNullable<LessonContent["socratic"]>): Promise<{ q: string; answer: string }[]> {
  p.log.message(t.dim("Socratic mode: work toward the idea yourself first. Answers needn't be right."));
  const out: { q: string; answer: string }[] = [];
  for (const [i, item] of items.entries()) {
    let answer = must(await p.text({ message: `${t.pink(`${i + 1}/${items.length}`)}  ${m(item.q)}`, placeholder: "think out loud (type ? for a hint, blank to skip)" })).trim();
    if (answer === "?") {
      p.log.info(`${t.warn("Hint:")} ${m(item.hint)}`);
      answer = must(await p.text({ message: item.q, placeholder: "try again with the hint (blank to skip)" })).trim();
    }
    p.log.message(`${t.accent("→")} ${m(item.idea)}`);
    out.push({ q: item.q, answer });
  }
  return out;
}

/** Predict-then-reveal: a wrong guess followed by the truth is memorable. */
export async function predictThenReveal(pred: NonNullable<LessonContent["prediction"]>): Promise<string> {
  p.note(m(pred.scenario), t.pink("Predict"));
  const guess = must(await p.text({ message: m(pred.question), placeholder: "commit to a guess before the reveal (blank to skip)" })).trim();
  p.log.message(`${t.accent("Reveal:")} ${m(pred.outcome)}`);
  return guess;
}

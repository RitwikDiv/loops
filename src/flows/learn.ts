import * as p from "@clack/prompts";
import { join } from "node:path";
import { askJson, askText } from "../llm.js";
import { PERSONAS } from "../prompts.js";
import { bigPicturePrompt, deepLessonPrompt, mapPrompt, outlinePrompt, reexplainPrompt, surveyLessonPrompt } from "../prompts.js";
import { clean, lessonMarkdown, materializeFigures, type LessonExtras, mapMarkdown, mistakesMarkdown, nodeId, writeIndex } from "../markdown.js";
import { renderDiagram } from "../diagram.js";
import { addMistake, createTopic, listCategories, saveTopic, slugify, writeText } from "../store.js";
import { recordActivity } from "../stats.js";
import { addCards, isDue } from "../srs.js";
import { bar, m, must, readLesson, t, withSpinner } from "../ui.js";
import { reviewCards, runChecks, teachBack } from "./quiz.js";
import { applicationChallenge, diagnose, predictThenReveal, socraticWarmup, thinkDeeper, type DeeperRound } from "./think.js";
import type { Area, Check, LessonContent, LessonRef, MapData, Profile, Topic } from "../types.js";

const str = (v: unknown, name: string) => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`missing string "${name}"`);
  return v;
};

function validateMap(x: any): MapData {
  if (!Array.isArray(x.areas) || x.areas.length < 3) throw new Error("need at least 3 areas");
  const areas: Area[] = x.areas.map((a: any, i: number) => ({
    id: slugify(a.id ?? a.title ?? `area-${i}`),
    title: str(a.title, "title"),
    summary: String(a.summary ?? ""),
    prereqs: Array.isArray(a.prereqs) ? a.prereqs.map((s: unknown) => slugify(String(s))) : [],
    concepts: (Array.isArray(a.concepts) ? a.concepts : []).map((c: any) => ({ name: str(c.name, "concept"), blurb: String(c.blurb ?? "") })),
  }));
  return { overview: String(x.overview ?? ""), areas };
}

export function validateLesson(x: any): LessonContent {
  const checks: Check[] = (Array.isArray(x.checks) ? x.checks : []).map((c: any) => {
    if (!Array.isArray(c.options) || c.options.length < 2 || !Number.isInteger(c.answer) || c.answer < 0 || c.answer >= c.options.length) throw new Error("bad check options/answer");
    return { q: str(c.q, "q"), options: c.options.map(String), answer: c.answer, explain: String(c.explain ?? "") };
  });
  return {
    primer: String(x.primer ?? ""),
    markdown: str(x.markdown, "markdown"),
    checks,
    teachBack: str(x.teachBack, "teachBack"),
    keyPoints: (Array.isArray(x.keyPoints) ? x.keyPoints : []).map(String),
    cards: (Array.isArray(x.cards) ? x.cards : []).filter((c: any) => c?.front && c?.back).map((c: any) => ({ front: String(c.front), back: String(c.back) })),
    prediction: x.prediction?.scenario && x.prediction?.question && x.prediction?.outcome ? { scenario: String(x.prediction.scenario), question: String(x.prediction.question), outcome: String(x.prediction.outcome) } : undefined,
    deeper: x.deeper?.question ? { question: String(x.deeper.question), considerations: (Array.isArray(x.deeper.considerations) ? x.deeper.considerations : []).map(String) } : undefined,
    socratic: Array.isArray(x.socratic) ? x.socratic.filter((q: any) => q?.q).map((q: any) => ({ q: String(q.q), hint: String(q.hint ?? ""), idea: String(q.idea ?? "") })) : undefined,
  };
}

const validateOutline = (x: any): LessonRef[] => {
  if (!Array.isArray(x.lessons) || !x.lessons.length) throw new Error("no lessons");
  return x.lessons.map((l: any, i: number) => ({ id: slugify(l.id ?? l.title ?? `l${i}`), title: str(l.title, "title"), objective: String(l.objective ?? "") }));
};

export async function newTopic(profile: Profile, title?: string): Promise<Topic | null> {
  p.intro(t.bold(t.accent(" New topic ")));
  const name = title ?? must(await p.text({ message: "What do you want to learn?", placeholder: "e.g. How databases work, Music theory, Game theory", validate: (v) => (v?.trim() ? undefined : "Tell me something!") }));

  const cats = await listCategories(profile);
  let category = "general";
  const choice = must(
    await p.select<string>({
      message: "Which folder should this live in?",
      options: [...cats.map((c) => ({ value: c, label: c })), { value: "__new", label: t.accent("+ New folder") }],
    }),
  );
  category = choice === "__new" ? must(await p.text({ message: "Folder name", placeholder: "e.g. programming, science, languages", validate: (v) => (v?.trim() ? undefined : "Required") })) : choice;

  const prior = must(
    await p.text({
      message: `Brain dump: what do you already know (or think you know) about ${name}?`,
      placeholder: "anything — even guesses. Blank if nothing. This sets the starting point.",
    }),
  );

  const useCase = must(
    await p.text({
      message: `Where do you hope to use ${name}? (a project, a job, a problem you have)`,
      placeholder: "optional — examples will be drawn from this",
    }),
  );

  const topic = await createTopic(profile, name.trim(), category, prior.trim());
  topic.state.useCase = useCase.trim() || undefined;
  await buildMap(profile, topic);
  return topic;
}

async function buildMap(profile: Profile, topic: Topic) {
  topic.state.map = await withSpinner("Mapping the territory...", () => askJson(profile, mapPrompt(profile, topic.state.title, topic.state.priorKnowledge), validateMap));
  topic.state.phase = "survey";
  for (const a of topic.state.map.areas) topic.state.progress[a.id] ??= { surveyed: false, done: [] };
  await writeText(join(topic.dir, "map.md"), mapMarkdown(topic));
  await writeIndex(topic);
  await saveTopic(topic);
  printMap(topic);
}

export function printMap(topic: Topic) {
  const map = topic.state.map!;
  const lines = [t.italic(map.overview), ""];
  map.areas.forEach((a, i) => {
    const last = i === map.areas.length - 1;
    lines.push(`${t.accent(last ? "└─" : "├─")} ${t.bold(a.title)}  ${t.dim(a.summary)}`);
    a.concepts.forEach((c, j) => lines.push(`${t.dim(last ? "   " : "│  ")} ${t.dim(j === a.concepts.length - 1 ? "└─" : "├─")} ${c.name}`));
  });
  p.note(lines.join("\n"), `${topic.state.title} — the map`);
  const edges = map.areas.flatMap((a) => a.prereqs.filter((q) => map.areas.some((x) => x.id === q)).map((q) => `  ${nodeId(q)} --> ${nodeId(a.id)}`));
  if (edges.length) {
    const flow = ["flowchart LR", ...map.areas.map((a) => `  ${nodeId(a.id)}["${clean(a.title)}"]`), ...edges].join("\n");
    const art = renderDiagram(flow);
    if (art) p.note(art, "Suggested order (arrow = learn first)");
  }
  p.log.info(t.dim(`Saved with mermaid diagrams: ${join(topic.dir, "map.md")}`));
}

/** Warm-up retrieval of older material before new learning (spacing + interleaving). */
async function warmUp(topic: Topic) {
  const due = topic.state.cards.filter((c) => isDue(c)).length;
  if (!due) return;
  const go = must(
    await p.select({
      message: `${due} card${due > 1 ? "s are" : " is"} due. Start with a quick warm-up? (recalling old stuff first makes new stuff stick)`,
      options: [
        { value: true, label: "Warm up (5 cards)" },
        { value: false, label: "Skip" },
      ],
    }),
  );
  if (go) await reviewCards([topic], 5, "due");
}

interface LessonCtx {
  profile: Profile;
  topic: Topic;
  title: string;
  file: string;
  deep: boolean;
  load: () => Promise<LessonContent>;
}

async function teach(ctx: LessonCtx): Promise<void> {
  const { profile, topic } = ctx;
  const lesson = await withSpinner(`Preparing "${ctx.title}"...`, ctx.load);
  p.log.step(t.bold(t.accent(ctx.title)));
  const extras: LessonExtras = {};

  // 0. Socratic mode: work toward the idea through leading questions first.
  const socratic = ctx.deep && profile.socratic && lesson.socratic?.length ? lesson.socratic : undefined;
  if (socratic) extras.socratic = await socraticWarmup(socratic);

  // 1. Pretest: guessing before reading primes attention even when wrong.
  if (lesson.primer && !socratic) {
    must(await p.text({ message: `${t.pink("Guess first")} — ${m(lesson.primer)}`, placeholder: "a rough guess is fine (enter to skip)" }));
  }
  // 2. The chunk, with an escape hatch.
  if (socratic) p.log.message(t.dim("Here's how the pieces fit together:"));
  await readLesson(lesson.markdown);
  while (true) {
    const next = must(
      await p.select<"go" | "again">({
        message: "Does it make sense?",
        options: [
          { value: "go", label: "Yes — continue" },
          { value: "again", label: "Not really — explain it differently" },
        ],
      }),
    );
    if (next === "go") break;
    const alt = await withSpinner("Finding another angle...", () => askText(profile, reexplainPrompt(profile, topic.state.title, ctx.title, lesson.markdown)));
    await readLesson(alt);
    lesson.markdown += `\n\n---\n\n### Another angle\n\n${alt}`;
  }

  // 3. Predict-then-reveal.
  if (ctx.deep && lesson.prediction) extras.prediction = await predictThenReveal(lesson.prediction);

  // 4. Retrieval practice with confidence.
  const result = await runChecks(lesson.checks);
  extras.missed = result.missed.map((m) => m.q);
  for (const m of result.missed) {
    const over = result.overconfident.includes(m);
    addMistake(topic, { lesson: ctx.title, kind: over ? "overconfident" : "quiz", what: m.q, correction: `${m.options[m.answer]} — ${m.explain}` });
  }

  // 5. Teach-back, to a persona on deep lessons.
  const persona = ctx.deep ? PERSONAS[Math.floor(Math.random() * PERSONAS.length)] : undefined;
  extras.attempts = await teachBack(profile, ctx.title, lesson.teachBack, lesson.keyPoints, persona);
  const last = extras.attempts.at(-1)?.grade;
  if (last && last.score <= 1) {
    for (const g of last.misconceptions.length ? last.misconceptions : last.missing.slice(0, 2)) {
      addMistake(topic, { lesson: ctx.title, kind: "explanation", what: g, correction: last.feedback });
    }
  }

  // 6. Stuck? Diagnose the mental model instead of repeating the lesson.
  if (result.missed.length >= 2 || (last && last.score <= 1)) {
    const go = must(
      await p.select({
        message: "This one's tripping you up. Want me to find out why?",
        options: [
          { value: true, label: "Yes — diagnose it", hint: "2 quick questions" },
          { value: false, label: "Skip" },
        ],
      }),
    );
    if (go) {
      const m = await diagnose(profile, ctx.title, result.missed, last?.feedback ?? "");
      if (m) addMistake(topic, m);
    }
  }

  // 7. Think deeper: trade-offs, failure modes, second-order effects.
  if (ctx.deep) {
    if (lesson.deeper) {
      const rounds: DeeperRound[] = await thinkDeeper(profile, topic.state, ctx.title, lesson.deeper);
      if (rounds.length) extras.deeper = rounds;
    }
    // 8. Personal connection.
    const conn = must(await p.text({ message: `${t.pink("Where could you use this?")}`, placeholder: "a project, a decision, something you've seen (blank to skip)" })).trim();
    if (conn) {
      extras.connection = conn;
      topic.state.connections = [...(topic.state.connections ?? []), conn].slice(-20);
    }
  }

  // Cards: lesson cards plus everything missed; confident mistakes are flagged to resurface first.
  const cards = [...lesson.cards, ...result.missed.map((m) => ({ front: m.q, back: `${m.options[m.answer]} — ${m.explain}` }))];
  const added = addCards(topic.state.cards, cards, ctx.title);
  for (const m of result.overconfident) {
    const c = topic.state.cards.find((x) => x.front.trim().toLowerCase() === m.q.trim().toLowerCase());
    if (c) c.flag = "overconfident";
  }
  await writeText(join(topic.dir, ctx.file), await materializeFigures(lessonMarkdown(ctx.title, lesson, extras), topic.dir, ctx.file));
  await writeText(join(topic.dir, "mistakes.md"), mistakesMarkdown(topic));
  p.log.success(`${added} flashcard${added === 1 ? "" : "s"} added to your review queue ${t.dim("→ " + ctx.file)}`);

  const streak = await recordActivity();
  if (streak.message) p.log.success(t.warn("🔥 ") + t.bold(streak.message));
}

const overTime = (start: number, profile: Profile) => (Date.now() - start) / 60_000 >= profile.minutesPerSession;

export async function continueTopic(profile: Profile, topic: Topic): Promise<void> {
  const s = topic.state;
  const started = Date.now();
  if (!s.map) await buildMap(profile, topic);
  await warmUp(topic);

  // Survey phase: breadth first.
  const areas = s.map!.areas;
  while (s.phase === "survey") {
    const next = areas.find((a) => !s.progress[a.id].surveyed);
    if (!next) {
      if (!s.bigPictureDone) {
        const bp = bigPicturePrompt(s);
        p.log.step(t.bold(t.accent("Survey complete — zoom out")));
        const attempts = await teachBack(profile, `${s.title}: big picture`, bp.prompt, bp.keyPoints);
        s.bigPictureDone = true;
        if (attempts.length) await writeText(join(topic.dir, "survey", "big-picture.md"), `# Big picture\n\n> ${bp.prompt}\n\n${attempts.map((a) => `${a.answer}\n\n*${a.grade.feedback}*`).join("\n\n")}\n`);
      }
      s.phase = "deep";
      await saveTopic(topic);
      break;
    }
    const idx = areas.indexOf(next);
    console.log(`\n  ${t.dim("Survey")} ${bar(areas.filter((a) => s.progress[a.id].surveyed).length, areas.length)}`);
    await teach({
      profile,
      topic,
      title: next.title,
      deep: false,
      file: `survey/${next.id}.md`,
      load: () => askJson(profile, surveyLessonPrompt(profile, s, next), validateLesson),
    });
    s.progress[next.id].surveyed = true;
    await writeIndex(topic);
    await saveTopic(topic);
    if (idx < areas.length - 1 && !(await keepGoing(profile, started))) return;
  }

  // Deep phase: pick where to go deep.
  while (true) {
    const area = await pickArea(topic);
    if (!area) return;
    const pr = s.progress[area.id];
    if (pr.outline && pr.done.length >= pr.outline.length) {
      p.log.info(t.dim(`${area.title} is already complete — pick another.`));
      continue;
    }
    if (!pr.outline) {
      pr.outline = await withSpinner(`Planning your deep dive into ${area.title}...`, () => askJson(profile, outlinePrompt(profile, s, area), validateOutline));
      await saveTopic(topic);
    }
    for (const [i, l] of pr.outline.entries()) {
      if (pr.done.includes(l.id)) continue;
      console.log(`\n  ${t.dim(area.title)} ${bar(pr.done.length, pr.outline.length)}`);
      p.log.message(t.dim(`Goal: ${l.objective}`));
      const doneTitles = pr.outline.filter((x) => pr.done.includes(x.id)).map((x) => x.title);
      await teach({
        profile,
        topic,
        title: l.title,
        deep: true,
        file: `deep/${area.id}/${String(i + 1).padStart(2, "0")}-${l.id}.md`,
        load: () => askJson(profile, deepLessonPrompt(profile, s, area, l, doneTitles), validateLesson),
      });
      pr.done.push(l.id);
      await writeIndex(topic);
      await saveTopic(topic);
      if (pr.done.length < pr.outline.length && !(await keepGoing(profile, started))) return;
    }
    p.log.success(t.ok(`You finished the deep dive on ${area.title}. 🎉`));
    const take = must(
      await p.select({
        message: "Test it on a real-world scenario with trade-offs?",
        options: [
          { value: true, label: "Yes — application challenge" },
          { value: false, label: "Skip" },
        ],
      }),
    );
    if (take) {
      const res = await applicationChallenge(profile, s, area, pr.outline.map((l) => l.title));
      if (res) {
        await writeText(
          join(topic.dir, "deep", area.id, "challenge.md"),
          `# Challenge — ${area.title}\n\n${res.scenario}\n\n**Task:** ${res.task}\n\n## My answer\n\n${res.answer.split("\n").map((l) => "> " + l).join("\n")}\n\n## Feedback\n\n${res.critique.feedback}\n\n${res.critique.blindSpots.map((b) => `- Overlooked: ${b}`).join("\n")}\n`,
        );
        const r = await recordActivity();
        if (r.message) p.log.success(t.warn("🔥 ") + t.bold(r.message));
      }
    }
    const more = must(await p.select({ message: "Next?", options: [{ value: true, label: "Pick another area to go deep on" }, { value: false, label: "Stop here" }] }));
    if (!more) return;
  }
}

async function keepGoing(profile: Profile, started: number): Promise<boolean> {
  const over = overTime(started, profile);
  const mins = Math.round((Date.now() - started) / 60_000);
  return must(
    await p.select({
      message: over ? `${t.warn(`${mins} min in`)} — a good place to stop. Spacing sessions beats cramming.` : "Continue?",
      initialValue: !over,
      options: [
        { value: true, label: "Keep going" },
        { value: false, label: "Stop here (progress is saved)" },
      ],
    }),
  );
}

async function pickArea(topic: Topic): Promise<Area | null> {
  const s = topic.state;
  const areas = s.map!.areas;
  const open = areas.filter((a) => (s.progress[a.id].outline?.length ?? 1) > s.progress[a.id].done.length);
  if (!open.length) {
    p.log.success("You've gone deep on every area. Review your cards to keep it fresh with `loops review`.");
    return null;
  }
  const started = open.find((a) => s.progress[a.id].done.length > 0) ?? open[0];
  const choice = must(
    await p.select<string>({
      message: "Which area do you want to go deep on?",
      initialValue: started?.id,
      options: areas.map((a) => {
        const pr = s.progress[a.id];
        const total = pr.outline?.length;
        const finished = total !== undefined && pr.done.length >= total;
        return {
          value: a.id,
          label: `${finished ? t.ok("✓ ") : ""}${a.title}`,
          hint: finished ? "done" : total ? `${pr.done.length}/${total} lessons` : a.prereqs.length ? `after: ${a.prereqs.join(", ")}` : a.summary.slice(0, 50),
        };
      }),
    }),
  );
  return areas.find((a) => a.id === choice)!;
}

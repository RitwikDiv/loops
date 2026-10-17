import { dirname, join, relative } from "node:path";
import { writeText } from "./store.js";
import { parsePlot, plotToSvg, sanitizeSvg, svgCaption } from "./figures.js";
import type { Area, Grade, LessonContent, Topic } from "./types.js";
import type { DeeperRound } from "./flows/think.js";

/** Strip characters that break mermaid mindmap / quoted labels. */
export const clean = (s: string) => s.replace(/["'`()\[\]{}:;#<>]/g, "").replace(/\s+/g, " ").trim();
export const nodeId = (s: string) => "n_" + s.replace(/[^a-zA-Z0-9]/g, "_");

export function mapMarkdown(topic: Topic): string {
  const { title, map } = topic.state;
  if (!map) return "";
  const mind = [
    "```mermaid",
    "mindmap",
    `  root((${clean(title)}))`,
    ...map.areas.flatMap((a) => [`    ${clean(a.title)}`, ...a.concepts.map((c) => `      ${clean(c.name)}`)]),
    "```",
  ].join("\n");
  const edges = map.areas.flatMap((a) => a.prereqs.filter((p) => map.areas.some((x) => x.id === p)).map((p) => `  ${nodeId(p)} --> ${nodeId(a.id)}`));
  const flow = [
    "```mermaid",
    "flowchart LR",
    ...map.areas.map((a) => `  ${nodeId(a.id)}["${clean(a.title)}"]`),
    ...edges,
    "```",
  ].join("\n");
  return `# ${title} — map

${map.overview}

## The territory

${mind}

## Suggested order

Arrows mean "understand this first".

${flow}

## Areas

${map.areas.map((a) => `### ${a.title}\n${a.summary}\n\n${a.concepts.map((c) => `- **${c.name}** — ${c.blurb}`).join("\n")}`).join("\n\n")}
`;
}

export interface LessonExtras {
  attempts?: { answer: string; grade: Grade }[];
  missed?: string[];
  prediction?: string;
  socratic?: { q: string; answer: string }[];
  deeper?: DeeperRound[];
  connection?: string;
}

export function lessonMarkdown(title: string, lesson: LessonContent, x: LessonExtras = {}): string {
  const quote = (s: string) => s.split("\n").map((l) => "> " + l).join("\n");
  const checks = lesson.checks
    .map((c, i) => `${i + 1}. ${c.q}\n${c.options.map((o, j) => `   - ${j === c.answer ? "✅" : "▫️"} ${o}`).join("\n")}\n   - *${c.explain}*`)
    .join("\n");
  const section = (heading: string, body: string) => (body.trim() ? `\n## ${heading}\n\n${body}\n` : "");
  const socratic = x.socratic?.length ? section("Questions I worked through first", x.socratic.map((s) => `**${s.q}**\n\n${quote(s.answer || "(skipped)")}`).join("\n\n")) : "";
  const prediction = lesson.prediction ? section("Predict, then reveal", `**${lesson.prediction.scenario}**\n\n${lesson.prediction.question}\n\n${quote(x.prediction || "(skipped)")}\n\n**What happened:** ${lesson.prediction.outcome}`) : "";
  const own = x.attempts?.length
    ? section(
        "In my own words",
        `> ${lesson.teachBack}\n\n` +
          x.attempts.map((o, i) => `**Attempt ${i + 1}** — ${o.grade.score}/3\n\n${quote(o.answer)}\n\n${o.grade.feedback}${o.grade.missing.length ? `\n\nMissing: ${o.grade.missing.join("; ")}` : ""}`).join("\n\n"),
      )
    : "";
  const deeper = x.deeper?.length
    ? section(
        "Thinking deeper",
        x.deeper.map((d) => `**${d.lens}: ${d.question}**\n\n${quote(d.answer)}\n\n${d.feedback}${d.blindSpots.length ? `\n\nBlind spots to revisit:\n${d.blindSpots.map((b) => `- ${b}`).join("\n")}` : ""}`).join("\n\n---\n\n"),
      )
    : "";
  const connection = x.connection ? section("Where I could use this", quote(x.connection)) : "";
  return `# ${title}

${lesson.markdown}
${socratic}${prediction}
## Key points

${lesson.keyPoints.map((k) => `- ${k}`).join("\n")}

## Check yourself

${checks}
${x.missed?.length ? `\n**Still shaky:** ${x.missed.join("; ")}\n` : ""}${own}${deeper}${connection}
## Flashcards

${lesson.cards.map((c) => `- **${c.front}** → ${c.back}`).join("\n")}
`;
}

export function mistakesMarkdown(topic: Topic): string {
  const list = topic.state.mistakes ?? [];
  const kind = { quiz: "Missed a question", overconfident: "Sure, but wrong", explanation: "Gap in my explanation", diagnosis: "Misconception" } as const;
  const byLesson = new Map<string, typeof list>();
  for (const m of list) byLesson.set(m.lesson, [...(byLesson.get(m.lesson) ?? []), m]);
  const body = [...byLesson.entries()]
    .map(([lesson, ms]) => `## ${lesson}\n\n${ms.map((m) => `- **${kind[m.kind]}** (${m.date}): ${m.what}\n  - Correct idea: ${m.correction}${m.inMyWords ? `\n  - In my words: *${m.inMyWords}*` : ""}`).join("\n")}`)
    .join("\n\n");
  return `# Mistake journal — ${topic.state.title}\n\nThe fastest way to improve is to understand exactly what you got wrong.\n\n${body || "_Nothing yet._"}\n`;
}

export async function writeIndex(topic: Topic) {
  const { state } = topic;
  const lines: string[] = [`# ${state.title}`, "", state.map?.overview ?? "", "", "- [Map of the territory](map.md)", ...(state.mistakes?.length ? ["- [Mistake journal](mistakes.md)"] : []), ""];
  if (state.map) {
    lines.push("## Progress", "");
    for (const a of state.map.areas as Area[]) {
      const pr = state.progress[a.id];
      const done = pr?.done.length ?? 0;
      const total = pr?.outline?.length ?? 0;
      const surveyed = pr?.surveyed ? "✅" : "⬜";
      lines.push(`- ${surveyed} **${a.title}** — survey: [overview](survey/${a.id}.md)${total ? ` · deep dive ${done}/${total}: ${(pr!.outline ?? []).map((l, i) => (pr!.done.includes(l.id) ? `[${l.title}](deep/${a.id}/${String(i + 1).padStart(2, "0")}-${l.id}.md)` : l.title)).join(", ")}` : ""}`);
    }
  }
  lines.push("", `_${state.cards.length} flashcards tracked in topic.json_`, "");
  await writeText(join(topic.dir, "README.md"), lines.join("\n"));
}

/**
 * Lessons embed ```svg and ```plot blocks. In the saved markdown they become real .svg files under
 * figures/ and standard image links, which GitHub, VS Code and Obsidian all display. Equations stay as
 * $$ TeX $$ (rendered by those viewers); mermaid stays fenced.
 */
export async function materializeFigures(md: string, topicDir: string, lessonFile: string): Promise<string> {
  const base = lessonFile.replace(/\.md$/, "").replace(/[^a-z0-9]+/gi, "-");
  const jobs: { token: string; file: string; svg: string; caption: string }[] = [];
  let n = 0;
  const out = md.replace(/```(svg|plot)\n([\s\S]*?)```/g, (_, kind: string, src: string) => {
    let svg: string | null = null;
    let caption = "";
    if (kind === "svg") {
      svg = sanitizeSvg(src);
      caption = svg ? svgCaption(svg) : "";
    } else {
      const spec = parsePlot(src);
      svg = spec && plotToSvg(spec);
      caption = spec?.title ?? "";
    }
    if (!svg) return "> *(a figure here could not be rendered)*";
    const file = `figures/${base}-${++n}.svg`;
    jobs.push({ token: file, file, svg, caption });
    const rel = relative(dirname(join(topicDir, lessonFile)), join(topicDir, file));
    return `![${caption || "Figure " + n}](${rel})`;
  });
  for (const j of jobs) await writeText(join(topicDir, j.file), j.svg);
  return out;
}

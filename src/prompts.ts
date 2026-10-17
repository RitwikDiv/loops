import type { Area, Profile, TopicState, LessonRef, Grade } from "./types.js";

export function learnerBlurb(p: Profile): string {
  return [
    `Learner: ${p.name}. Goal: ${p.goal}. Level: ${p.level}.`,
    `Likes: ${p.styles.join(", ") || "no strong preference"}. Prefers ${p.order.replace(/-/g, " ")} ordering.`,
    `Diagram appetite: ${p.diagrams}. Challenge: ${p.challenge}. Feedback tone: ${p.tone}.`,
    p.context ? `They are working on / will use this for: ${p.context}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Topic-specific personalisation: where they said they'd use it, and their own connections so far. */
export function useBlurb(s: TopicState): string {
  const bits = [s.useCase ? `For this topic they want to use it for: ${s.useCase}.` : "", s.connections?.length ? `Uses they have named so far: ${s.connections.slice(-3).join(" | ")}. Draw examples from these when natural.` : ""];
  return bits.filter(Boolean).join(" ");
}

const MERMAID_RULES = `Mermaid rules (diagrams MUST render): use only flowchart TD/LR, sequenceDiagram, stateDiagram-v2, classDiagram, or mindmap.
Always wrap flowchart node labels in double quotes, e.g. A["Label text"]. Never put parentheses, quotes or colons inside unquoted labels. Diagrams are drawn in a terminal about 100 columns wide: prefer flowchart/sequenceDiagram/stateDiagram-v2/classDiagram, keep labels to 1-4 words, and keep diagrams under 10 nodes. Fence them as \`\`\`mermaid.`;

const STEM_RULES = `Math and science content:
- Write equations in LaTeX: $...$ inline and $$...$$ for display. The physics, ams, mhchem and cancel packages work (\\ket{}, \\pdv{f}{x}, \\vb{E}, \\ce{2H2 + O2 -> 2H2O}). Inside the JSON, double every backslash (write \\\\frac).
- Physical or geometric setups (free-body diagrams, circuits, ray/optics diagrams, fields, waves, geometry) go in a fenced svg block holding one complete <svg viewBox='0 0 640 360'>. Use SINGLE quotes for every attribute, include a <title>, dark strokes on a transparent background, labelled parts via <text>, arrowheads via <marker>, and no scripts, images or external references. Keep it uncluttered and physically correct.
- Graphs of functions (waveforms, potentials, distributions, trade-off curves) go in a fenced plot block holding JSON: {"title":"...","xlabel":"...","ylabel":"...","xmin":0,"xmax":10,"series":[{"label":"...","expr":"exp(-0.3*x)*cos(3*x)"}]}. The expr is a mathjs expression in x (use *, ^, sin, cos, exp, sqrt, pi), never LaTeX.
- Use mermaid only for processes, hierarchies and state/flow structure. Add equations or figures only where they genuinely clarify; never decorate.`;

const QUESTION_RULES = `Question precision (every question you write, including multiple-choice checks, flashcard fronts, predictions and follow-ups):
- Each question must have exactly one defensible reading. Name the specific thing being asked about; never use bare "it", "this" or "the system" without a clear referent, and never lean on context the learner cannot see.
- State any assumptions, conditions or scope the answer depends on inside the question itself (e.g. "assuming a single thread", "in the ideal case").
- Ask for one thing at a time, and say what form the answer takes (which, why, how many, what happens next).
- For multiple-choice: exactly one option is correct, the others are clearly wrong on a strict reading, and no option is a matter of opinion or "it depends". Avoid "all/none of the above" and vague words like "usually", "best" or "better" unless the question defines the criterion.
- Open-ended questions may have many good answers, but the task must still be unambiguous about what to address.`;

const diagramRule = (p: Profile) =>
  p.diagrams === "lots" ? "Include 1-2 mermaid diagrams." : p.diagrams === "some" ? "Include one mermaid diagram if it genuinely helps." : "Only include a diagram if essential.";

export function mapPrompt(p: Profile, topic: string, prior: string): string {
  return `${learnerBlurb(p)}
Create a map of the whole territory of "${topic}" for this learner. Their stated prior knowledge: ${prior || "none stated"}.
Cover the field broadly: 5-9 areas, ordered so earlier areas support later ones. Each area has 3-6 concepts.
Return ONLY JSON:
{"overview":"2-3 sentence orientation: what this field is and why it matters",
 "areas":[{"id":"short-kebab-id","title":"...","summary":"1-2 sentences","prereqs":["ids of areas that should come first"],"concepts":[{"name":"...","blurb":"one line"}]}]}`;
}

const lessonShapeBase = `{"primer":"one open question that makes the learner GUESS before reading (no jargon they haven't seen)",
 "markdown":"the lesson body in markdown",
 "checks":[{"q":"...","options":["A","B","C","D"],"answer":0,"explain":"why the answer is right and the best distractor is wrong"}],
 "teachBack":"a prompt asking the learner to explain the idea in their own words, ideally to a specific imagined person or via a small scenario",
 "keyPoints":["3-5 points a correct own-words explanation should contain"],
 "cards":[{"front":"recall question","back":"concise answer"}]`;
const lessonShape = `${lessonShapeBase}}`;
const deepExtras = (socratic: boolean) => `,
 "prediction":{"scenario":"a concrete situation in 2-3 sentences, stopping just before the outcome","question":"what do you expect happens next / what would you do?","outcome":"what actually happens and why, 2-3 sentences"},
 "deeper":{"question":"an open question that forces thinking about TRADE-OFFS, failure modes, scale, or second-order effects (not recall)","considerations":["4-5 things a thoughtful answer would raise"]}${
   socratic ? `,
 "socratic":[{"q":"a leading question the learner can partly answer from what they already know","hint":"a nudge if they are stuck","idea":"the insight the question points to"}]  /* exactly 3, ordered so each builds on the last */` : ""
 }}`;

export function surveyLessonPrompt(p: Profile, s: TopicState, area: Area): string {
  return `${learnerBlurb(p)}
Topic: "${s.title}". ${useBlurb(s)} This is the BROAD SURVEY pass: give the learner the basic idea of the area "${area.title}" (${area.summary}).
Concepts to touch: ${area.concepts.map((c) => c.name).join(", ")}.
Rules: max ~250 words in markdown. ${p.order === "examples-first" ? "Open with a concrete example, then name the idea." : p.order === "theory-first" ? "State the core principle first, then illustrate." : "Open with where it fits in the whole field, then the idea, then an example."}
Use the learner's preferred styles (${p.styles.join(", ") || "any"}). ${diagramRule(p)} ${MERMAID_RULES}
${STEM_RULES}
${QUESTION_RULES}
Exactly 2 multiple-choice checks (4 options each, "answer" is the 0-based index, plausible distractors based on real misconceptions; vary the position of the right answer). 2-3 flashcards.
Return ONLY JSON of this shape:
${lessonShape}`;
}

export function outlinePrompt(p: Profile, s: TopicState, area: Area): string {
  return `${learnerBlurb(p)}
Topic: "${s.title}". Plan a DEEP DIVE into "${area.title}" (${area.summary}); concepts: ${area.concepts.map((c) => c.name).join(", ")}.
Design 4-7 lessons that build on each other (simple -> complex, each introduces ONE main idea), ending with a lesson that integrates everything in a realistic scenario.
Return ONLY JSON: {"lessons":[{"id":"short-kebab-id","title":"...","objective":"By the end you can ..."}]}`;
}

export function deepLessonPrompt(p: Profile, s: TopicState, area: Area, lesson: LessonRef, doneTitles: string[]): string {
  return `${learnerBlurb(p)}
Topic: "${s.title}", area "${area.title}". ${useBlurb(s)} DEEP lesson: "${lesson.title}" — objective: ${lesson.objective}.
Already covered in this area: ${doneTitles.join("; ") || "nothing yet"}. Build on that; connect back to it explicitly.
Rules: 400-650 words of markdown with ## subheadings. ${p.order === "examples-first" ? "Start from a worked example, then abstract." : p.order === "theory-first" ? "Start from first principles, then apply." : "Start from the big picture, zoom in, then work an example."}
Include a worked example, one common misconception to avoid, and ${p.diagrams === "minimal" ? "at least one" : "1-2"} figure(s) (mermaid, svg or plot as fits the subject) showing the real mechanism/structure (not decoration). ${MERMAID_RULES}
${STEM_RULES}
${QUESTION_RULES}
Challenge level: ${p.challenge}. Exactly ${p.challenge === "tough" ? 4 : 3} multiple-choice checks that test understanding/application, not trivia (4 options, "answer" is 0-based). 3-4 flashcards phrased as recall questions.
${p.socratic ? "The learner prefers a SOCRATIC style: the markdown is the consolidation shown AFTER they work through your leading questions, so it should name and tie together the ideas those questions lead to." : ""}
Also include the "prediction" (a situation where a wrong intuition is likely, so they learn from guessing wrong), the "deeper" trade-off question${p.socratic ? ", and exactly 3 \"socratic\" questions" : ""}.
Return ONLY JSON of this shape (omit the /* */ comment):
${lessonShapeBase}${deepExtras(!!p.socratic)}`;
}

export function reexplainPrompt(p: Profile, topic: string, lessonTitle: string, original: string): string {
  return `${learnerBlurb(p)}
The learner is stuck on "${lessonTitle}" (topic: ${topic}). Re-explain the SAME idea differently: new analogy, simpler words, different example. Do not repeat the original framing. Max 200 words, markdown, optionally one figure or equation. ${MERMAID_RULES}\n${STEM_RULES.replace(/Inside the JSON, double every backslash \(write \\\\frac\)\./, '')}
Original explanation for reference:
${original}
Return only the markdown.`;
}

export function gradePrompt(p: Profile, lessonTitle: string, prompt: string, keyPoints: string[], answer: string): string {
  const tone = { encouraging: "warm and specific", direct: "blunt and efficient", socratic: "mostly questions that lead them to see gaps themselves" }[p.tone];
  return `Grade a learner's own-words explanation. Lesson: "${lessonTitle}". Prompt given: "${prompt}".
A strong answer includes: ${keyPoints.map((k) => `- ${k}`).join("\n")}
Learner's answer: """${answer}"""
Be ${tone}. Judge understanding, not wording; reward correct paraphrase, penalise parroting and errors. score: 0 = off/blank, 1 = fragments, 2 = mostly right with gaps, 3 = solid.
Return ONLY JSON: {"score":0-3,"right":["what they got right"],"missing":["key ideas absent"],"misconceptions":["things they said that are wrong, with the correction"],"feedback":"2-3 sentences","followUp":"one probing question that would deepen their understanding"}`;
}

export function bigPicturePrompt(s: TopicState): { prompt: string; keyPoints: string[] } {
  const areas = s.map!.areas;
  return {
    prompt: `Without looking back: how do the main areas of ${s.title} (${areas.map((a) => a.title).join(", ")}) fit together? Explain it as if briefing a smart friend.`,
    keyPoints: areas.map((a) => `${a.title}: ${a.summary}`),
  };
}

export const gradeLabel = (g: Grade) => ["Not yet", "Getting there", "Mostly there", "Solid"][g.score];

export interface Persona {
  label: string;
  voice: string;
}

export const PERSONAS: Persona[] = [
  { label: "a curious 12-year-old", voice: "asks 'but why?', gets lost at jargon, loves concrete pictures" },
  { label: "a skeptical expert from a neighbouring field", voice: "challenges hand-waving, asks for precision, probes edge cases" },
  { label: "a new teammate on their first day", voice: "practical: asks how it applies in real work and what to watch out for" },
  { label: "a smart friend who has never heard of this", voice: "bright but zero background; spots any step that was skipped" },
];

export function personaPrompt(p: Profile, persona: Persona, title: string, keyPoints: string[], answer: string): string {
  return `Role-play ${persona.label} (${persona.voice}) who just heard the learner explain "${title}". Their explanation: """${answer}"""
A complete explanation would cover: ${keyPoints.join("; ")}.
React in character in 1-2 sentences (say honestly what confused you or what clicked), then ask ONE follow-up question aimed at the biggest gap or shaky claim in what they said. Stay in character; never reveal the answer. The question must still be unambiguous: one specific thing asked, with any needed context stated.
Return ONLY JSON: {"reaction":"...","question":"..."}`;
}

export function diagnoseQuestionsPrompt(p: Profile, title: string, missed: string[], explanation: string): string {
  return `${learnerBlurb(p)}
The learner struggled with "${title}". They missed: ${missed.map((m) => `"${m}"`).join("; ") || "none (their own-words explanation was weak)"}. ${explanation ? `Feedback on their explanation: ${explanation}` : ""}
Write exactly 2 short diagnostic questions (not quiz questions) that reveal WHAT mental model they hold, e.g. "what do you picture happens when ...?". Do not teach yet.
${QUESTION_RULES}
Return ONLY JSON: {"questions":["...","..."]}`;
}

export function diagnoseResultPrompt(p: Profile, title: string, qa: { q: string; a: string }[], missed: string[]): string {
  return `${learnerBlurb(p)}
Lesson "${title}". Missed questions: ${missed.join("; ") || "n/a"}.
Diagnostic Q&A:
${qa.map((x) => `Q: ${x.q}\nA: ${x.a || "(no answer)"}`).join("\n")}
Identify the single most likely misconception or gap, re-teach exactly that with a NEW angle (max 150 words, markdown, optional tiny mermaid), and write one fresh multiple-choice check that would fail if the misconception persists (4 options, "answer" 0-based index).
${QUESTION_RULES}
Return ONLY JSON: {"misconception":"one sentence","reteach":"markdown","retest":{"q":"...","options":["","","",""],"answer":0,"explain":"..."}}`;
}

export const LENSES = [
  { id: "tradeoffs", label: "Trade-offs", ask: "what is given up by this approach, and under what conditions would the alternative win?" },
  { id: "failure", label: "What could go wrong", ask: "how could this fail or be misused, and what early warning signs would show it?" },
  { id: "scale", label: "Scale & time", ask: "what changes if this grows 100x or has to last 10 years?" },
  { id: "second-order", label: "Second-order effects", ask: "what knock-on effects follow that nobody planned for?" },
  { id: "inversion", label: "Invert it", ask: "if you wanted this to fail on purpose, or the opposite assumption held, what would happen?" },
  { id: "edge", label: "Edge cases", ask: "which unusual situations break the neat explanation?" },
];

export function deeperPrompt(p: Profile, s: TopicState, title: string, lens: (typeof LENSES)[number], earlier: string[]): string {
  return `${learnerBlurb(p)} ${useBlurb(s)}
Topic "${s.title}", lesson "${title}". Pose ONE open-ended "think deeper" question through the lens "${lens.label}": ${lens.ask}
Make it concrete (a specific situation, not abstract). Do not repeat earlier questions: ${earlier.join(" | ") || "none"}.
${QUESTION_RULES}
Return ONLY JSON: {"question":"...","considerations":["4-5 things a thoughtful answer would raise"]}`;
}

export function critiquePrompt(p: Profile, title: string, question: string, considerations: string[], answer: string): string {
  const tone = { encouraging: "warm and specific", direct: "blunt and efficient", socratic: "mostly questions" }[p.tone];
  return `The learner is thinking beyond the basics on "${title}". Question: "${question}"
A thoughtful answer would raise: ${considerations.map((c) => `- ${c}`).join("\n")}
Learner's answer: """${answer}"""
Judge reasoning quality, not length: did they weigh both sides, name concrete risks, and notice second-order effects? Credit valid points that are NOT in the list. Be ${tone}.
Return ONLY JSON: {"strong":["good points they made"],"blindSpots":["important angles they did not consider, each with one sentence of why it matters"],"pushback":"one hard follow-up that challenges their weakest assumption","feedback":"2 sentences"}`;
}

export function challengePrompt(p: Profile, s: TopicState, area: Area, covered: string[]): string {
  return `${learnerBlurb(p)} ${useBlurb(s)}
The learner just finished a deep dive into "${area.title}" (topic "${s.title}"), covering: ${covered.join("; ")}.
Write ONE realistic application challenge: a specific scenario with constraints and a decision to make, where there is no single right answer and the learner must weigh trade-offs and anticipate what could go wrong. Make it ${p.challenge === "tough" ? "hard and ambiguous" : p.challenge === "gentle" ? "approachable" : "moderately demanding"}.
${QUESTION_RULES}
Return ONLY JSON: {"scenario":"3-5 sentences","task":"what they must decide or design, and justify","considerations":["5-6 things a strong answer weighs"]}`;
}

import * as p from "@clack/prompts";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROVIDER_HELP, hasBinary as has, installedProviders } from "../llm.js";
import { saveProfile } from "../store.js";
import { must, t } from "../ui.js";
import type { Profile, ProviderName } from "../types.js";

export async function onboard(existing?: Profile | null): Promise<Profile> {
  p.intro(t.bold(t.accent(existing ? " Edit your learner profile " : " Let's set up how YOU learn ")));
  if (!existing) {
    p.note("Answer a few questions so every lesson, quiz and diagram fits you.\nYou can change any of this later with `loops profile`.", "Welcome");
    const found = (["claude", "codex"] as const).map((n) => `${has(n) ? t.ok("✓") : t.dim("✗")} ${PROVIDER_HELP[n].label}`).join("   ");
    p.note(
      [
        `loops has no AI of its own. It looks for Claude Code or Codex on your computer and uses it as your tutor:  ${found}`,
        "",
        "To avoid surprise charges:",
        "  • It only uses your subscription login. API-key / pay-per-token logins are refused,",
        "    and API-key environment variables are hidden from the tutor.",
        "  • If one tutor fails (e.g. usage limit), it switches to the other.",
        "  • It can't see your account's \"extra usage\" / credits setting. Turn that off in your",
        "    Claude or ChatGPT account settings if you don't want to pay beyond your plan.",
      ].join("\n"),
      "Your tutor & billing",
    );
  }
  const d = existing;

  const name = must(await p.text({ message: "What should I call you?", initialValue: d?.name, validate: (v) => (v?.trim() ? undefined : "Required") }));

  const installed = installedProviders();
  const provider = must(
    await p.select<ProviderName>({
      message: "Which AI tutor should power your lessons?",
      initialValue: d?.provider ?? installed[0] ?? "claude",
      options: [
        { value: "claude", label: "Claude Code", hint: has("claude") ? "detected" : "not found on PATH" },
        { value: "codex", label: "Codex CLI", hint: has("codex") ? "detected" : "not found on PATH" },
      ],
    }),
  );

  const goal = must(
    await p.select({
      message: "Why do you learn things, mostly?",
      initialValue: d?.goal,
      options: [
        { value: "curiosity — understand it for its own sake", label: "Curiosity" },
        { value: "career — apply it at work", label: "Career / work" },
        { value: "exam or certification", label: "Exam / certification" },
        { value: "building a specific project", label: "Build a project" },
        { value: "teach it to others", label: "Teach others" },
      ],
    }),
  );

  const level = must(
    await p.select<Profile["level"]>({
      message: "When you start something new, you usually are…",
      initialValue: d?.level ?? "beginner",
      options: [
        { value: "beginner", label: "A true beginner", hint: "assume nothing" },
        { value: "some-background", label: "Some background", hint: "skip the very basics" },
        { value: "experienced", label: "Experienced in adjacent areas", hint: "move fast, draw parallels" },
      ],
    }),
  );

  const styles = must(
    await p.multiselect({
      message: "What helps ideas stick for you? (space to toggle)",
      initialValues: d?.styles ?? ["concrete examples"],
      required: false,
      options: [
        { value: "concrete examples", label: "Concrete examples" },
        { value: "analogies to things I know", label: "Analogies" },
        { value: "diagrams and visuals", label: "Diagrams & visuals" },
        { value: "first-principles reasoning", label: "First principles" },
        { value: "history and stories", label: "History & stories" },
        { value: "small hands-on exercises", label: "Hands-on exercises" },
        { value: "step-by-step walkthroughs", label: "Step-by-step walkthroughs" },
      ],
    }),
  );

  const order = must(
    await p.select<Profile["order"]>({
      message: "How should explanations be ordered?",
      initialValue: d?.order ?? "big-picture-first",
      options: [
        { value: "examples-first", label: "Example first, then the idea" },
        { value: "theory-first", label: "Principle first, then examples" },
        { value: "big-picture-first", label: "Big picture first, then zoom in" },
      ],
    }),
  );

  const diagrams = must(
    await p.select<Profile["diagrams"]>({
      message: "Mermaid diagrams in your notes?",
      initialValue: d?.diagrams ?? "some",
      options: [
        { value: "lots", label: "Lots — I think visually" },
        { value: "some", label: "Some — when they help" },
        { value: "minimal", label: "Minimal" },
      ],
    }),
  );

  const challenge = must(
    await p.select<Profile["challenge"]>({
      message: "How hard should quizzes be?",
      initialValue: d?.challenge ?? "balanced",
      options: [
        { value: "gentle", label: "Gentle", hint: "build confidence" },
        { value: "balanced", label: "Balanced" },
        { value: "tough", label: "Tough", hint: "desirable difficulty" },
      ],
    }),
  );

  const tone = must(
    await p.select<Profile["tone"]>({
      message: "How should I give feedback on your own-words answers?",
      initialValue: d?.tone ?? "encouraging",
      options: [
        { value: "encouraging", label: "Encouraging & specific" },
        { value: "direct", label: "Direct — tell me what's wrong" },
        { value: "socratic", label: "Socratic — ask me questions" },
      ],
    }),
  );

  const socratic = must(
    await p.select<boolean>({
      message: "How should new ideas be introduced?",
      initialValue: d?.socratic ?? false,
      options: [
        { value: false, label: "Explain, then quiz me", hint: "classic" },
        { value: true, label: "Socratic — ask me leading questions first", hint: "slower, sticks better" },
      ],
    }),
  );

  const context = must(
    await p.text({
      message: "What are you working on or hoping to use this for? (job, project, problem)",
      initialValue: d?.context,
      placeholder: "optional — examples will be drawn from this",
    }),
  );

  const minutesPerSession = must(
    await p.select<number>({
      message: "How long is a typical study session?",
      initialValue: d?.minutesPerSession ?? 25,
      options: [10, 15, 25, 45, 60].map((m) => ({ value: m, label: `${m} min` })),
    }),
  );

  const rootDir = must(await p.text({ message: "Where should your learning folders live?", initialValue: d?.rootDir ?? join(homedir(), "Learning").replace(homedir(), "~") }));

  const profile: Profile = { name: name.trim(), provider, goal, level, minutesPerSession, styles, order, diagrams, challenge, tone, rootDir, socratic, context: context.trim() || undefined };
  await saveProfile(profile);
  p.outro(t.ok(`Profile saved. Nice to meet you, ${profile.name}!`));
  return profile;
}

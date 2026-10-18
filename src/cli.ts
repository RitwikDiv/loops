#!/usr/bin/env node
import * as p from "@clack/prompts";
import { listTopics, loadProfile, configDir, deleteTopic } from "./store.js";
import { PROVIDER_HELP, allStatuses, noProviderMessage, setNotifier } from "./llm.js";
import { isDue } from "./srs.js";
import { currentStreak, doneToday, loadStats, recordActivity, saveCheckin, type Energy, type Stats } from "./stats.js";
import { banner, bar, must, t } from "./ui.js";
import { onboard } from "./flows/onboard.js";
import { continueTopic, newTopic, printMap } from "./flows/learn.js";
import { reviewCards } from "./flows/quiz.js";
import type { Profile, Topic } from "./types.js";

const HELP = `${t.bold("loops")} — learn anything with Claude Code or Codex as your tutor

  loops                 interactive menu
  loops new [topic]     start learning something new
  loops continue        pick up where you left off
  loops review          spaced-repetition review of due flashcards
  loops quiz            interleaved mixed quiz across everything you've learned
  loops mistakes        your mistake journal
  loops streak          your streak
  loops map             show a topic's map and prerequisite diagram
  loops topics          list your topics and progress
  loops delete          delete a topic and all its notes and progress
  loops profile         edit how you like to learn
  loops --help          this help

To delete a course: run ${t.bold("loops delete")}, or choose "Delete a topic" from the menu.

Env: LOOPS_HOME (config dir), LOOPS_PROVIDER=claude|codex, LOOPS_ALLOW_API_BILLING=1 (allow pay-per-token logins), NO_COLOR`;

const dueCount = (topics: Topic[]) => topics.reduce((n, tp) => n + tp.state.cards.filter((c) => isDue(c)).length, 0);

function progressOf(tp: Topic) {
  const areas = tp.state.map?.areas ?? [];
  const lessons = areas.reduce((n, a) => n + (tp.state.progress[a.id]?.done.length ?? 0), 0);
  return { areas: areas.length, surveyed: areas.filter((a) => tp.state.progress[a.id]?.surveyed).length, lessons };
}

async function chooseTopic(topics: Topic[], message: string): Promise<Topic> {
  const idx = must(
    await p.select<number>({
      message,
      options: topics.map((tp, i) => {
        const pr = progressOf(tp);
        return { value: i, label: `${tp.state.title}`, hint: `${tp.state.category} · ${pr.surveyed}/${pr.areas} surveyed · ${pr.lessons} deep lessons` };
      }),
    }),
  );
  return topics[idx];
}

const streakLine = (st: Stats) => {
  const n = currentStreak(st);
  const today = doneToday(st) ? t.ok("today ✓") : n ? t.warn("study today to keep it") : t.dim("start one today");
  return `${n ? t.warn("🔥 " + n + "-day streak") : t.dim("no streak yet")} ${t.dim("· best " + st.longest + " ·")} ${today}`;
};

type Pick = "continue" | "review" | "quiz" | "new";

/** Once a day: ask about energy and time, then recommend what to do. Also sets today's session length. */
async function checkin(profile: Profile, st: Stats, topics: Topic[]): Promise<{ stats: Stats; rec: Pick }> {
  const cardCount = topics.reduce((n, tp) => n + tp.state.cards.length, 0);
  const due = dueCount(topics);
  let energy: Energy = "medium";
  let minutes = profile.minutesPerSession;
  if (st.checkin?.day === new Date().toLocaleDateString("en-CA")) {
    energy = st.checkin.energy;
    minutes = st.checkin.minutes;
  } else {
    p.log.message(streakLine(st));
    energy = must(
      await p.select<Energy>({
        message: "Quick check-in: how's your energy today?",
        initialValue: "medium",
        options: [
          { value: "low", label: "Low", hint: "keep it light" },
          { value: "medium", label: "Okay" },
          { value: "high", label: "Sharp", hint: "good day for hard stuff" },
        ],
      }),
    );
    minutes = must(
      await p.select<number>({
        message: "How much time do you have?",
        initialValue: profile.minutesPerSession,
        options: [10, 15, 25, 45, 60].map((m) => ({ value: m, label: `${m} min` })),
      }),
    );
    st = await saveCheckin(st, energy, minutes);
  }
  profile.minutesPerSession = minutes; // today only; not saved
  let rec: Pick = "continue";
  if (!topics.length) rec = "new";
  else if (due > 0 && (energy === "low" || minutes <= 10)) rec = "review";
  else if (energy === "low" && cardCount >= 4) rec = "quiz";
  else if (due >= 8) rec = "review";
  return { stats: st, rec };
}

/** On launch: reopen something you've started, or begin something new. Returns once that session ends. */
async function startScreen(profile: Profile, topics: Topic[], rec: Pick) {
  if (!topics.length) {
    p.log.message(t.dim("Nothing started yet — let's pick your first topic."));
    return dispatch("new", profile);
  }
  const recent = topics.slice(0, 5);
  const choice = must(
    await p.select<string>({
      message: "Pick up where you left off, or start something new?",
      initialValue: rec === "new" ? "__new" : "0",
      options: [
        ...recent.map((tp, i) => {
          const pr = progressOf(tp);
          const where = tp.state.phase === "survey" ? `surveying ${pr.surveyed}/${pr.areas}` : `deep dive · ${pr.lessons} lessons done`;
          return { value: String(i), label: tp.state.title, hint: `${tp.state.category} · ${where}` };
        }),
        { value: "__new", label: t.accent("+ Start something new") },
        { value: "__menu", label: t.dim("Go to the main menu") },
        { value: "__delete", label: t.dim("Delete a topic"), hint: "or run `loops delete`" },
      ],
    }),
  );
  if (choice === "__menu") return;
  if (choice === "__new") return dispatch("new", profile);
  if (choice === "__delete") return dispatch("delete", profile);
  const tp = recent[Number(choice)];
  if (tp.state.map && tp.state.phase === "survey" && !tp.state.progress[tp.state.map.areas[0].id]?.surveyed) printMap(tp);
  await continueTopic(profile, tp);
}

async function menu(profile: Profile) {
  let first = true;
  let rec: Pick = "continue";
  while (true) {
    const topics = await listTopics(profile);
    const due = dueCount(topics);
    let stats = await loadStats();
    if (first) {
      ({ stats, rec } = await checkin(profile, stats, topics));
      first = false;
      await startScreen(profile, topics, rec);
      continue; // reload topics and stats after the session
    }
    const cards = topics.reduce((n, tp) => n + tp.state.cards.length, 0);
    const star = (v: Pick) => (rec === v ? t.accent(" ★ recommended for today") : "");
    const opts = [
      ...(topics.length ? [{ value: "continue", label: "Continue learning", hint: topics[0].state.title + star("continue") }] : []),
      { value: "new", label: "Start a new topic", hint: star("new").trim() || undefined },
      ...(due ? [{ value: "review", label: "Review flashcards", hint: `${due} due${star("review")}` }] : []),
      ...(cards >= 4 ? [{ value: "quiz", label: "Mixed quiz", hint: `interleaved, weakest first${star("quiz")}` }] : []),
      ...(topics.some((tp) => tp.state.mistakes?.length) ? [{ value: "mistakes", label: "Mistake journal" }] : []),
      ...(topics.length ? [{ value: "topics", label: "My topics" }, { value: "delete", label: "Delete a topic" }] : []),
    ];
    // put the recommendation first
    opts.sort((a, b) => Number(b.value === rec) - Number(a.value === rec));
    p.log.message(streakLine(stats));
    const action = must(
      await p.select<string>({
        message: `Hi ${profile.name}, what now?`,
        options: [
          ...opts,
          { value: "profile", label: "Edit my learner profile" },
          { value: "quit", label: "Quit" },
        ],
      }),
    );
    if (action === "quit") return p.outro(t.dim("Keep the loop going ✦"));
    await dispatch(action, profile);
  }
}

async function dispatch(action: string, profile: Profile, arg?: string) {
  const topics = await listTopics(profile);
  switch (action) {
    case "new": {
      const tp = await newTopic(profile, arg);
      if (tp && must(await p.select({ message: "Start the broad survey now?", options: [{ value: true, label: "Yes, let's go" }, { value: false, label: "Later" }] }))) await continueTopic(profile, tp);
      break;
    }
    case "continue": {
      if (!topics.length) return p.log.warn("No topics yet — try `loops new`.");
      const tp = topics.length === 1 ? topics[0] : await chooseTopic(topics, "Which topic?");
      if (tp.state.map && tp.state.phase === "survey" && !tp.state.progress[tp.state.map.areas[0].id]?.surveyed) printMap(tp);
      await continueTopic(profile, tp);
      break;
    }
    case "review":
    case "quiz": {
      const mixed = action === "quiz";
      const n = await reviewCards(topics, mixed ? 10 : 20, mixed ? "mixed" : "due");
      p.log.success(n ? t.ok(`Reviewed ${n} card${n > 1 ? "s" : ""}.`) : mixed ? "No cards yet — finish a lesson first." : "Nothing due right now. Come back tomorrow — that's the point.");
      if (n) {
        const r = await recordActivity();
        if (r.message) p.log.success(t.warn("🔥 ") + t.bold(r.message));
      }
      break;
    }
    case "mistakes": {
      const withM = topics.filter((tp) => tp.state.mistakes?.length);
      if (!withM.length) return p.log.info("No mistakes logged yet — they're how you learn fastest, so they'll show up.");
      for (const tp of withM) {
        const recent = (tp.state.mistakes ?? []).slice(-6);
        p.note(recent.map((m) => `${t.warn(m.kind === "overconfident" ? "sure, but wrong" : m.kind)} ${t.dim("· " + m.lesson)}\n  ${m.what}\n  ${t.ok("→")} ${m.correction}${m.inMyWords ? `\n  ${t.dim("in my words: " + m.inMyWords)}` : ""}`).join("\n\n"), `${tp.state.title} — recent mistakes`);
        p.log.info(t.dim(`Full journal: ${tp.dir}/mistakes.md`));
      }
      break;
    }
    case "streak": {
      const st = await loadStats();
      p.note(`${streakLine(st)}\n${t.dim(`${st.totalDays} day${st.totalDays === 1 ? "" : "s"} studied in total`)}`, "Streak");
      break;
    }
    case "topics": {
      if (!topics.length) return p.log.warn("No topics yet.");
      const lines = topics.map((tp) => {
        const pr = progressOf(tp);
        return `${t.bold(tp.state.title)} ${t.dim(`(${tp.state.category})`)}\n  survey ${bar(pr.surveyed, pr.areas, 12)}  ${t.dim(`${pr.lessons} deep lessons · ${tp.state.cards.length} cards`)}\n  ${t.dim(tp.dir)}`;
      });
      p.note(lines.join("\n\n"), "Your topics");
      break;
    }
    case "map": {
      if (!topics.length) return p.log.warn("No topics yet.");
      const tp = topics.length === 1 ? topics[0] : await chooseTopic(topics, "Which topic?");
      if (tp.state.map) printMap(tp);
      break;
    }
    case "delete": {
      if (!topics.length) return p.log.warn("No topics to delete.");
      const tp = arg ? topics.find((x) => x.state.title.toLowerCase() === arg.toLowerCase()) ?? (await chooseTopic(topics, "Which topic?")) : await chooseTopic(topics, "Which topic do you want to delete?");
      const ok = must(await p.confirm({ message: `Delete "${tp.state.title}" and all its notes, cards and progress? This can't be undone.`, initialValue: false }));
      if (!ok) return p.log.info("Kept it.");
      await deleteTopic(tp);
      p.log.success(t.ok(`Deleted "${tp.state.title}".`));
      break;
    }
    case "profile":
      await onboard(profile);
      break;
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--help" || cmd === "-h" || cmd === "help") return console.log(HELP);
  if (cmd === "--version" || cmd === "-v") return console.log("0.4.0");
  if (!process.stdin.isTTY) {
    console.error("loops needs an interactive terminal.");
    process.exit(1);
  }
  banner();
  setNotifier((m) => p.log.warn(m));
  const statuses = await allStatuses();
  const usable = statuses.filter((x) => x.usable);
  if (!usable.length) {
    const installed = statuses.filter((x) => x.installed);
    p.log.error(t.bad(installed.length ? `No usable tutor:\n${installed.map((x) => `  - ${x.reason}`).join("\n")}` : noProviderMessage()));
    process.exit(1);
  }
  for (const x of statuses) if (x.installed && !x.usable) p.log.warn(x.reason);
  let profile = await loadProfile();
  if (!profile) profile = await onboard();
  if (process.env.LOOPS_PROVIDER === "claude" || process.env.LOOPS_PROVIDER === "codex") profile.provider = process.env.LOOPS_PROVIDER;
  if (!usable.some((x) => x.name === profile.provider)) {
    const fallback = usable[0].name;
    p.log.warn(`Using ${PROVIDER_HELP[fallback].label} for this session instead of ${PROVIDER_HELP[profile.provider].label}.`);
    profile.provider = fallback;
  }
  if (!cmd) return menu(profile);
  if (["new", "continue", "review", "quiz", "mistakes", "streak", "topics", "profile", "map", "delete"].includes(cmd)) return dispatch(cmd, profile, rest.join(" ") || undefined);
  console.log(HELP);
  process.exit(1);
}

main().catch((e) => {
  p.log.error(t.bad((e as Error).message));
  console.error(t.dim(`(config: ${configDir()})`));
  process.exit(1);
});

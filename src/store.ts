import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { Mistake, Profile, Topic, TopicState } from "./types.js";

export const configDir = () => process.env.LOOPS_HOME ?? join(homedir(), ".config", "loops");
const profilePath = () => join(configDir(), "profile.json");

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "untitled";

export const expandHome = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

export async function loadProfile(): Promise<Profile | null> {
  try {
    return JSON.parse(await readFile(profilePath(), "utf8")) as Profile;
  } catch {
    return null;
  }
}

export async function saveProfile(profile: Profile) {
  await mkdir(configDir(), { recursive: true });
  await writeFile(profilePath(), JSON.stringify(profile, null, 2));
}

export async function writeText(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

export async function saveTopic(topic: Topic) {
  await writeText(join(topic.dir, "topic.json"), JSON.stringify(topic.state, null, 2));
}

/** Topics live at <root>/<category>/<slug>/topic.json. */
export async function listTopics(profile: Profile): Promise<Topic[]> {
  const root = expandHome(profile.rootDir);
  if (!existsSync(root)) return [];
  const topics: Topic[] = [];
  for (const cat of await readdir(root, { withFileTypes: true })) {
    if (!cat.isDirectory()) continue;
    for (const sub of await readdir(join(root, cat.name), { withFileTypes: true })) {
      const file = join(root, cat.name, sub.name, "topic.json");
      if (!sub.isDirectory() || !existsSync(file)) continue;
      try {
        topics.push({ dir: join(root, cat.name, sub.name), state: JSON.parse(await readFile(file, "utf8")) as TopicState });
      } catch {
        /* skip unreadable topic */
      }
    }
  }
  return topics.sort((a, b) => lastTouched(b).localeCompare(lastTouched(a)));
}

const lastTouched = (t: Topic) => t.state.cards.map((c) => c.due).sort().pop() ?? t.state.createdAt;

/** Removes a topic's folder (notes, cards, progress) and its category folder if that leaves it empty. */
export async function deleteTopic(topic: Topic) {
  await rm(topic.dir, { recursive: true, force: true });
  const cat = dirname(topic.dir);
  if (!(await readdir(cat).catch(() => ["x"])).length) await rm(cat, { recursive: true, force: true });
}

export async function listCategories(profile: Profile): Promise<string[]> {
  const root = expandHome(profile.rootDir);
  if (!existsSync(root)) return [];
  return (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
}

export async function createTopic(profile: Profile, title: string, category: string, priorKnowledge: string): Promise<Topic> {
  const slug = slugify(title);
  const dir = join(expandHome(profile.rootDir), slugify(category), slug);
  const state: TopicState = {
    title,
    slug,
    category: slugify(category),
    createdAt: new Date().toISOString(),
    priorKnowledge,
    phase: "map",
    progress: {},
    bigPictureDone: false,
    cards: [],
    mistakes: [],
    connections: [],
  };
  const topic = { dir, state };
  await saveTopic(topic);
  return topic;
}

export function addMistake(topic: Topic, m: Omit<Mistake, "date">) {
  const list = (topic.state.mistakes ??= []);
  if (list.some((x) => x.lesson === m.lesson && x.what === m.what)) return;
  list.push({ date: new Date().toISOString().slice(0, 10), ...m });
}

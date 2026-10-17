import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./store.js";

export type Energy = "low" | "medium" | "high";

export interface Stats {
  streak: number;
  longest: number;
  lastDay: string; // local YYYY-MM-DD of last activity
  totalDays: number;
  checkin?: { day: string; energy: Energy; minutes: number };
}

const statsPath = () => join(configDir(), "stats.json");
export const dayKey = (d = new Date()) => d.toLocaleDateString("en-CA");
const yesterdayKey = (d = new Date()) => dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));

export async function loadStats(): Promise<Stats> {
  try {
    return { streak: 0, longest: 0, lastDay: "", totalDays: 0, ...JSON.parse(await readFile(statsPath(), "utf8")) };
  } catch {
    return { streak: 0, longest: 0, lastDay: "", totalDays: 0 };
  }
}

export async function saveStats(s: Stats) {
  await mkdir(configDir(), { recursive: true });
  await writeFile(statsPath(), JSON.stringify(s, null, 2));
}

/** The streak you could still lose: alive if you studied today or yesterday. */
export function currentStreak(s: Stats, now = new Date()): number {
  return s.lastDay === dayKey(now) || s.lastDay === yesterdayKey(now) ? s.streak : 0;
}

export const doneToday = (s: Stats, now = new Date()) => s.lastDay === dayKey(now);

/** Pure update; returns the new stats and whether today's activity just extended the streak. */
export function applyActivity(s: Stats, now = new Date()): { stats: Stats; extended: boolean } {
  const today = dayKey(now);
  if (s.lastDay === today) return { stats: s, extended: false };
  const streak = s.lastDay === yesterdayKey(now) ? s.streak + 1 : 1;
  return { stats: { ...s, streak, longest: Math.max(s.longest, streak), lastDay: today, totalDays: s.totalDays + 1 }, extended: true };
}

export async function recordActivity(now = new Date()): Promise<{ stats: Stats; extended: boolean; message?: string }> {
  const { stats, extended } = applyActivity(await loadStats(), now);
  if (extended) await saveStats(stats);
  const milestone = [3, 7, 14, 30, 60, 100].includes(stats.streak);
  const message = extended
    ? stats.streak === 1
      ? "Day 1 done. Come back tomorrow to start a streak."
      : `${stats.streak}-day streak!${milestone ? " That's a real habit forming." : ""}${stats.streak === stats.longest && stats.streak > 1 ? " Personal best." : ""}`
    : undefined;
  return { stats, extended, message };
}

export async function saveCheckin(s: Stats, energy: Energy, minutes: number): Promise<Stats> {
  const next = { ...s, checkin: { day: dayKey(), energy, minutes } };
  await saveStats(next);
  return next;
}

import type { Card } from "./types.js";

const DAY = 86_400_000;
export type Rating = "again" | "hard" | "good" | "easy";

export function newCard(front: string, back: string, source: string, now = new Date()): Card {
  return {
    id: Math.random().toString(36).slice(2, 10),
    front,
    back,
    source,
    ease: 2.5,
    interval: 0,
    reps: 0,
    lapses: 0,
    due: now.toISOString(),
  };
}

/** Simplified SM-2: failed cards come back soon, successful ones expand the gap. */
export function schedule(card: Card, rating: Rating, now = new Date()): Card {
  const c = { ...card };
  if (rating === "again") {
    c.lapses++;
    c.reps = 0;
    c.ease = Math.max(1.3, c.ease - 0.2);
    c.interval = 0;
    c.due = new Date(now.getTime() + 10 * 60_000).toISOString();
    return c;
  }
  c.reps++;
  if (rating === "hard") c.ease = Math.max(1.3, c.ease - 0.15);
  if (rating === "easy") c.ease += 0.15;
  if (c.reps === 1) c.interval = rating === "easy" ? 3 : 1;
  else if (c.reps === 2) c.interval = rating === "hard" ? 2 : 4;
  else c.interval = Math.max(1, Math.round(c.interval * (rating === "hard" ? 1.2 : rating === "easy" ? c.ease * 1.3 : c.ease)));
  c.due = new Date(now.getTime() + c.interval * DAY).toISOString();
  return c;
}

export const isDue = (c: Card, now = new Date()) => new Date(c.due).getTime() <= now.getTime();

export function addCards(existing: Card[], fresh: { front: string; back: string }[], source: string): number {
  let added = 0;
  for (const f of fresh) {
    if (existing.some((c) => c.front.trim().toLowerCase() === f.front.trim().toLowerCase())) continue;
    existing.push(newCard(f.front, f.back, source));
    added++;
  }
  return added;
}

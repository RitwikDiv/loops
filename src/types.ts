export type ProviderName = "claude" | "codex";

export interface Profile {
  name: string;
  provider: ProviderName;
  goal: string;
  level: "beginner" | "some-background" | "experienced";
  minutesPerSession: number;
  styles: string[]; // how they like to learn (multi-select)
  order: "examples-first" | "theory-first" | "big-picture-first";
  diagrams: "lots" | "some" | "minimal";
  challenge: "gentle" | "balanced" | "tough";
  tone: "encouraging" | "direct" | "socratic";
  rootDir: string;
  socratic?: boolean; // lead with questions instead of explaining first
  context?: string; // what they're working on / where they'll use this
}

export interface Concept {
  name: string;
  blurb: string;
}

export interface Area {
  id: string;
  title: string;
  summary: string;
  prereqs: string[]; // area ids
  concepts: Concept[];
}

export interface MapData {
  overview: string;
  areas: Area[];
}

export interface Check {
  q: string;
  options: string[];
  answer: number;
  explain: string;
}

export interface LessonContent {
  primer: string; // a "guess first" question, asked before the explanation
  markdown: string;
  checks: Check[];
  teachBack: string;
  keyPoints: string[];
  cards: { front: string; back: string }[];
  prediction?: { scenario: string; question: string; outcome: string };
  deeper?: { question: string; considerations: string[] };
  socratic?: { q: string; hint: string; idea: string }[];
}

export interface Mistake {
  date: string;
  lesson: string;
  kind: "quiz" | "overconfident" | "explanation" | "diagnosis";
  what: string;
  correction: string;
  inMyWords?: string;
}

export interface Grade {
  score: 0 | 1 | 2 | 3;
  right: string[];
  missing: string[];
  misconceptions: string[];
  feedback: string;
  followUp: string;
}

export interface LessonRef {
  id: string;
  title: string;
  objective: string;
}

export interface Card {
  id: string;
  front: string;
  back: string;
  source: string; // lesson title, for context
  ease: number;
  interval: number; // days
  reps: number;
  lapses: number;
  due: string; // ISO date
  flag?: "overconfident"; // was sure, was wrong: resurfaces first
}

export interface AreaProgress {
  surveyed: boolean;
  outline?: LessonRef[];
  done: string[]; // completed lesson ids
}

export interface TopicState {
  title: string;
  slug: string;
  category: string;
  createdAt: string;
  priorKnowledge: string;
  phase: "map" | "survey" | "deep";
  map?: MapData;
  progress: Record<string, AreaProgress>;
  bigPictureDone: boolean;
  cards: Card[];
  mistakes?: Mistake[];
  connections?: string[]; // learner's own "where I'd use this" notes
  useCase?: string;
}

export interface Topic {
  dir: string;
  state: TopicState;
}

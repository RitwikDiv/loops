import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson } from "../src/llm.ts";
import { newCard, schedule, isDue } from "../src/srs.ts";
import { slugify } from "../src/store.ts";
import { mapMarkdown } from "../src/markdown.ts";

test("extractJson handles fences and chatter", () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => extractJson("nope"));
  const inner = { markdown: "a\n```mermaid\nflowchart LR\n  A-->B\n```" };
  assert.deepEqual(extractJson("```json\n" + JSON.stringify(inner) + "\n```"), inner);
});

test("srs: again resets, good expands", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  let c = newCard("q", "a", "s", now);
  c = schedule(c, "good", now);
  assert.equal(c.interval, 1);
  c = schedule(c, "good", now);
  assert.equal(c.interval, 4);
  c = schedule(c, "good", now);
  assert.ok(c.interval >= 9);
  const lapsed = schedule(c, "again", now);
  assert.equal(lapsed.reps, 0);
  assert.ok(isDue(lapsed, new Date(now.getTime() + 11 * 60_000)));
});

test("slugify", () => assert.equal(slugify("  How DBs Work?! "), "how-dbs-work"));

test("mapMarkdown emits sanitized mermaid", () => {
  const md = mapMarkdown({
    dir: "/x",
    state: {
      title: "SQL (basics)", slug: "sql", category: "c", createdAt: "", priorKnowledge: "", phase: "survey", progress: {}, bigPictureDone: false, cards: [],
      map: { overview: "o", areas: [{ id: "a", title: 'Joins: "inner"', summary: "s", prereqs: [], concepts: [{ name: "ON (clause)", blurb: "b" }] }, { id: "b", title: "B", summary: "", prereqs: ["a"], concepts: [] }] },
    },
  });
  assert.match(md, /root\(\(SQL basics\)\)/);
  assert.match(md, /n_a --> n_b/);
  assert.doesNotMatch(md, /mindmap[\s\S]*\(clause\)[\s\S]*```\n\n## Suggested/);
});

test("billing classification flags pay-per-token logins", async () => {
  const { classifyClaude, classifyCodex, childEnv } = await import("../src/llm.ts");
  assert.equal(classifyClaude('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'), "subscription");
  assert.equal(classifyClaude('{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty"}'), "metered");
  assert.equal(classifyClaude('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"bedrock"}'), "metered");
  assert.equal(classifyClaude('{"loggedIn":false}'), "logged-out");
  assert.equal(classifyClaude("garbage"), "unknown");
  assert.equal(classifyCodex("Logged in using ChatGPT"), "subscription");
  assert.equal(classifyCodex("Logged in using an API key - sk-***"), "metered");
  assert.equal(classifyCodex("Not logged in"), "logged-out");
  const env = { PATH: "/bin", ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "y" };
  assert.deepEqual(childEnv(env), { PATH: "/bin" });
  assert.equal(childEnv({ ...env, LOOPS_ALLOW_API_BILLING: "1" }).ANTHROPIC_API_KEY, "x");
});

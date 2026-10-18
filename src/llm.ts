import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ProviderName, Profile } from "./types.js";

export const TUTOR_SYSTEM = [
  "You are an exceptional tutor grounded in learning science: you activate prior knowledge,",
  "teach in small chunks, use concrete examples and diagrams, test retrieval rather than recognition,",
  "and correct misconceptions precisely. You never pad. You are accurate: if unsure, say so.",
  "You output exactly what is asked for, in the requested format, with no preamble.",
].join(" ");

export const PROVIDER_HELP: Record<ProviderName, { label: string; install: string; login: string }> = {
  claude: { label: "Claude Code", install: "npm install -g @anthropic-ai/claude-code", login: "claude" },
  codex: { label: "Codex CLI", install: "npm install -g @openai/codex", login: "codex login" },
};

/** True if `bin` is an executable file in some PATH directory (honours PATHEXT on Windows). */
export function hasBinary(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const exts = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      try {
        accessSync(join(dir, bin + ext), constants.X_OK);
        return true;
      } catch {}
    }
  }
  return false;
}

export const installedProviders = (): ProviderName[] => (["claude", "codex"] as const).filter((n) => hasBinary(n));

export function noProviderMessage(): string {
  return [
    "loops needs Claude Code or Codex installed to act as your tutor, and found neither on your PATH.",
    "",
    "Install one, sign in, then run loops again:",
    ...(Object.keys(PROVIDER_HELP) as ProviderName[]).map((n) => `  ${PROVIDER_HELP[n].label}: ${PROVIDER_HELP[n].install}  (then: ${PROVIDER_HELP[n].login})`),
    "",
    "Already installed in a non-standard place? Add its folder to your PATH.",
    "Sign in with a subscription account: loops refuses API-key / pay-per-token logins unless LOOPS_ALLOW_API_BILLING=1.",
  ].join("\n");
}

/** Credentials that make a CLI bill per token instead of using the user's subscription login. */
const METERED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "OPENAI_API_KEY", "CODEX_API_KEY"];
export const allowMetered = (env: NodeJS.ProcessEnv = process.env) => env.LOOPS_ALLOW_API_BILLING === "1";

/** The environment child CLIs run in: pay-per-token credentials are removed unless the user opted in. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (allowMetered(env)) return { ...env };
  const out = { ...env };
  for (const k of METERED_ENV) delete out[k];
  return out;
}

function run(cmd: string, args: string[], input: string, timeoutMs: number, includeStderr = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: tmpdir(), env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      const help = PROVIDER_HELP[cmd as ProviderName];
      reject(new Error(`Could not run "${cmd}" — is it installed and on your PATH?${help ? ` Install: ${help.install}` : ""} (${e.message})`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(includeStderr ? out + err : out);
      else reject(new Error(`${cmd} exited with ${code}: ${err.trim().split("\n").slice(-4).join("\n")}`));
    });
    child.stdin.end(input);
  });
}

async function completeWith(provider: ProviderName, prompt: string, timeoutMs: number): Promise<string> {
  if (provider === "claude") {
    return run(
      "claude",
      ["-p", "--tools", "", "--no-session-persistence", "--output-format", "text", "--system-prompt", TUTOR_SYSTEM],
      prompt,
      timeoutMs,
    );
  }
  const dir = await mkdtemp(join(tmpdir(), "loops-"));
  const outFile = join(dir, "last.txt");
  try {
    await run(
      "codex",
      ["exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-o", outFile, "-"],
      `${TUTOR_SYSTEM}\n\n${prompt}`,
      timeoutMs,
    );
    return await readFile(outFile, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type Billing = "subscription" | "metered" | "logged-out" | "unknown";

/** Classify `claude auth status` JSON. Anything that isn't a first-party subscription login bills per token. */
export function classifyClaude(raw: string): Billing {
  let j: any;
  try {
    j = JSON.parse(raw);
  } catch {
    return "unknown";
  }
  if (j.loggedIn === false) return "logged-out";
  const method = String(j.authMethod ?? "");
  if ((j.apiProvider && j.apiProvider !== "firstParty") || /api.?key|console/i.test(method)) return "metered";
  return /claude\.ai|oauth|subscription/i.test(method) ? "subscription" : "unknown";
}

/** Classify `codex login status` output. */
export function classifyCodex(text: string): Billing {
  if (/not logged in/i.test(text)) return "logged-out";
  if (/api key/i.test(text)) return "metered";
  return /chatgpt/i.test(text) ? "subscription" : "unknown";
}

export interface ProviderStatus {
  name: ProviderName;
  installed: boolean;
  billing: Billing;
  usable: boolean;
  /** Why it can't be used (empty when usable). */
  reason: string;
}

async function probe(name: ProviderName): Promise<ProviderStatus> {
  const label = PROVIDER_HELP[name].label;
  const bad = (billing: Billing, reason: string): ProviderStatus => ({ name, installed: hasBinary(name), billing, usable: false, reason });
  if (!hasBinary(name)) return bad("unknown", `${label} isn't installed (${PROVIDER_HELP[name].install})`);
  let billing: Billing;
  try {
    billing = name === "claude" ? classifyClaude(await run("claude", ["auth", "status"], "", 20_000)) : classifyCodex(await run("codex", ["login", "status"], "", 20_000, true));
  } catch {
    billing = "logged-out";
  }
  if (billing === "logged-out") return bad(billing, `${label} isn't signed in (run: ${PROVIDER_HELP[name].login})`);
  if (billing === "metered" && !allowMetered()) {
    return bad(billing, `${label} is signed in with an API key / pay-per-token account, which would charge you per request. Sign in with your subscription instead, or set LOOPS_ALLOW_API_BILLING=1 to allow it`);
  }
  return { name, installed: true, billing, usable: true, reason: "" };
}

const statusCache = new Map<ProviderName, Promise<ProviderStatus>>();
export const providerStatus = (name: ProviderName) => {
  if (!statusCache.has(name)) statusCache.set(name, probe(name));
  return statusCache.get(name)!;
};
export const allStatuses = () => Promise.all((["claude", "codex"] as const).map(providerStatus));

let notify: (msg: string) => void = (m) => console.error(m);
export const setNotifier = (fn: (msg: string) => void) => (notify = fn);
let sticky: ProviderName | undefined;

/**
 * Run the prompt on the preferred tutor; if it can't be used or fails (usage limit, outage, signed out), fall back
 * to the other one — but never to a CLI that would bill per token. Once a fallback works it's kept for the session.
 */
export async function complete(preferred: ProviderName, prompt: string, timeoutMs = 240_000): Promise<string> {
  const first = sticky ?? preferred;
  const order: ProviderName[] = [first, first === "claude" ? "codex" : "claude"];
  const problems: string[] = [];
  for (const name of order) {
    const st = await providerStatus(name);
    if (!st.usable) {
      problems.push(st.reason);
      continue;
    }
    if (name !== first) notify(`${PROVIDER_HELP[order[0]].label} didn't work, so I'm trying ${PROVIDER_HELP[name].label} instead.`);
    try {
      const out = await completeWith(name, prompt, timeoutMs);
      if (name !== preferred) sticky = name;
      return out;
    } catch (e) {
      problems.push(`${PROVIDER_HELP[name].label}: ${(e as Error).message}`);
    }
  }
  throw new Error(problems.join("\n"));
}

/**
 * Models often forget to double LaTeX backslashes inside JSON strings. `\theta` would silently parse as a
 * tab + "heta", `\nabla` as newline + "abla", `\frac` as form feed + "rac". Double the backslash of any
 * known command that collides with a JSON escape, and any lone backslash that isn't a valid escape at all.
 */
const COLLIDING = "theta|tau|times|text|textbf|textit|textrm|tan|tanh|tilde|to|top|triangle|therefore|tfrac|thinspace|frac|forall|flat|beta|bar|begin|boldsymbol|bot|binom|big|bigg|Big|Bigg|bmod|bullet|bigcup|bigcap|bigoplus|bf|rho|right|rightarrow|rangle|rbrace|rceil|rfloor|rm|nabla|neq|nu|ne|not|notin|newcommand|ni|neg|nleq|ngeq|nmid|nearrow";
export function repairLatexEscapes(json: string): string {
  const re = new RegExp(`\\\\\\\\|\\\\(?:(?=(?:${COLLIDING})(?![a-zA-Z]))|u(?![0-9a-fA-F]{4})|(?![\\\\"/bfnrtu]))`, "g");
  return json.replace(re, (m) => (m === "\\\\" ? m : "\\\\" + m.slice(1)));
}

export function extractJson(text: string): unknown {
  // Slice between the outermost braces; an outer ```json fence falls outside them. Don't strip
  // backticks globally: lesson markdown inside the JSON contains ```mermaid fences.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in model output");
  return JSON.parse(repairLatexEscapes(text.slice(start, end + 1)));
}

/** Ask for JSON, validate it, and retry once telling the model what was wrong. */
export async function askJson<T>(profile: Pick<Profile, "provider">, prompt: string, validate: (x: any) => T): Promise<T> {
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const full = attempt === 0 ? prompt : `${prompt}\n\nYour previous reply was rejected: ${lastError}\nReturn ONLY valid JSON this time.`;
    try {
      return validate(extractJson(await complete(profile.provider, full)));
    } catch (e) {
      lastError = (e as Error).message;
      if (attempt === 1 || /not installed|PATH|timed out/.test(lastError)) throw new Error(lastError);
    }
  }
  throw new Error(lastError);
}

export async function askText(profile: Pick<Profile, "provider">, prompt: string): Promise<string> {
  return (await complete(profile.provider, prompt)).trim();
}

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderName, Profile } from "./types.js";

export const TUTOR_SYSTEM = [
  "You are an exceptional tutor grounded in learning science: you activate prior knowledge,",
  "teach in small chunks, use concrete examples and diagrams, test retrieval rather than recognition,",
  "and correct misconceptions precisely. You never pad. You are accurate: if unsure, say so.",
  "You output exactly what is asked for, in the requested format, with no preamble.",
].join(" ");

function run(cmd: string, args: string[], input: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
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
      reject(new Error(`Could not run "${cmd}" — is it installed and on your PATH? (${e.message})`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited with ${code}: ${err.trim().split("\n").slice(-4).join("\n")}`));
    });
    child.stdin.end(input);
  });
}

export async function complete(provider: ProviderName, prompt: string, timeoutMs = 240_000): Promise<string> {
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

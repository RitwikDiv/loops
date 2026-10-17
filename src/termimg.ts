/** Inline images for terminals that support the iTerm2 or Kitty graphics protocols. */
export type ImageProtocol = "iterm" | "kitty";

export function imageProtocol(env = process.env, isTTY = !!process.stdout.isTTY): ImageProtocol | null {
  if (env.LOOPS_IMAGES === "off") return null;
  if (env.LOOPS_IMAGES === "iterm" || env.LOOPS_IMAGES === "kitty") return env.LOOPS_IMAGES; // forced
  if (!isTTY) return null;
  if (env.TMUX) return null; // needs passthrough; not worth the risk of garbage output
  if (env.KITTY_WINDOW_ID || env.TERM === "xterm-kitty" || env.TERM_PROGRAM === "ghostty") return "kitty";
  if (["iTerm.app", "WezTerm", "vscode"].includes(env.TERM_PROGRAM ?? "")) return "iterm";
  return null;
}

/** Escape sequence that draws `png` about `cells` columns wide. */
export function drawImage(png: Buffer, cells: number, protocol: ImageProtocol): string {
  const b64 = png.toString("base64");
  if (protocol === "iterm") return `\x1b]1337;File=inline=1;width=${cells};preserveAspectRatio=1:${b64}\x07`;
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += 4096) {
    const more = i + 4096 < b64.length ? 1 : 0;
    chunks.push(`\x1b_G${i === 0 ? `a=T,f=100,c=${cells},` : ""}m=${more};${b64.slice(i, i + 4096)}\x1b\\`);
  }
  return chunks.join("");
}

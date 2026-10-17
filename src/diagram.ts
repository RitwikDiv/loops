import { renderMermaidASCII } from "beautiful-mermaid";

const color = !!process.stdout.isTTY && !process.env.NO_COLOR;
const widest = (s: string) => Math.max(...s.split("\n").map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").length));

/** mindmap isn't supported by beautiful-mermaid, so draw it as an indented tree. */
function mindmapTree(src: string): string {
  const rows = src.split("\n").slice(1).filter((l) => l.trim());
  const label = (s: string) => s.trim().replace(/^[\w-]*\(\((.*)\)\)$/, "$1").replace(/^[\w-]*[(\[{]+(.*?)[)\]}]+$/, "$1");
  const base = rows[0]?.search(/\S/) ?? 0;
  const nodes = rows.map((r) => ({ depth: Math.round((r.search(/\S/) - base) / 2), text: label(r) }));
  return nodes
    .map((n, i) => {
      if (n.depth === 0) return n.text;
      let prefix = "";
      for (let d = 1; d < n.depth; d++) prefix += hasLaterSibling(nodes, i, d) ? "│  " : "   ";
      return prefix + (hasLaterSibling(nodes, i, n.depth) ? "├─ " : "└─ ") + n.text;
    })
    .join("\n");
}

function hasLaterSibling(nodes: { depth: number }[], i: number, depth: number): boolean {
  for (let j = i + 1; j < nodes.length; j++) {
    if (nodes[j].depth < depth) return false;
    if (nodes[j].depth === depth) return true;
  }
  return false;
}

/** Returns terminal art for a mermaid source, or null if it can't be drawn. */
export function renderDiagram(src: string, cols = process.stdout.columns ?? 100): string | null {
  const text = src.trim();
  if (/^mindmap\b/.test(text)) return mindmapTree(text);
  const attempt = (s: string) => {
    try {
      return renderMermaidASCII(s, { colorMode: color ? "ansi256" : "none", paddingY: 2, paddingX: 4 });
    } catch {
      return null;
    }
  };
  let out = attempt(text);
  // Too wide for this terminal? Flow top-down instead.
  if (out && widest(out) > cols - 4 && /^(flowchart|graph)\s+(LR|RL)/.test(text)) {
    out = attempt(text.replace(/^(flowchart|graph)\s+(LR|RL)/, "$1 TD")) ?? out;
  }
  return out && widest(out) <= cols - 4 ? out : null;
}

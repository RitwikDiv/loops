export interface ReadingChunk {
  text: string;
  animate: boolean;
}

type ReadingInput = Pick<NodeJS.ReadStream, "isTTY" | "isRaw" | "setRawMode" | "isPaused" | "resume" | "pause" | "on" | "off">;
type ReadingOutput = Pick<NodeJS.WriteStream, "isTTY" | "write">;

interface ReadingOptions {
  input?: ReadingInput;
  output?: ReadingOutput;
  delayMs?: number;
}

function configuredDelay(): number {
  const value = process.env.LOOPS_TYPE_DELAY?.trim();
  const delay = value ? Number(value) : NaN;
  return Number.isFinite(delay) && delay >= 0 ? delay : 30;
}

/** Write formatted prose gradually, without splitting ANSI styling or Unicode graphemes.
 * Returns false on Ctrl+C, after restoring the terminal for the caller to exit cleanly.
 */
export async function writeReading(chunks: ReadingChunk[], onStart: () => void = () => {}, options: ReadingOptions = {}): Promise<boolean> {
  const { input = process.stdin, output = process.stdout, delayMs = configuredDelay() } = options;
  if (!input.isTTY || !output.isTTY || delayMs <= 0 || !chunks.some((c) => c.animate && c.text.trim())) {
    output.write(chunks.map((c) => c.text).join(""));
    return true;
  }

  const wasRaw = !!input.isRaw;
  const wasPaused = input.isPaused();
  let paused = false;
  let skip = false;
  let cancelled = false;
  let wake: (() => void) | undefined;
  const wait = (ms?: number) => new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      wake = undefined;
      resolve();
    };
    const timer = ms === undefined ? undefined : setTimeout(finish, ms);
    wake = finish;
  });
  const onData = (data: Buffer | string) => {
    for (const key of data.toString()) {
      if (key === "\x03") cancelled = true;
      else if (key === "\r" || key === "\n") skip = true;
      else if (key === " ") paused = !paused;
    }
    wake?.();
  };
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  try {
    onStart();
    input.setRawMode(true);
    input.on("data", onData);
    input.resume();
    for (const chunk of chunks) {
      while (paused && !skip && !cancelled) await wait();
      if (cancelled) return false;
      if (!chunk.animate || skip) {
        output.write(chunk.text);
        continue;
      }
      // Terminal controls are atomic; ordinary text is emitted one visible character at a time.
      const tokens = [...chunk.text.matchAll(/\x1b\[[0-?]*[ -/]*[@-~]|[^\x1b]+|\x1b/g)].flatMap(([part]) =>
        part.startsWith("\x1b") ? [part] : Array.from(segmenter.segment(part), (s) => s.segment),
      );
      for (let i = 0; i < tokens.length; i++) {
        while (paused && !skip && !cancelled) await wait();
        if (cancelled) return false;
        if (skip) {
          output.write(tokens.slice(i).join(""));
          break;
        }
        const token = tokens[i];
        output.write(token);
        if (!token.startsWith("\x1b") && token.trim()) await wait(delayMs);
      }
    }
    return !cancelled;
  } finally {
    wake?.();
    input.off("data", onData);
    input.setRawMode(wasRaw);
    if (wasPaused) input.pause();
  }
}

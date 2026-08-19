/**
 * NEUTRAL TERMINAL I/O HELPERS (V2-020/Phase 8).
 *
 * WHY THEY LIVE HERE. `readPipedStdin` and `colorizeDiff` are pure presentation utilities — one
 * drains a piped stdin, the other paints a unified diff. Neither knows anything about a build
 * engine. They used to live in `modules/worker-model/cli.ts`, and because `ikbi repl` imported
 * them from there, the REPL's module graph transitively pulled in the ENTIRE v1 orchestrator: a
 * 6,600-line build engine loaded so that a diff could be coloured green.
 *
 * That was the last path from the interactive daily driver into the retired v1 build spine, and it
 * was incidental rather than intentional — the REPL never called the orchestrator. Moving these two
 * functions to a neutral CLI home severs it, so `ikbi repl` reaches no v1 build authority at all.
 *
 * PURE: no config, no identity, no engine. `colorizeDiff` never mutates the diff a model is shown —
 * colour is added only on the way to a human terminal.
 */

import { fstatSync } from "node:fs";

/**
 * Read piped stdin, or "" when stdin is a TTY / not a pipe.
 *
 * The `fstat(0)` gate is what makes this safe to call unconditionally: only a FIFO or regular-file
 * descriptor is drained, and both reach EOF on their own. An interactive terminal (or any other
 * descriptor kind) is left untouched, so this can never hang a session waiting for input.
 */
export function readPipedStdin(stdin: NodeJS.ReadStream = process.stdin): Promise<string> {
  return new Promise<string>((resolve) => {
    try {
      if (stdin.isTTY) return resolve("");
      const st = fstatSync(0);
      if (!st.isFIFO() && !st.isFile()) return resolve("");
    } catch {
      return resolve("");
    }
    let data = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (c) => (data += c));
    stdin.on("end", () => resolve(data));
    stdin.on("error", () => resolve(data));
  });
}

// Raw ANSI (no chalk dependency in the CLI context). Models never see this — the diff
// text handed to a model is the uncoloured original.
const ANSI = { green: "\x1b[32m", red: "\x1b[31m", dim: "\x1b[2m", reset: "\x1b[0m" } as const;

/** Colorize a unified diff for a human terminal: green added, red removed, dim hunk headers.
 *  File headers (`+++`/`---`) and context lines are left plain. PURE. */
export function colorizeDiff(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) return line; // file headers — plain
      if (line.startsWith("@@")) return `${ANSI.dim}${line}${ANSI.reset}`;
      if (line.startsWith("+")) return `${ANSI.green}${line}${ANSI.reset}`;
      if (line.startsWith("-")) return `${ANSI.red}${line}${ANSI.reset}`;
      return line;
    })
    .join("\n");
}

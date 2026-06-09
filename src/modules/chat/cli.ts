/**
 * ikbi chat — the `ikbi repl` interactive session command (HB-5).
 *
 * A persistent conversational coding session in the terminal, backed by the SAME
 * `ChatSession` the HTTP `/chat` endpoint uses — so it carries multi-turn history,
 * runs the full governed tool-calling loop, and is confined to a per-session worktree.
 *
 * `runRepl` is the testable core (a `readLine` source + an `out` sink, no terminal
 * dependency); `liveRepl` wires it to a readline interface over stdin and exits cleanly
 * on `/exit`, `/quit`, EOF (Ctrl-D), or SIGINT (Ctrl-C).
 */

import { createInterface } from "node:readline";

import { registerCommand } from "../../cli/registry.js";
import type { ChatMode, ChatToolActivity } from "./contract.js";
import { ChatSession, sessionStore } from "./session.js";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The minimal session surface the repl drives (one turn = one send). */
export interface ReplSession {
  send(userMessage: string, images?: readonly string[], mode?: ChatMode): Promise<{ response: string; tools: ChatToolActivity[] }>;
}

/** Injectable surfaces so the loop is testable without a terminal. */
export interface ReplDeps {
  readonly session: ReplSession;
  /** Read the next user line; resolves `null` at end-of-input (EOF / Ctrl-C / Ctrl-D). */
  readonly readLine: () => Promise<string | null>;
  readonly out: (s: string) => void;
  readonly prompt?: string;
}

/** Render a turn's tool activity as a compact one-liner (✗ marks a failed tool). */
function toolLine(tools: readonly ChatToolActivity[]): string {
  return `  · ${tools.map((t) => `${t.name}${t.ok ? "" : "✗"}`).join(", ")}\n`;
}

/**
 * Drive a conversational session: prompt → read → send → print, until `/exit`, `/quit`,
 * or end-of-input. Multi-turn history is the session's own (each `send` appends to it).
 */
export async function runRepl(deps: ReplDeps): Promise<void> {
  const prompt = deps.prompt ?? "ikbi› ";
  // Current turn mode — `/plan` switches to read-only analysis, `/agent` resumes execution.
  let mode: ChatMode = "agent";
  deps.out("ikbi repl — a conversational coding session. Type /plan for read-only planning, /exit (or Ctrl-C) to quit.\n");
  for (;;) {
    deps.out(prompt);
    const line = await deps.readLine();
    if (line === null) break; // EOF / Ctrl-C / Ctrl-D
    const msg = line.trim();
    if (msg.length === 0) continue;
    if (msg === "/exit" || msg === "/quit") break;
    if (msg === "/plan") {
      mode = "plan";
      deps.out("[plan mode: read-only analysis only — I will produce a plan, not make changes. Type /agent to resume execution.]\n");
      continue;
    }
    if (msg === "/agent") {
      mode = "agent";
      deps.out("[agent mode: full tool suite — changes will be applied.]\n");
      continue;
    }
    let res: { response: string; tools: ChatToolActivity[] };
    try {
      res = await deps.session.send(msg, undefined, mode);
    } catch (e) {
      deps.out(`[error: ${errMsg(e)}]\n`);
      continue;
    }
    if (res.tools.length > 0) deps.out(toolLine(res.tools));
    deps.out(`${res.response}\n`);
  }
  deps.out("\nsession ended.\n");
}

/** Bridge a readline interface to the `readLine()` pull model; resolves null on close/SIGINT. */
function readlineSource(): { readLine: () => Promise<string | null>; close: () => void } {
  const rl = createInterface({ input: process.stdin, terminal: process.stdin.isTTY === true });
  const queued: string[] = [];
  let pending: ((v: string | null) => void) | null = null;
  let done = false;
  const deliver = (v: string | null): void => {
    if (pending !== null) {
      const r = pending;
      pending = null;
      r(v);
    } else if (v !== null) {
      queued.push(v);
    }
  };
  rl.on("line", (l) => deliver(l));
  rl.on("close", () => {
    done = true;
    deliver(null);
  });
  // Ctrl-C: close the interface — `close` resolves the loop cleanly (no stack trace).
  rl.on("SIGINT", () => rl.close());
  const readLine = (): Promise<string | null> =>
    new Promise((resolve) => {
      if (queued.length > 0) return resolve(queued.shift() as string);
      if (done) return resolve(null);
      pending = resolve;
    });
  return { readLine, close: () => rl.close() };
}

/** The live `ikbi repl` command: a real ChatSession over stdin/stdout. */
export async function liveRepl(): Promise<void> {
  const session: ChatSession = sessionStore.getOrCreate();
  const src = readlineSource();
  try {
    await runRepl({ session, readLine: src.readLine, out: (s) => void process.stdout.write(s) });
  } finally {
    src.close();
  }
}

registerCommand({
  name: "repl",
  summary: "Start an interactive conversational session (multi-turn, tool-calling)",
  usage: "ikbi repl",
  run: () => liveRepl(),
});

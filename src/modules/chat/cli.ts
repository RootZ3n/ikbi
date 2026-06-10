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
 *
 * SLASH COMMANDS are a small REGISTRY (see `COMMANDS`): `/help`, `/status`, `/cost`,
 * `/model`, `/compact`, `/reset`, `/sessions`, `/label`, `/delete`, `/memory`, plus the
 * mode toggles `/plan` and `/agent` and the exits `/exit` / `/quit`. The REPL persists
 * each session to disk (via the injected store) so `--continue` / `--resume <id>` can
 * pick a conversation back up across restarts.
 */

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

import { registerCommand } from "../../cli/registry.js";
import { config } from "../../core/config.js";
import { colorizeDiff } from "../worker-model/cli.js";
import type { ChatMode, ChatToolActivity } from "./contract.js";
import { discoverProject, formatOverview } from "./project-discovery.js";
import { ChatSession, type PermissionMode, type PersistedSession, type RollbackResult, type TurnOptions } from "./session.js";
import { persistentStore, type PersistentSessionStore } from "./session-store.js";
import { defaultBinDir, installLauncher, launcherExists, setupInstructions } from "./shell-integration.js";
import { addInstruction, clearInstructions, editInstructions, instructionsPath, readInstructions } from "./user-memory.js";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The session surface the repl drives. `send` is the only hard requirement; the rest are
 *  optional so a lightweight fake (just `send`) still satisfies it for tests. */
export interface ReplSession {
  send(userMessage: string, images?: readonly string[], mode?: ChatMode, opts?: TurnOptions): Promise<{ response: string; tools: ChatToolActivity[]; cost?: number; contextPercent?: number }>;
  readonly id?: string;
  readonly worktree?: string;
  label?: string | undefined;
  contextPercent?(): number;
  messageCount?(): number;
  currentModel?(): string;
  setModel?(model: string): void;
  usage?(): { tokensIn: number; tokensOut: number; costUsd: number; cachedTokens?: number; cacheSavedUsd?: number };
  cacheHitPercent?(): number;
  rollback?(n: number): RollbackResult[];
  compact?(): Promise<{ before: number; after: number; compressed: boolean }>;
  toPersisted?(): PersistedSession;
}

/** Injectable surfaces so the loop is testable without a terminal. */
export interface ReplDeps {
  readonly session: ReplSession;
  /** Read the next user line; resolves `null` at end-of-input (EOF / Ctrl-C / Ctrl-D). */
  readonly readLine: () => Promise<string | null>;
  readonly out: (s: string) => void;
  readonly prompt?: string;
  /** Persistent store for `/sessions` / `/label` / `/delete` (and resume). Optional in tests. */
  readonly store?: PersistentSessionStore;
  /** Factory for a fresh session (`/reset`). Optional — when absent, `/reset` is unavailable. */
  readonly newSession?: () => ReplSession;
}

/** The mutable per-run state shared with every command handler. */
interface ReplContext {
  session: ReplSession;
  mode: ChatMode;
  /** Per-session permission level for mutating tools (FIX 5). */
  permissionMode: PermissionMode;
  exit: boolean;
  readonly out: (s: string) => void;
  readonly store: PersistentSessionStore | undefined;
  readonly newSession: (() => ReplSession) | undefined;
  /** Read ONE line and resolve true on an affirmative (y/yes) — used by `/reset`. */
  readonly confirm: () => Promise<boolean>;
  /** Read ONE line as a permission decision; default-YES ([Y/n]) — used by `/permissions confirm`. */
  readonly confirmTool: (tool: string, target: string) => Promise<boolean>;
}

/** A registered slash command. */
interface ReplCommand {
  readonly name: string;
  readonly description: string;
  readonly usage?: string;
  handler(ctx: ReplContext, args: string): Promise<void> | void;
}

/** Render a turn's tool activity as a compact one-liner (✗ marks a failed tool). */
function toolLine(tools: readonly ChatToolActivity[]): string {
  return `  · ${tools.map((t) => `${t.name}${t.ok ? "" : "✗"}`).join(", ")}\n`;
}

const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/** A spinner clears its line with `\r` + erase-to-end before the next write. */
const SPINNER_CLEAR = "\r\x1b[K";

/**
 * The context-usage bar shown after a turn, escalating its warning as the window fills. When
 * prompt caching is active (cachePct defined and > 0), a `cache: N%` segment is appended (FIX 7).
 */
function contextBar(pct: number | undefined, cachePct?: number): string {
  if (pct === undefined) return "";
  const cacheSeg = cachePct !== undefined && cachePct > 0 ? ` | cache: ${cachePct}%` : "";
  if (pct > 85) return `${RED}[ctx: ${pct}%${cacheSeg} — /compact recommended]${RESET}\n`;
  if (pct > 70) return `${YELLOW}[ctx: ${pct}%${cacheSeg} — consider /compact]${RESET}\n`;
  return `${DIM}[ctx: ${pct}%${cacheSeg}]${RESET}\n`;
}

/** Render any inline diffs carried on a turn's tool activity, colorized for the terminal (FIX 3). */
function renderToolDiffs(tools: readonly ChatToolActivity[], out: (s: string) => void): void {
  for (const t of tools) {
    if (t.diff !== undefined && t.diff.length > 0) {
      out(`${DIM}── ${t.name} ${t.summary ?? ""}${RESET}\n`);
      out(`${colorizeDiff(t.diff)}\n`);
    }
  }
}

/** Persist the current session through the store (no-op when the store/session can't be persisted). */
function persist(ctx: ReplContext): void {
  if (ctx.store === undefined) return;
  const s = ctx.session;
  if (typeof s.id === "string" && typeof s.toPersisted === "function") {
    ctx.store.save({ id: s.id, toPersisted: s.toPersisted.bind(s) });
  }
}

// ── the slash-command registry ────────────────────────────────────────────────

const COMMAND_LIST: readonly ReplCommand[] = [
  {
    name: "help",
    description: "Show all commands",
    handler: (ctx) => {
      ctx.out("Commands:\n");
      for (const c of COMMAND_LIST) {
        ctx.out(`  /${c.name}${c.usage !== undefined ? ` ${c.usage}` : ""} — ${c.description}\n`);
      }
    },
  },
  {
    name: "plan",
    description: "Switch to read-only PLAN mode (analyze, do not change)",
    handler: (ctx) => {
      ctx.mode = "plan";
      ctx.out("[plan mode: read-only analysis only — I will produce a plan, not make changes. Type /agent to resume execution.]\n");
    },
  },
  {
    name: "agent",
    description: "Switch to AGENT mode (full tool suite — changes applied)",
    handler: (ctx) => {
      ctx.mode = "agent";
      ctx.out("[agent mode: full tool suite — changes will be applied.]\n");
    },
  },
  {
    name: "status",
    description: "Show session info (id, worktree, messages, context, model, mode)",
    handler: (ctx) => {
      const s = ctx.session;
      ctx.out(`id:       ${s.id ?? "(in-memory)"}\n`);
      ctx.out(`worktree: ${s.worktree ?? "(n/a)"}\n`);
      if (s.label !== undefined && s.label.length > 0) ctx.out(`label:    ${s.label}\n`);
      ctx.out(`messages: ${s.messageCount !== undefined ? s.messageCount() : "?"}\n`);
      ctx.out(`context:  ${s.contextPercent !== undefined ? `${s.contextPercent()}%` : "?"}\n`);
      ctx.out(`model:    ${s.currentModel !== undefined ? s.currentModel() : "?"}\n`);
      ctx.out(`mode:     ${ctx.mode}\n`);
    },
  },
  {
    name: "cost",
    description: "Show token usage + estimated USD for the session",
    handler: (ctx) => {
      const u = ctx.session.usage?.();
      if (u === undefined) {
        ctx.out("[cost tracking unavailable for this session]\n");
        return;
      }
      ctx.out(`tokens — in: ${u.tokensIn}, out: ${u.tokensOut}, total: ${u.tokensIn + u.tokensOut}\n`);
      ctx.out(`estimated cost: $${u.costUsd.toFixed(4)}\n`);
      // Prompt-cache visibility (FIX 7): hit rate + estimated savings, when caching was active.
      const cached = u.cachedTokens ?? 0;
      if (cached > 0 && u.tokensIn > 0) {
        const rate = Math.round((cached / u.tokensIn) * 100);
        ctx.out(`Cache hit rate: ${rate}% (saved ~$${(u.cacheSavedUsd ?? 0).toFixed(2)})\n`);
      }
    },
  },
  {
    name: "model",
    description: "Show the current model, or switch to a different one",
    usage: "[name]",
    handler: (ctx, args) => {
      const name = args.trim();
      const dm = config.provider.defaultModels;
      if (name.length === 0) {
        ctx.out(`current model: ${ctx.session.currentModel !== undefined ? ctx.session.currentModel() : "?"}\n`);
        ctx.out(`configured defaults: driver=${dm.driver}, builder=${dm.builder}, critic=${dm.critic}\n`);
        // Available models to switch to (FIX 8): the configured defaults + any competitive list.
        const available = [...new Set([dm.driver, dm.builder, dm.critic, ...(dm.competitiveModels ?? [])])];
        ctx.out(`available: ${available.join(", ")}\n`);
        return;
      }
      if (ctx.session.setModel === undefined) {
        ctx.out("[model switching unavailable for this session]\n");
        return;
      }
      // Hot-swap (FIX 8): the message log is untouched, so context is preserved across the switch.
      const prev = ctx.session.currentModel !== undefined ? ctx.session.currentModel() : "?";
      ctx.session.setModel(name);
      ctx.out(`model switched to ${name} — context preserved (${prev} → ${name})\n`);
      persist(ctx);
    },
  },
  {
    name: "compact",
    description: "Compress the conversation to relieve context pressure",
    handler: async (ctx) => {
      if (ctx.session.compact === undefined) {
        ctx.out("[compaction unavailable for this session]\n");
        return;
      }
      const r = await ctx.session.compact();
      ctx.out(r.compressed ? `compacted: ${r.before} → ${r.after} messages\n` : `nothing to compact (${r.before} messages)\n`);
      persist(ctx);
    },
  },
  {
    name: "reset",
    description: "Start a fresh session (asks to confirm)",
    handler: async (ctx) => {
      if (ctx.newSession === undefined) {
        ctx.out("[reset unavailable in this context]\n");
        return;
      }
      ctx.out("Reset session? [y/N] ");
      if (!(await ctx.confirm())) {
        ctx.out("[reset cancelled]\n");
        return;
      }
      ctx.session = ctx.newSession();
      ctx.mode = "agent";
      ctx.out(`[new session started: ${ctx.session.id ?? "(in-memory)"}]\n`);
    },
  },
  {
    name: "sessions",
    description: "List persisted sessions (most recent first; * marks the current one)",
    handler: (ctx) => {
      if (ctx.store === undefined) {
        ctx.out("[no persistent store wired]\n");
        return;
      }
      const metas = ctx.store.list();
      if (metas.length === 0) {
        ctx.out("[no saved sessions]\n");
        return;
      }
      for (const m of metas) {
        const marker = m.id === ctx.session.id ? "*" : " ";
        const label = m.label !== undefined && m.label.length > 0 ? ` "${m.label}"` : "";
        ctx.out(`${marker} ${m.id}${label} — ${m.messageCount} msgs, worktree: ${m.worktree}, last used: ${new Date(m.lastUsedAt).toISOString()}\n`);
      }
    },
  },
  {
    name: "label",
    description: "Set a human-friendly label on the current session",
    usage: "<name>",
    handler: (ctx, args) => {
      const name = args.trim();
      if (name.length === 0) {
        ctx.out("[usage: /label <name>]\n");
        return;
      }
      ctx.session.label = name;
      persist(ctx);
      ctx.out(`[labelled current session: "${name}"]\n`);
    },
  },
  {
    name: "delete",
    description: "Delete a persisted session by id",
    usage: "<id>",
    handler: (ctx, args) => {
      const id = args.trim();
      if (ctx.store === undefined) {
        ctx.out("[no persistent store wired]\n");
        return;
      }
      if (id.length === 0) {
        ctx.out("[usage: /delete <id>]\n");
        return;
      }
      ctx.out(ctx.store.delete(id) ? `[deleted session ${id}]\n` : `[no session found: ${id}]\n`);
    },
  },
  {
    name: "memory",
    description: "Show / edit your persistent standing instructions",
    usage: "[add <text> | edit | clear]",
    handler: (ctx, args) => {
      const trimmed = args.trim();
      const sub = trimmed.split(/\s+/)[0] ?? "";
      const rest = trimmed.slice(sub.length).trim();
      if (sub === "" || sub === "show") {
        const body = readInstructions();
        ctx.out(body.trim().length > 0 ? `Standing instructions (${instructionsPath()}):\n${body}\n` : "[no standing instructions yet — add one with /memory add <text>]\n");
        return;
      }
      if (sub === "add") {
        if (rest.length === 0) {
          ctx.out("[usage: /memory add <text>]\n");
          return;
        }
        addInstruction(rest);
        ctx.out(`[added instruction — applies on the NEXT new session]\n`);
        return;
      }
      if (sub === "clear") {
        clearInstructions();
        ctx.out("[standing instructions cleared]\n");
        return;
      }
      if (sub === "edit") {
        ctx.out(editInstructions() ? "[instructions saved — applies on the NEXT new session]\n" : "[editor exited non-zero; no changes assumed]\n");
        return;
      }
      ctx.out(`[unknown /memory subcommand: ${sub} — use show | add <text> | edit | clear]\n`);
    },
  },
  {
    name: "rollback",
    description: "Undo the last N file changes made this session (default 1)",
    usage: "[N]",
    handler: (ctx, args) => {
      if (ctx.session.rollback === undefined) {
        ctx.out("[rollback unavailable for this session]\n");
        return;
      }
      const parsed = Number.parseInt(args.trim(), 10);
      const n = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
      const results = ctx.session.rollback(n);
      if (results.length === 0) {
        ctx.out("[nothing to roll back]\n");
        return;
      }
      for (const r of results) ctx.out(`Rolled back: ${r.tool} ${r.path} (${r.action})\n`);
      persist(ctx);
    },
  },
  {
    name: "permissions",
    description: "Show or set the tool permission mode (auto | confirm | readonly)",
    usage: "[auto|confirm|readonly]",
    handler: (ctx, args) => {
      const m = args.trim();
      if (m.length === 0) {
        ctx.out(`permission mode: ${ctx.permissionMode}\n`);
        ctx.out("  auto     — approve all tool calls (default)\n  confirm  — ask before write_file / patch / terminal / delegate_task\n  readonly — block all mutating tools\n");
        return;
      }
      if (m !== "auto" && m !== "confirm" && m !== "readonly") {
        ctx.out("[usage: /permissions auto|confirm|readonly]\n");
        return;
      }
      ctx.permissionMode = m;
      ctx.out(`permission mode set to ${m}\n`);
    },
  },
];

/** Name → command lookup, plus the `quit` alias for `exit` (both handled inline in the loop). */
const COMMANDS: ReadonlyMap<string, ReplCommand> = new Map(COMMAND_LIST.map((c) => [c.name, c]));

/**
 * Drive a conversational session: prompt → read → send → print, until `/exit`, `/quit`,
 * or end-of-input. Multi-turn history is the session's own (each `send` appends to it).
 */
export async function runRepl(deps: ReplDeps): Promise<void> {
  const prompt = deps.prompt ?? "ikbi› ";
  // A one-line reader for confirmation prompts (consumes a line from the same source).
  const confirm = async (): Promise<boolean> => {
    const line = await deps.readLine();
    if (line === null) return false;
    return /^\s*y(es)?\s*$/i.test(line);
  };
  // Permission prompt (FIX 5): "[Y/n]" defaults to YES — only an explicit no/n declines.
  const confirmTool = async (tool: string, target: string): Promise<boolean> => {
    deps.out(`Allow ${tool}${target.length > 0 ? ` ${target}` : ""}? [Y/n] `);
    const line = await deps.readLine();
    if (line === null) return false;
    return !/^\s*n(o)?\s*$/i.test(line);
  };
  const ctx: ReplContext = {
    session: deps.session,
    mode: "agent",
    permissionMode: "auto",
    exit: false,
    out: deps.out,
    store: deps.store,
    newSession: deps.newSession,
    confirm,
    confirmTool,
  };
  deps.out("ikbi repl — a conversational coding session. Type /help for commands, /plan for read-only planning, /exit (or Ctrl-C) to quit.\n");
  for (;;) {
    deps.out(prompt);
    const line = await deps.readLine();
    if (line === null) break; // EOF / Ctrl-C / Ctrl-D
    const msg = line.trim();
    if (msg.length === 0) continue;
    if (msg === "/exit" || msg === "/quit") break;
    if (msg.startsWith("/")) {
      const name = msg.slice(1).split(/\s+/)[0] ?? "";
      const args = msg.slice(1 + name.length).trim();
      const cmd = COMMANDS.get(name);
      if (cmd === undefined) {
        deps.out(`[unknown command: /${name} — type /help for the list]\n`);
        continue;
      }
      try {
        await cmd.handler(ctx, args);
      } catch (e) {
        deps.out(`[command error: ${errMsg(e)}]\n`);
      }
      if (ctx.exit) break;
      continue;
    }
    let res: { response: string; tools: ChatToolActivity[]; contextPercent?: number };
    // PROGRESS (FIX 4): a `\r`-overwriting spinner line while the (async) turn runs.
    const onProgress = (phase: string): void => deps.out(`${SPINNER_CLEAR}${DIM}⟳ ${phase}${RESET}`);
    const turnOpts: TurnOptions = { onProgress, permissionMode: ctx.permissionMode, confirm: ctx.confirmTool };
    try {
      res = await ctx.session.send(msg, undefined, ctx.mode, turnOpts);
    } catch (e) {
      deps.out(`${SPINNER_CLEAR}[error: ${errMsg(e)}]\n`);
      continue;
    }
    deps.out(SPINNER_CLEAR); // clear the spinner line before printing the result
    if (res.tools.length > 0) deps.out(toolLine(res.tools));
    renderToolDiffs(res.tools, deps.out); // FIX 3: colorized inline diffs for file mutations
    deps.out(`${res.response}\n`);
    // Cache-hit segment for the context bar (FIX 7), when caching is active this session.
    const u = ctx.session.usage?.();
    const cachePct = ctx.session.cacheHitPercent?.() ?? (u !== undefined && (u.cachedTokens ?? 0) > 0 && u.tokensIn > 0 ? Math.round(((u.cachedTokens ?? 0) / u.tokensIn) * 100) : undefined);
    deps.out(contextBar(res.contextPercent, cachePct));
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

/**
 * The live `ikbi repl` command: a real ChatSession over stdin/stdout, persisted to disk.
 * Flags: `--continue` (resume the most-recent session) or `--resume <id>` (a specific one).
 */
export async function liveRepl(argv: readonly string[] = []): Promise<void> {
  const out = (s: string): void => void process.stdout.write(s);
  const store = persistentStore;
  const autosave = (s: ChatSession): void => store.save(s);
  const newSession = (): ChatSession => new ChatSession(randomUUID(), { autosave });

  let session: ChatSession;
  const resumeIdx = argv.indexOf("--resume");
  const wantContinue = argv.includes("--continue") || argv.includes("-c");
  if (resumeIdx >= 0) {
    const id = argv[resumeIdx + 1];
    const loaded = id !== undefined ? store.load(id, { autosave }) : undefined;
    if (loaded === undefined) {
      out(`[no session found for --resume ${id ?? "(missing id)"}]\n`);
      return;
    }
    session = loaded;
    out(`Resumed session ${session.id} (${session.messageCount()} messages, worktree: ${session.worktree})\n`);
  } else if (wantContinue) {
    const latest = store.latest({ autosave });
    if (latest === undefined) {
      out("[no prior session to continue — starting fresh]\n");
      session = newSession();
    } else {
      session = latest;
      out(`Resumed session ${session.id} (${session.messageCount()} messages, worktree: ${session.worktree})\n`);
    }
  } else {
    session = newSession();
  }

  // PROJECT AUTO-DISCOVERY (FIX 2): a one-line overview of the worktree at startup.
  try {
    out(formatOverview(discoverProject(session.worktree)));
  } catch {
    // Discovery is best-effort cosmetics — never let it block the session.
  }

  const src = readlineSource();
  try {
    await runRepl({ session, store, newSession, readLine: src.readLine, out });
  } finally {
    src.close();
  }
}

registerCommand({
  name: "repl",
  summary: "Start an interactive conversational session (multi-turn, tool-calling)",
  usage: "ikbi repl [--continue | --resume <id>]",
  run: (argv) => liveRepl(argv),
});

/**
 * `ikbi setup` (FIX 6) — install a global `ikbi` launcher so the CLI runs from any directory.
 * Writes an executable wrapper to ~/.local/bin/ikbi (the SHELL INTEGRATION seam) and prints
 * whatever PATH step (if any) remains. Idempotent — re-running just refreshes the launcher.
 */
registerCommand({
  name: "setup",
  summary: "Install a global `ikbi` launcher (shell integration) so `ikbi` works from anywhere",
  usage: "ikbi setup",
  run: () => {
    const out = (s: string): void => void process.stdout.write(s);
    if (launcherExists()) out(`(refreshing existing launcher in ${defaultBinDir()})\n`);
    try {
      const install = installLauncher();
      out(setupInstructions(install));
    } catch (e) {
      out(`[setup failed: ${errMsg(e)}]\nManually create an executable ~/.local/bin/ikbi that execs this repo's CLI.\n`);
    }
  },
});

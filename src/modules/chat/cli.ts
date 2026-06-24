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
import { translateError, formatFriendlyError } from "../../core/errors/index.js";
import { createContextManager } from "../../core/context/index.js";
import { registry, invokeModelStream } from "../../core/provider/index.js";
import { colorizeDiff, readPipedStdin } from "../worker-model/cli.js";
import type { ChatMode, ChatToolActivity } from "./contract.js";
import { discoverProject, formatOverview } from "./project-discovery.js";
import { detectLiveProject, summarize } from "../project-detection/index.js";
import { whatNext } from "../../cli/what-next.js";
import { ChatSession, type ApplyResult, type DiscardOutcome, type PermissionMode, type PersistedSession, type RollbackResult, type StreamEvent, type TurnOptions, type WorkdirKind } from "./session.js";
import { formatAskPrompt, type AskUserRequest } from "../cognition-layer/ask.js";
import { findCustomAgent, loadCustomAgents, type CustomAgent } from "../agent-router/agent-directory.js";
import { allocateSessionWorkspace, reconnectSessionWorkspace, resolveRepoTarget } from "./repl-workspace.js";
import { persistentStore, PersistentSessionStore, sessionsDir } from "./session-store.js";
import { createProductionGovernor } from "../memory-governor/create.js";
import { gbrainBridge } from "../../core/gbrain-bridge.js";
import { defaultBinDir, installLauncher, launcherExists, setupInstructions } from "./shell-integration.js";
import { addInstruction, clearInstructions, editInstructions, instructionsPath, readInstructions } from "./user-memory.js";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The session surface the repl drives. `send` is the only hard requirement; the rest are
 *  optional so a lightweight fake (just `send`) still satisfies it for tests. */
export interface ReplSession {
  send(userMessage: string, images?: readonly string[], mode?: ChatMode, opts?: TurnOptions): Promise<{ response: string; tools: ChatToolActivity[]; cost?: number; contextPercent?: number }>;
  /** Streaming variant: yields content deltas for live display, returns the final turn summary.
   *  Optional — when absent the REPL falls back to the request/response `send`. */
  sendStream?(userMessage: string, images?: readonly string[], mode?: ChatMode, opts?: TurnOptions): AsyncGenerator<StreamEvent, { response: string; tools: ChatToolActivity[]; cost?: number; contextPercent?: number }, void>;
  readonly id?: string;
  readonly worktree?: string;
  readonly workdirKind?: WorkdirKind;
  readonly workdirWarning?: string | undefined;
  label?: string | undefined;
  contextPercent?(): number;
  messageCount?(): number;
  currentModel?(): string;
  setModel?(model: string): void;
  currentPermissionMode?(): PermissionMode;
  setPermissionMode?(mode: PermissionMode): void;
  /** Custom agent persona (`/agent <name>`). Optional so a lightweight fake still satisfies ReplSession. */
  currentPersona?(): CustomAgent | undefined;
  setPersona?(persona: CustomAgent | undefined): void;
  pendingDiff?(): string;
  // Managed-workspace lifecycle (Phase 2). Optional so a lightweight fake still satisfies ReplSession.
  isManaged?(): boolean;
  pendingChangeCount?(): number;
  getDiff?(): Promise<string>;
  apply?(message?: string): Promise<ApplyResult>;
  discardWorkspace?(): Promise<DiscardOutcome>;
  readonly workspaceId?: string | undefined;
  readonly targetRepo?: string | undefined;
  readonly baseBranch?: string | undefined;
  readonly baseRef?: string | undefined;
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
  /** Factory for a fresh session (`/reset`). May be async (managed-workspace allocation). Optional. */
  readonly newSession?: () => ReplSession | Promise<ReplSession>;
  /** Optional hook used by the live readline adapter to abort an in-flight turn on Ctrl-C. */
  readonly onTurnController?: (controller: AbortController | undefined) => void;
  /** When true, suppress tool activity and only show the model's response (--quiet). */
  readonly quiet?: boolean;
  /** When true, append the raw technical detail (+stack) to friendly error messages (--verbose). */
  readonly verbose?: boolean;
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
  readonly newSession: (() => ReplSession | Promise<ReplSession>) | undefined;
  /** When true, suppress tool activity and only show the model's response text. */
  readonly quiet: boolean;
  /** When true, append raw technical detail to friendly error messages. */
  readonly verbose: boolean;
  /** Read ONE line and resolve true on an affirmative (y/yes) — used by `/reset`. */
  readonly confirm: () => Promise<boolean>;
  /** Read ONE line as a permission decision; default-NO ([y/N]) — used by `/permissions confirm`. */
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
/** Human-readable tool names for the activity summary line (beginner-friendly). */
const TOOL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  read_file: "Read files",
  list_dir: "Listed dirs",
  search_files: "Searched code",
  glob: "Found files",
  write_file: "Wrote files",
  patch: "Edited files",
  multi_edit: "Edited files",
  terminal: "Ran commands",
  git_status: "Git status",
  git_diff: "Git diff",
  git_log: "Git log",
  web_search: "Web search",
  web_extract: "Read web",
  delegate_task: "Delegated",
  vision_analyze: "Analyzed image",
  run_checks: "Ran checks",
  scout_detail: "Scout detail",
  done: "Checkpoint",
  mcp: "MCP tool",
};

function toolLine(tools: readonly ChatToolActivity[]): string {
  const names = tools.map((t) => {
    const display = TOOL_DISPLAY_NAMES[t.name] ?? t.name;
    return `${display}${t.ok ? "" : "✗"}`;
  });
  // Deduplicate: "Read files (×3)" instead of "Read files, Read files, Read files"
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const deduped = [...counts.entries()].map(([n, c]) => c > 1 ? `${n} (×${c})` : n);
  return `  · ${deduped.join(", ")}\n`;
}

/**
 * Render a verified `/apply` result (req 3): the verification mode + scope, the checks that ran,
 * and the failure/triage summary when it did not pass — followed by the apply headline.
 */
async function renderApply(ctx: ReplContext, r: ApplyResult): Promise<void> {
  const v = r.verification;
  if (v !== undefined) {
    ctx.out(`verification: ${v.ok ? "PASS" : v.blocked ? "BLOCKED" : v.outcome === "unavailable" ? "UNAVAILABLE" : "FAIL"} — mode=${v.mode}${v.scope !== undefined ? `, scope=${v.scope}` : ""}\n`);
    if (v.checks.length > 0) ctx.out(`  checks: ${v.checks.map((c) => `${c.name} ${c.ok ? "✓" : "✗"}`).join(", ")}\n`);
    if (!v.ok && v.blocked && v.blockReasons !== undefined && v.blockReasons.length > 0) ctx.out(`  blocked: ${v.blockReasons.join("; ")}\n`);
    if (!v.ok && v.triageSummary !== undefined) ctx.out(`  failure: ${v.triageSummary}\n`);
  }
  ctx.out(`${r.applied ? "✓ " : ""}${r.summary}\n`);
  await persist(ctx);
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

/** Persist the current session through the store (no-op when the store/session can't be persisted).
 *  A session-lock conflict (BLOCKER-2) is reported to the operator rather than crashing the REPL. */
async function persist(ctx: ReplContext): Promise<void> {
  if (ctx.store === undefined) return;
  const s = ctx.session;
  if (typeof s.id === "string" && typeof s.toPersisted === "function") {
    try {
      await ctx.store.save({ id: s.id, toPersisted: s.toPersisted.bind(s) });
    } catch (e) {
      ctx.out(`[save blocked] ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
}

function availableModels(): string[] {
  const configured = config.provider.defaultModels;
  return [...new Set([configured.driver, configured.builder, configured.critic, ...(configured.competitiveModels ?? []), ...registry.listModels().map((m) => m.id)])].sort();
}

function isUsableModel(id: string): boolean {
  const model = registry.getModel(id);
  if (model === undefined) return false;
  return model.providers.some((route) => registry.getProvider(route.provider) !== undefined);
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
    description: "Switch to AGENT mode, or adopt a custom persona: /agent [<name> | list | default]",
    usage: "/agent [<name> | list | default]",
    handler: (ctx, args) => {
      const arg = args.trim();
      const repoRoot = ctx.session.targetRepo ?? ctx.session.worktree ?? process.cwd();
      // No argument → the classic behavior: just (re)enter execution mode.
      if (arg.length === 0) {
        ctx.mode = "agent";
        const active = ctx.session.currentPersona?.();
        ctx.out(`[agent mode: full tool suite — changes will be applied.${active !== undefined ? ` persona: ${active.name}` : ""}]\n`);
        return;
      }
      if (arg === "list") {
        const { agents, dir } = loadCustomAgents(repoRoot);
        if (agents.length === 0) ctx.out(`[no custom agents in ${dir} — define one as .ikbi/agents/<name>.yaml]\n`);
        else ctx.out(`[custom agents: ${agents.map((a) => a.name).join(", ")} — switch with /agent <name>]\n`);
        return;
      }
      if (ctx.session.setPersona === undefined) {
        ctx.out("[this session does not support custom personas]\n");
        return;
      }
      if (arg === "default" || arg === "none") {
        ctx.session.setPersona(undefined);
        ctx.mode = "agent";
        ctx.out("[persona cleared — default assistant, agent mode]\n");
        return;
      }
      const agent = findCustomAgent(repoRoot, arg);
      if (agent === undefined) {
        ctx.out(`[no agent named "${arg}" — run /agent list or 'ikbi agents' to see options]\n`);
        return;
      }
      ctx.session.setPersona(agent);
      ctx.mode = "agent";
      const tools = agent.allowedTools !== undefined && agent.allowedTools.length > 0 ? `${agent.allowedTools.length} tool(s)` : "all tools";
      const model = agent.modelPreference !== undefined ? `, model ${agent.modelPreference}` : "";
      ctx.out(`[persona "${agent.name}" active (${tools}${model}) — agent mode]\n`);
    },
  },
  {
    name: "status",
    description: "Show session info (id, target repo, workspace, base ref, pending changes, lifecycle)",
    handler: (ctx) => {
      const s = ctx.session;
      const managed = s.isManaged?.() === true || s.workdirKind === "managed";
      ctx.out(`id:           ${s.id ?? "(in-memory)"}\n`);
      // Lifecycle mode FIRST — the most important truth about what editing this session does.
      const modeLabel =
        s.workdirKind === "managed" ? (managed ? "managed-workspace (promotable via /apply)" : "managed-workspace (UNAVAILABLE — workspace gone)")
        : s.workdirKind === "scratch" ? "scratch (NON-PROMOTABLE — copy out manually)"
        : s.workdirKind === "explicit" ? "explicit (live-direct edits to IKBI_CHAT_WORKDIR)"
        : "repo (live-direct edits)";
      ctx.out(`lifecycle:    ${modeLabel}\n`);
      ctx.out(`target repo:  ${s.targetRepo ?? "(none — not a managed session)"}\n`);
      ctx.out(`workspace:    ${s.worktree ?? "(n/a)"}\n`);
      ctx.out(`base ref:     ${s.baseRef !== undefined ? `${s.baseRef.slice(0, 12)} (${s.baseBranch ?? "?"})` : "(n/a)"}\n`);
      ctx.out(`pending:      ${s.pendingChangeCount !== undefined ? `${s.pendingChangeCount()} file(s) changed` : "?"}\n`);
      if (s.workdirWarning !== undefined) ctx.out(`warning:      ${s.workdirWarning}\n`);
      if (s.label !== undefined && s.label.length > 0) ctx.out(`label:        ${s.label}\n`);
      ctx.out(`messages:     ${s.messageCount !== undefined ? s.messageCount() : "?"}\n`);
      ctx.out(`context:      ${s.contextPercent !== undefined ? `${s.contextPercent()}%` : "?"}\n`);
      ctx.out(`model:        ${s.currentModel !== undefined ? s.currentModel() : "?"}\n`);
      ctx.out(`mode:         ${ctx.mode}\n`);
      ctx.out(`permissions:  ${ctx.permissionMode}\n`);
      // Verification truth (Phase 3): managed /apply runs ladder verification BEFORE the governed
      // promote; scratch/live-direct cannot apply at all.
      ctx.out(
        managed
          ? "note:         managed edits are in a separate workspace; /apply runs ladder verification, then promotes ONLY on a pass.\n"
          : "note:         rollback covers tracked file edits only (not terminal/sub-agent side effects).\n",
      );
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
    handler: async (ctx, args) => {
      const name = args.trim();
      const dm = config.provider.defaultModels;
      if (name.length === 0) {
        ctx.out(`current model: ${ctx.session.currentModel !== undefined ? ctx.session.currentModel() : "?"}\n`);
        ctx.out(`configured defaults: driver=${dm.driver}, builder=${dm.builder}, critic=${dm.critic}\n`);
        // Available models to switch to (FIX 8): the configured defaults + any competitive list.
        const available = availableModels();
        ctx.out(`available: ${available.join(", ")}\n`);
        return;
      }
      if (ctx.session.setModel === undefined) {
        ctx.out("[model switching unavailable for this session]\n");
        return;
      }
      if (!isUsableModel(name)) {
        ctx.out(`[model unavailable: ${name}]\n`);
        ctx.out(`available: ${availableModels().join(", ")}\n`);
        return;
      }
      // Hot-swap (FIX 8): the message log is untouched, so context is preserved across the switch.
      const prev = ctx.session.currentModel !== undefined ? ctx.session.currentModel() : "?";
      ctx.session.setModel(name);
      ctx.out(`model switched to ${name} — context preserved (${prev} → ${name})\n`);
      await persist(ctx);
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
      await persist(ctx);
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
      ctx.session = await ctx.newSession();
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
    handler: async (ctx, args) => {
      const name = args.trim();
      if (name.length === 0) {
        ctx.out("[usage: /label <name>]\n");
        return;
      }
      ctx.session.label = name;
      await persist(ctx);
      ctx.out(`[labelled current session: "${name}"]\n`);
    },
  },
  {
    name: "delete",
    description: "Delete a persisted session by id",
    usage: "<id>",
    handler: async (ctx, args) => {
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
    name: "diff",
    description: "Show pending changes (managed: workspace vs target base; else git diff of the workdir)",
    handler: async (ctx) => {
      const diff = ctx.session.getDiff !== undefined ? await ctx.session.getDiff() : ctx.session.pendingDiff?.();
      ctx.out(diff !== undefined && diff.trim().length > 0 ? `${colorizeDiff(diff)}\n` : "[no pending changes]\n");
    },
  },
  {
    name: "apply",
    description: "Verify (ladder) then apply this session's changes to the target repo (managed only)",
    usage: "[commit message]",
    handler: async (ctx, args) => {
      if (ctx.session.apply === undefined) {
        ctx.out("[apply unavailable for this session]\n");
        return;
      }
      await renderApply(ctx, await ctx.session.apply(args.trim().length > 0 ? args.trim() : undefined));
    },
  },
  {
    name: "promote",
    description: "Alias for /apply",
    handler: async (ctx, args) => {
      if (ctx.session.apply === undefined) {
        ctx.out("[apply unavailable for this session]\n");
        return;
      }
      await renderApply(ctx, await ctx.session.apply(args.trim().length > 0 ? args.trim() : undefined));
    },
  },
  {
    name: "discard",
    description: "Managed: remove the workspace (target untouched). Else: roll back tracked file edits.",
    handler: async (ctx) => {
      if (ctx.session.discardWorkspace === undefined) {
        ctx.out("[discard unavailable for this session]\n");
        return;
      }
      const r = await ctx.session.discardWorkspace();
      if (r.mode === "rollback") {
        const reverted = r.reverted ?? [];
        if (reverted.length === 0) {
          ctx.out("[nothing to discard]\n");
          return;
        }
        for (const m of reverted) ctx.out(`Discarded: ${m.tool} ${m.path} (${m.action})\n`);
        ctx.out("[note: terminal and sub-agent mutations require explicit approval and are not tracked by discard]\n");
      } else {
        ctx.out(`${r.summary}\n`);
      }
      await persist(ctx);
    },
  },
  {
    name: "memory",
    description: "Show / edit your persistent standing instructions",
    usage: "[add <text> | edit | clear]",
    handler: async (ctx, args) => {
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
    handler: async (ctx, args) => {
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
      // M4: rollback only tracks write_file/patch edits. Files touched by `terminal` (e.g. a shell
      // redirect) or by a `delegate_task` sub-agent are NOT recorded, so they are NOT undone here.
      ctx.out("[note: terminal and sub-agent mutations are not tracked and were not rolled back]\n");
      await persist(ctx);
    },
  },
  {
    name: "permissions",
    description: "Show or set the tool permission mode (auto | confirm | readonly)",
    usage: "[auto|confirm|readonly]",
    handler: async (ctx, args) => {
      const m = args.trim();
      if (m.length === 0) {
        ctx.out(`permission mode: ${ctx.permissionMode}\n`);
        ctx.out("  confirm  — ask before write_file / patch / terminal / delegate_task (default)\n  auto     — approve file/check/web tools; terminal/delegate still ask\n  readonly — block all mutating tools\n");
        return;
      }
      if (m !== "auto" && m !== "confirm" && m !== "readonly") {
        ctx.out("[usage: /permissions auto|confirm|readonly]\n");
        return;
      }
      ctx.permissionMode = m;
      ctx.session.setPermissionMode?.(m);
      await persist(ctx);
      ctx.out(`permission mode set to ${m}\n`);
    },
  },
];

/** Name → command lookup, plus the `quit` alias for `exit` (both handled inline in the loop). */
const COMMANDS: ReadonlyMap<string, ReplCommand> = new Map(COMMAND_LIST.map((c) => [c.name, c]));

/** The turn summary shape both `send` and `sendStream` resolve/return. */
type TurnResult = { response: string; tools: ChatToolActivity[]; cost?: number; contextPercent?: number };

/**
 * Drive ONE streamed turn: consume the session's `sendStream` generator, writing assistant content
 * to the terminal token-by-token as it arrives. Manages the transient spinner line so progress
 * updates (between tool rounds) never clobber already-printed prose. Returns the final turn summary
 * plus whether any prose was streamed (so the caller knows not to re-print `response`).
 */
async function streamTurn(
  session: ReplSession,
  msg: string,
  mode: ChatMode,
  turnOpts: Omit<TurnOptions, "onProgress">,
  out: (s: string) => void,
  quiet: boolean = false,
): Promise<{ res: TurnResult; streamedProse: boolean }> {
  let spinnerShowing = false;
  let midLine = false; // prose was written without a trailing newline
  let printedAny = false;
  // In `--quiet` the spinner is status chatter — skip it so only model prose reaches stdout.
  const onProgress = quiet ? undefined : (phase: string): void => {
    // Move off any partial prose line first so the spinner's `\r` erase can't eat streamed text.
    if (midLine) { out("\n"); midLine = false; }
    out(`${SPINNER_CLEAR}${DIM}⟳ ${phase}${RESET}`);
    spinnerShowing = true;
  };
  const writeContent = (s: string): void => {
    if (s.length === 0) return;
    if (spinnerShowing) { out(SPINNER_CLEAR); spinnerShowing = false; }
    out(s);
    printedAny = true;
    midLine = !s.endsWith("\n");
  };
  const gen = session.sendStream!(msg, undefined, mode, { ...turnOpts, ...(onProgress ? { onProgress } : {}) });
  let res: TurnResult;
  for (;;) {
    const next = await gen.next();
    if (next.done === true) { res = next.value; break; }
    writeContent(next.value.delta.content ?? "");
  }
  if (spinnerShowing) out(SPINNER_CLEAR);
  if (midLine) out("\n");
  return { res, streamedProse: printedAny };
}

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
  // Permission prompt: "[y/N]" defaults to NO — only an explicit yes/y allows.
  const confirmTool = async (tool: string, target: string): Promise<boolean> => {
    deps.out(`Allow ${tool}${target.length > 0 ? ` ${target}` : ""}? [y/N] `);
    const line = await deps.readLine();
    if (line === null) return false;
    return /^\s*y(es)?\s*$/i.test(line);
  };
  // ask_user channel: render the question (+ options) and consume one line from the same input.
  const askUser = async (req: AskUserRequest): Promise<string> => {
    deps.out(formatAskPrompt(req));
    const line = await deps.readLine();
    return line === null ? "" : line.trim();
  };
  const ctx: ReplContext = {
    session: deps.session,
    mode: "agent",
    permissionMode: deps.session.currentPermissionMode?.() ?? "confirm",
    exit: false,
    out: deps.out,
    store: deps.store,
    newSession: deps.newSession,
    confirm,
    confirmTool,
    quiet: deps.quiet ?? false,
    verbose: deps.verbose ?? false,
  };
  // `--quiet` ⇒ model-output-only: route the banner/workdir/prompt/tool/context chatter through
  // `say` (a no-op when quiet), leaving only the model's prose on `deps.out`.
  const say = (s: string): void => { if (!ctx.quiet) deps.out(s); };
  say(`ikbi repl — a conversational coding session. Type /help for commands, /plan for read-only planning, /exit (or Ctrl-C) to quit.\n`);
  if (deps.session.workdirWarning !== undefined) say(`[workdir warning] ${deps.session.workdirWarning}\n`);
  if (deps.session.workdirKind !== undefined && deps.session.worktree !== undefined) {
    const kind = deps.session.workdirKind;
    const descr =
      kind === "managed" ? `managed workspace off ${deps.session.targetRepo ?? "the repo"} — separate from the target until /apply; /discard drops it`
      : kind === "scratch" ? "scratch (non-promotable)"
      : "live-direct edits";
    say(`[workdir: ${deps.session.worktree} — ${descr}]\n`);
  }
  // PROJECT TYPE + suggested actions (REPL FIX): a one-line, marker-based read of the target
  // repo (language/framework/tooling) plus a couple of next steps, so a first-time user lands
  // with orientation instead of a bare prompt. Best-effort and offline — a detection failure is
  // swallowed (never let it wedge the prompt). Suppressed under --quiet like the rest of the banner.
  if (!ctx.quiet) {
    try {
      const root = deps.session.targetRepo ?? deps.session.worktree ?? process.cwd();
      const detected = detectLiveProject(root);
      if (detected.primaryLanguage !== undefined) {
        say(`[project: ${summarize(detected)}]\n`);
        const tips = whatNext("detect").slice(0, 3);
        for (const t of tips) say(`  → ${t}\n`);
      }
    } catch { /* detection is best-effort — never block startup on it */ }
  }
  for (;;) {
    say(prompt);
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
    let res: TurnResult;
    // STREAMING: when the session supports it, print the reply token-by-token as it arrives (the
    // clearest "this is responsive" signal). Otherwise fall back to request/response + spinner.
    let streamedProse = false;
    // PROGRESS (FIX 4): a `\r`-overwriting spinner line while the (async) turn runs (skipped in --quiet).
    const controller = new AbortController();
    deps.onTurnController?.(controller);
    const baseOpts = { signal: controller.signal, permissionMode: ctx.permissionMode, confirm: ctx.confirmTool, ask: askUser } as const;
    try {
      if (typeof ctx.session.sendStream === "function") {
        const streamed = await streamTurn(ctx.session, msg, ctx.mode, baseOpts, deps.out, ctx.quiet);
        res = streamed.res;
        streamedProse = streamed.streamedProse;
      } else {
        // Progress spinner is status chatter — suppressed in quiet mode.
        const onProgress = ctx.quiet ? undefined : (phase: string): void => deps.out(`${SPINNER_CLEAR}${DIM}⟳ ${phase}${RESET}`);
        res = await ctx.session.send(msg, undefined, ctx.mode, { ...baseOpts, ...(onProgress ? { onProgress } : {}) });
        say(SPINNER_CLEAR); // clear the spinner line before printing the result
      }
    } catch (e) {
      // A user-initiated Ctrl-C abort is not a failure — acknowledge it plainly, no friendly
      // "something went wrong" wrapping.
      if (controller.signal.aborted) {
        deps.out(`${SPINNER_CLEAR}[interrupted]\n`);
        continue;
      }
      // Everything else is mapped to a friendly message (raw stack only under --verbose).
      const fe = translateError(e);
      const stack = e instanceof Error ? e.stack : undefined;
      deps.out(`${SPINNER_CLEAR}${formatFriendlyError(fe, { verbose: ctx.verbose, ...(stack !== undefined ? { stack } : {}) })}\n`);
      continue;
    } finally {
      deps.onTurnController?.(undefined);
    }
    if (res.tools.length > 0) say(toolLine(res.tools));
    if (!ctx.quiet) renderToolDiffs(res.tools, deps.out); // FIX 3: colorized inline diffs for file mutations
    // The prose was already streamed live; only print it here when it wasn't (non-stream path, or a
    // synthetic [ikbi: …] reply that never produced content deltas).
    if (!streamedProse) deps.out(`${res.response}\n`);
    // Cache-hit segment for the context bar (FIX 7), when caching is active this session.
    const u = ctx.session.usage?.();
    const cachePct = ctx.session.cacheHitPercent?.() ?? (u !== undefined && (u.cachedTokens ?? 0) > 0 && u.tokensIn > 0 ? Math.round(((u.cachedTokens ?? 0) / u.tokensIn) * 100) : undefined);
    say(contextBar(res.contextPercent, cachePct));
  }
  say("\nsession ended.\n");
}

/** Bridge a readline interface to the `readLine()` pull model; resolves null on close/SIGINT. */
function readlineSource(getTurnController?: () => AbortController | undefined): { readLine: () => Promise<string | null>; close: () => void } {
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
  // Ctrl-C: abort an in-flight turn first. A second Ctrl-C / idle Ctrl-C closes cleanly.
  rl.on("SIGINT", () => {
    const controller = getTurnController?.();
    if (controller !== undefined && !controller.signal.aborted) {
      controller.abort();
      return;
    }
    rl.close();
  });
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
 *
 * `initialMessage` (GAP 1: REPL-as-default) seeds the session's FIRST turn — `ikbi fix the
 * bug in auth.ts` opens the REPL pre-loaded with that prompt. On a TTY the session then
 * continues interactively; on non-TTY stdin it runs the one turn and exits (same one-shot
 * shape as piped input). When absent, piped stdin (if any) supplies the first message instead.
 */
export async function liveRepl(argv: readonly string[] = [], initialMessage?: string): Promise<void> {
  const out = (s: string): void => void process.stdout.write(s);
  const quiet = argv.includes("--quiet");
  // `--verbose`/`--debug` opt into raw technical detail (+stack) on translated error messages.
  const verbose = argv.includes("--verbose") || argv.includes("--debug");
  // `--quiet` is model-output-only: suppress every status/diagnostic line (project overview,
  // resume/fork notices) and let only the model's response reach stdout. Model prose still
  // uses `out` directly; non-model chatter routes through `status`.
  const status = (s: string): void => { if (!quiet) out(s); };
  // `--max-sessions <n>` overrides the prune cap (BLOCKER-3); else the store uses IKBI_MAX_SESSIONS / default.
  const maxIdx = argv.indexOf("--max-sessions");
  const maxArg = maxIdx >= 0 ? Number.parseInt(argv[maxIdx + 1] ?? "", 10) : Number.NaN;
  const store = Number.isFinite(maxArg) && maxArg > 0 ? new PersistentSessionStore(sessionsDir(), maxArg) : persistentStore;
  // `--force` breaks a stale/foreign session lock on save (BLOCKER-2).
  const force = argv.includes("--force");
  const autosave = (s: ChatSession): Promise<void> => store.save(s, { force });
  const scratch = argv.includes("--scratch");

  // MEMORY GOVERNOR: intercepts governed writes (CLAUDE.md, .ikbi/*, brain pages) into
  // operator-reviewed proposals. Constructed once for the REPL session, shared across
  // new/resumed sessions. gbrainBridge enables brain page approval.
  const memoryGovernor = createProductionGovernor({ gbrainBridge });

  // REPO CONTEXT (large-repo support): a lazy, relevance-ranked file selector rooted at each
  // session's worktree. Indexing is deferred to the first turn, so this adds NO startup cost or
  // noise. Shared factory across new/resumed sessions.
  const makeContextManager = (worktree: string): ReturnType<typeof createContextManager> => createContextManager(worktree);

  /**
   * Mint a fresh session. DEFAULT (cwd is a git repo, no `--scratch`): allocate a MANAGED workspace
   * — an isolated worktree off the repo — so edits never touch the target until an explicit `/apply`.
   * `--scratch`, or a cwd that is not a repo (allocation failure), falls back to a labelled scratch
   * workspace. This is the only place the REPL decides repo-vs-scratch; there is no live-direct path.
   */
  const newSession = async (): Promise<ChatSession> => {
    const id = randomUUID();
    // EXPLICIT OPERATOR OVERRIDE: IKBI_CHAT_WORKDIR pins a specific dir (live-direct, clearly labeled
    // "explicit" in /status). It is an opt-in, not the default, so it is honored as-is — the managed
    // default applies only when the operator has NOT pinned a workdir.
    const explicitWorkdir = process.env.IKBI_CHAT_WORKDIR;
    if (!scratch && explicitWorkdir !== undefined && explicitWorkdir.trim().length > 0) {
      return new ChatSession(id, { autosave, cwd: process.cwd(), permissionMode: "confirm", memoryGovernor, invokeStream: invokeModelStream, makeContextManager });
    }
    if (!scratch) {
      const target = resolveRepoTarget(process.cwd());
      if (target !== undefined) {
        try {
          const ws = await allocateSessionWorkspace({ targetRepo: target, sessionId: id });
          return new ChatSession(id, { workspace: ws, autosave, permissionMode: "confirm", memoryGovernor, invokeStream: invokeModelStream, makeContextManager });
        } catch (e) {
          out(`[managed workspace allocation failed (${errMsg(e)}) — falling back to a scratch session]\n`);
        }
      }
    }
    return new ChatSession(id, { autosave, cwd: process.cwd(), scratch: true, permissionMode: "confirm", memoryGovernor, invokeStream: invokeModelStream, makeContextManager });
  };

  /** Resume a persisted session, reconnecting its managed workspace when one was recorded. */
  const resume = async (id: string): Promise<ChatSession | undefined> => {
    const state = store.loadState(id);
    if (state === undefined) return undefined;
    let workspace;
    if (state.workdirKind === "managed" && state.workspaceId !== undefined) {
      workspace = await reconnectSessionWorkspace(state.workspaceId, { sessionId: state.id });
      if (workspace === undefined) {
        out(`[WARNING: managed workspace ${state.workspaceId} is gone — /diff, /apply, /discard are DISABLED]\n`);
        out(`[This session is read-only. Start a new session (ikbi repl) to make and apply changes.]\n`);
      }
    }
    return new ChatSession(state.id, { restore: state, autosave, ...(workspace !== undefined ? { workspace } : {}), memoryGovernor, invokeStream: invokeModelStream, makeContextManager });
  };

  let session: ChatSession;
  const resumeIdx = argv.indexOf("--resume");
  const forkIdx = argv.indexOf("--fork");
  const wantContinue = argv.includes("--continue") || argv.includes("-c");
  if (forkIdx >= 0) {
    // `--fork <id>`: clone an existing session's history into a NEW session (fresh id), leaving the
    // origin untouched. The forked session is wired with the same autosave/governor/stream deps.
    const originId = argv[forkIdx + 1];
    if (originId === undefined || originId.startsWith("--")) {
      out("[--fork needs a session id: ikbi repl --fork <id>]\n");
      return;
    }
    try {
      session = await store.fork(originId, { autosave, memoryGovernor, invokeStream: invokeModelStream });
      status(`Forked session ${originId} → ${session.id} (${session.messageCount()} messages, worktree: ${session.worktree})\n`);
    } catch (e) {
      out(`[no session found to fork: ${originId} (${errMsg(e)})]\n`);
      return;
    }
  } else if (resumeIdx >= 0) {
    const id = argv[resumeIdx + 1];
    const loaded = id !== undefined ? await resume(id) : undefined;
    if (loaded === undefined) {
      out(`[no session found for --resume ${id ?? "(missing id)"}]\n`);
      return;
    }
    session = loaded;
    status(`Resumed session ${session.id} (${session.messageCount()} messages, worktree: ${session.worktree})\n`);
  } else if (wantContinue) {
    const top = store.list()[0];
    const latest = top !== undefined ? await resume(top.id) : undefined;
    if (latest === undefined) {
      status("[no prior session to continue — starting fresh]\n");
      session = await newSession();
    } else {
      session = latest;
      status(`Resumed session ${session.id} (${session.messageCount()} messages, worktree: ${session.worktree})\n`);
    }
  } else {
    session = await newSession();
  }

  // PROJECT AUTO-DISCOVERY (FIX 2): a one-line overview of the worktree at startup.
  try {
    status(formatOverview(discoverProject(session.worktree)));
  } catch {
    // Discovery is best-effort cosmetics — never let it block the session.
  }

  // FIRST MESSAGE: a bare-text invocation (`ikbi fix the bug`, GAP 1) seeds the opening turn
  // directly; otherwise piped stdin (`cat file | ikbi repl`, CC parity) supplies it. Either way the
  // text is returned as the FIRST `readLine()`, then the reader defers to the live source — so a TTY
  // continues interactively while non-TTY stdin sees EOF and exits after the one turn (a clean one-shot).
  const seeded = initialMessage?.trim();
  const firstMessage = seeded !== undefined && seeded.length > 0 ? seeded : (await readPipedStdin()).trim();

  let turnController: AbortController | undefined;
  const src = readlineSource(() => turnController);
  let firstConsumed = false;
  const readLine = async (): Promise<string | null> => {
    if (!firstConsumed && firstMessage.length > 0) {
      firstConsumed = true;
      return firstMessage;
    }
    return src.readLine();
  };
  try {
    await runRepl({ session, store, newSession, readLine, out, quiet, verbose, onTurnController: (controller) => { turnController = controller; } });
  } finally {
    src.close();
    // Release the session's MCP transports (spawned child processes), if any. Best-effort.
    try {
      await session.dispose();
    } catch {
      /* best-effort teardown */
    }
  }
}

registerCommand({
  name: "repl",
  summary: "Start an interactive conversational session (multi-turn, tool-calling)",
  usage: "ikbi repl [--continue | --resume <id> | --fork <id>]",
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

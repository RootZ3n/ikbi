/**
 * ikbi SHARED tool executor — one tool-dispatch path for the builder AND the chat.
 *
 * Before this module the builder (`builder.ts`) and the chat REPL (`chat/session.ts`)
 * each carried their OWN copy of tool dispatch — confinement, the memory-governor
 * interception, brain access, governed terminal. Two consequences:
 *
 *   RED-1  the memory governor (which converts writes to durable surfaces —
 *          CLAUDE.md / .ikbi/* / brain pages — into operator-reviewed PROPOSALS)
 *          was wired into the builder but NOT the chat, so a chat session could
 *          mutate governed memory with no review.
 *   RED-2  every tool improvement had to be made twice, and the two paths drifted.
 *
 * This module is the single governance + execution chokepoint both surfaces share:
 *
 *   - `interceptMemoryGovernor(deps, call)` — the GOVERNANCE chokepoint. Given a tool
 *     call, decides whether it targets a governed surface and, if so, stores a proposal
 *     and returns the "PROPOSED:" message to feed back to the model INSTEAD of writing.
 *     The builder and the chat BOTH call this before executing a mutation, so the
 *     governor now intercepts brain_put / write_file / patch / multi_edit from either.
 *
 *   - `executeTool(deps, call)` — the full reusable executor: parse → confine → govern →
 *     execute, returning a RAW `ToolExecutionResult`. Callers format that result for their
 *     own surface (the builder's neutralization chokepoint vs the chat's `{output, activity}`
 *     shape) — the executor never builds a message. The chat dispatches its core tool set
 *     through this; the builder keeps its specialized `runTool` (write-scope, read-before-write)
 *     but shares the governance core above.
 *
 * TRUST: every result string this module PRODUCES is repo content / command output /
 * retrieved knowledge — UNTRUSTED. It is the CALLER's job to re-neutralize it at its own
 * chokepoint before it re-enters the model. This module only produces; it never neutralizes.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { OperationContext } from "../../core/identity/index.js";
import type { GbrainBridge } from "../../core/gbrain-bridge.js";
import type { GovernedExec } from "../governed-exec/index.js";
import type { ToolCall } from "../../core/provider/index.js";
import type { MemoryGovernor } from "../memory-governor/contract.js";
import { isGovernedPath } from "../memory-governor/guard.js";
import { confinePath, type ToolCallError } from "./builder-tools/confine.js";
import { runSearchFiles } from "./builder-tools/search-files.js";
import { runGlob } from "./builder-tools/glob.js";
import { runPatch } from "./builder-tools/patch.js";
import { runMultiEdit } from "./builder-tools/multi-edit.js";
import { runTerminal, type JobControl } from "./builder-tools/terminal.js";
import { runBrainTool } from "./builder-tools/brain-tools.js";

/** Max bytes returned by read_file (matches the chat/builder caps). */
const MAX_READ_BYTES = 32_000;
/** Max entries returned by list_dir. */
const MAX_LIST_ENTRIES = 200;

/** Dependencies the shared executor needs. Each is optional so a caller can wire only what it uses. */
export interface ToolExecutorDeps {
  /** The resolved (realpath'd) workspace root every file/search/exec path is confined to. */
  readonly worktreeReal: string;
  /** The agent id recorded on memory proposals. */
  readonly agentId: string;
  /** The memory governor. Absent ⇒ NO interception (governed writes execute normally — backward compat). */
  readonly memoryGovernor?: MemoryGovernor;
  /** The gbrain bridge — required for brain_* tools; absent ⇒ brain tools error. */
  readonly gbrainBridge?: GbrainBridge;
  /** Governed-exec surface — required for `terminal`; absent ⇒ terminal errors. */
  readonly governedExec?: Pick<GovernedExec, "run">;
  /**
   * BACKGROUND job control (list/poll/kill of detached processes) for `terminal background:true`.
   * Absent ⇒ a background / poll / kill request returns an error (the foreground path is unaffected).
   * MUST be the SAME governed-exec instance as `governedExec` so a job started here can be polled
   * and killed here. Without this the terminal tool ADVERTISES background mode it cannot reach.
   */
  readonly jobs?: JobControl;
  /** The run's validated identity — authorizes governed terminal / brain_sync. Absent ⇒ those fail closed. */
  readonly parentCtx?: OperationContext;
}

/**
 * The RAW result of a single shared-executor tool invocation. Callers format it for their
 * own surface — this module never builds a message.
 *
 *  - `output`    — the raw result STRING to feed back (still UNTRUSTED; neutralize before use).
 *  - `ok`        — coarse success/failure (an ERROR/DENIED string ⇒ false).
 *  - `wrote`     — worktree-relative path of a file the tool MODIFIED (write_file/patch/multi_edit).
 *  - `rel`       — worktree-relative path the tool acted on (read_file/list_dir + the mutators).
 *  - `full`      — absolute path the tool acted on (callers use it for rollback bookkeeping).
 *  - `before`    — pre-write content of a mutated file (null ⇒ new file); for caller diff/rollback.
 *  - `after`     — post-write content of a mutated file; for caller diff.
 *  - `proposed`  — true when the memory governor intercepted the call (output is the PROPOSED: message).
 *  - `rejection` — present when the call was rejected (bad path / bad args); for caller tracking.
 */
export interface ToolExecutionResult {
  readonly output: string;
  readonly ok: boolean;
  readonly wrote?: string;
  readonly rel?: string;
  readonly full?: string;
  readonly before?: string | null;
  readonly after?: string;
  readonly proposed?: boolean;
  readonly rejection?: ToolCallError;
}

/** Result of the governance chokepoint: either intercepted (with the PROPOSED message) or not. */
export type GovernedInterception =
  | { readonly intercepted: true; readonly message: string; readonly proposalId: string }
  | { readonly intercepted: false };

/** The mutation tools whose target PATH the memory governor checks against the governed surfaces. */
const GOVERNED_FILE_TOOLS: ReadonlySet<string> = new Set(["write_file", "patch", "multi_edit"]);

const NOT_INTERCEPTED: GovernedInterception = { intercepted: false };

/** Parse a tool call's JSON arguments; returns {} on malformed input (the executor surfaces the error). */
function parseArgs(call: ToolCall): Record<string, unknown> {
  try {
    return JSON.parse(call.arguments && call.arguments.length > 0 ? call.arguments : "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * THE GOVERNANCE CHOKEPOINT — shared by the builder and the chat.
 *
 * If `deps.memoryGovernor` is wired AND the call writes to a governed surface (a governed file
 * path for write_file/patch/multi_edit, or any slug for brain_put), store a proposal and return
 * the "PROPOSED:" message the caller feeds back to the model INSTEAD of performing the write.
 * Otherwise return `{ intercepted: false }` and the caller executes the tool normally.
 *
 * No governor ⇒ never intercept (backward-compatible: governed writes execute as before).
 */
export async function interceptMemoryGovernor(deps: ToolExecutorDeps, call: ToolCall): Promise<GovernedInterception> {
  const governor = deps.memoryGovernor;
  if (governor === undefined) return NOT_INTERCEPTED;

  // brain_put — writes a knowledge page. Governed by default (any slug).
  if (call.name === "brain_put") {
    const args = parseArgs(call);
    const slug = typeof args.slug === "string" ? args.slug : "";
    const content = typeof args.content === "string" ? args.content : "";
    // Mirror the brain_put pre-check: only a well-formed put becomes a proposal; a malformed one
    // falls through to normal execution, which returns the actionable ERROR.
    if (slug.length === 0 || content.length === 0) return NOT_INTERCEPTED;
    const proposal = await governor.propose({
      surface: "brain_page",
      target: slug,
      content,
      reason: `brain_put to "${slug}"`,
      agentId: deps.agentId,
    });
    return {
      intercepted: true,
      proposalId: proposal.id,
      message: `PROPOSED: Your brain page "${slug}" has been stored as a memory proposal (id: ${proposal.id}) pending operator review. It will be written to the brain after approval.`,
    };
  }

  // write_file / patch / multi_edit — file writes. Governed only when the target PATH is a governed surface.
  if (GOVERNED_FILE_TOOLS.has(call.name)) {
    const args = parseArgs(call);
    const target = typeof args.path === "string" ? args.path : "";
    if (target.length === 0) return NOT_INTERCEPTED;
    const surface = isGovernedPath(target);
    if (surface === undefined) return NOT_INTERCEPTED;
    // Resolve to absolute path so the apply function can find the file at approve-time
    // (the worktree may be gone by then if it was a managed workspace).
    const absTarget = target.startsWith("/") ? target : `${deps.worktreeReal}/${target}`;
    const content = proposalContentFor(call.name, args);
    const proposal = await governor.propose({
      surface,
      target: absTarget,
      content,
      reason: `${call.name} to ${target}`,
      agentId: deps.agentId,
    });
    return {
      intercepted: true,
      proposalId: proposal.id,
      message: `PROPOSED: Your ${call.name} to "${target}" has been stored as a memory proposal (id: ${proposal.id}) pending operator review. It will be applied after approval.`,
    };
  }

  return NOT_INTERCEPTED;
}

/** Derive the proposal content for a governed file write (the new text we would otherwise apply). */
function proposalContentFor(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "write_file") return typeof args.content === "string" ? args.content : "";
  if (toolName === "patch") return typeof args.new_string === "string" ? args.new_string : "";
  if (toolName === "multi_edit") return Array.isArray(args.edits) ? JSON.stringify(args.edits) : "";
  return "";
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** True for a result string that signals failure (so callers can set `ok` uniformly). */
function isFailure(output: string): boolean {
  return output.startsWith("ERROR") || output.startsWith("DENIED");
}

/**
 * Execute one tool call through the shared path: parse → memory-governor → confine → execute.
 * Returns a RAW result the caller formats for its own surface. Handles the core confinement/
 * governance tool set (read_file, list_dir, search_files, glob, write_file, patch, multi_edit,
 * terminal, brain_*). Tools outside this set return an `ok:false` "not handled" result so the
 * caller can fall back to its own surface-specific handling.
 */
export async function executeTool(deps: ToolExecutorDeps, call: ToolCall): Promise<ToolExecutionResult> {
  // GOVERNANCE FIRST: a governed write never touches the fs — it becomes a proposal.
  const gov = await interceptMemoryGovernor(deps, call);
  if (gov.intercepted) return { output: gov.message, ok: true, proposed: true };

  const args = parseArgs(call);
  const worktreeReal = deps.worktreeReal;

  switch (call.name) {
    case "read_file": {
      const c = confinePath(worktreeReal, args.path);
      if (!c.ok) return { output: `ERROR: ${c.error}`, ok: false, rejection: { tool: "read_file", path: String(args.path ?? ""), error: c.error } };
      try {
        const raw = readFileSync(c.full, "utf8");
        const body = raw.length > MAX_READ_BYTES
          ? `${raw.slice(0, MAX_READ_BYTES)}\n\n[truncated — showed the first ${MAX_READ_BYTES} of ${raw.length} chars of ${c.rel}. Use search_files to locate the part you need, or patch by exact anchor.]`
          : raw;
        return { output: body, ok: true, rel: c.rel, full: c.full };
      } catch (e) {
        return { output: `ERROR: read failed: ${errMsg(e)}`, ok: false, rel: c.rel, full: c.full };
      }
    }
    case "list_dir": {
      const c = confinePath(worktreeReal, args.path);
      if (!c.ok) return { output: `ERROR: ${c.error}`, ok: false, rejection: { tool: "list_dir", path: String(args.path ?? ""), error: c.error } };
      try {
        const all = readdirSync(c.full, { withFileTypes: true });
        const entries = all.slice(0, MAX_LIST_ENTRIES).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        if (all.length > MAX_LIST_ENTRIES) {
          entries.push(`[truncated — showed ${MAX_LIST_ENTRIES} of ${all.length} entries; narrow with a subdirectory path or search_files]`);
        }
        return { output: entries.join("\n"), ok: true, rel: c.rel, full: c.full };
      } catch (e) {
        return { output: `ERROR: list failed: ${errMsg(e)}`, ok: false, rel: c.rel, full: c.full };
      }
    }
    case "search_files": {
      const res = runSearchFiles(worktreeReal, args);
      return { output: res.output, ok: res.rejection === undefined, ...(res.rejection !== undefined ? { rejection: res.rejection } : {}) };
    }
    case "glob": {
      const out = runGlob(worktreeReal, args);
      return { output: out, ok: !out.startsWith("ERROR") };
    }
    case "write_file": {
      const c = confinePath(worktreeReal, args.path);
      if (!c.ok) return { output: `ERROR: ${c.error}`, ok: false, rejection: { tool: "write_file", path: String(args.path ?? ""), error: c.error } };
      const content = typeof args.content === "string" ? args.content : "";
      let before: string | null = null;
      try { before = readFileSync(c.full, "utf8"); } catch { before = null; }
      try {
        mkdirSync(dirname(c.full), { recursive: true });
        writeFileSync(c.full, content, "utf8");
        return { output: `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${c.rel}`, ok: true, wrote: c.rel, rel: c.rel, full: c.full, before, after: content };
      } catch (e) {
        return { output: `ERROR: write failed: ${errMsg(e)}`, ok: false, rel: c.rel, full: c.full };
      }
    }
    case "patch": {
      const c = confinePath(worktreeReal, args.path);
      let before: string | null = null;
      if (c.ok) {
        try { before = readFileSync(c.full, "utf8"); } catch { before = null; }
      }
      const res = runPatch(worktreeReal, args);
      const ok = res.rejection === undefined;
      let after: string | undefined;
      if (ok && c.ok) {
        try { after = readFileSync(c.full, "utf8"); } catch { after = ""; }
      }
      return {
        output: res.output,
        ok,
        ...(res.wrote !== undefined ? { wrote: res.wrote } : {}),
        ...(res.rejection !== undefined ? { rejection: res.rejection } : {}),
        ...(ok && c.ok ? { rel: c.rel, full: c.full, before, after: after ?? "" } : {}),
      };
    }
    case "multi_edit": {
      const c = confinePath(worktreeReal, args.path);
      let before: string | null = null;
      if (c.ok) {
        try { before = readFileSync(c.full, "utf8"); } catch { before = null; }
      }
      const res = runMultiEdit(worktreeReal, args);
      const ok = res.rejection === undefined;
      let after: string | undefined;
      if (ok && c.ok) {
        try { after = readFileSync(c.full, "utf8"); } catch { after = ""; }
      }
      return {
        output: res.output,
        ok,
        ...(res.wrote !== undefined ? { wrote: res.wrote } : {}),
        ...(res.rejection !== undefined ? { rejection: res.rejection } : {}),
        ...(ok && c.ok ? { rel: c.rel, full: c.full, before, after: after ?? "" } : {}),
      };
    }
    case "terminal": {
      if (deps.governedExec === undefined) {
        return { output: "ERROR: terminal is unavailable (no governed-exec wired).", ok: false };
      }
      const out = await runTerminal(
        {
          governedExec: deps.governedExec,
          ...(deps.jobs !== undefined ? { jobs: deps.jobs } : {}),
          ...(deps.parentCtx !== undefined ? { parentCtx: deps.parentCtx } : {}),
        },
        worktreeReal,
        args,
      );
      return { output: out, ok: !isFailure(out) };
    }
    case "brain_search":
    case "brain_think":
    case "brain_put":
    case "brain_sync": {
      if (deps.gbrainBridge === undefined) {
        return { output: "ERROR: brain tools are unavailable (no gbrain bridge wired).", ok: false };
      }
      const out = runBrainTool(
        { bridge: deps.gbrainBridge, ...(deps.parentCtx !== undefined ? { parentCtx: deps.parentCtx } : {}) },
        call.name,
        args,
      );
      return { output: out, ok: !isFailure(out) };
    }
    default:
      // Not part of the shared executor's tool set — the caller handles it on its own surface.
      return { output: `ERROR: ${call.name} is not handled by the shared tool executor`, ok: false };
  }
}

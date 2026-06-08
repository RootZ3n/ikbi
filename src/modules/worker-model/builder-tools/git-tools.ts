/**
 * ikbi builder tools — GIT inspection (git_status / git_diff / git_log).
 *
 * READ-ONLY git inspection so the builder can SEE the state of its own work:
 * what it changed (status), the exact diff, and recent history. Like `terminal`,
 * every command runs through the SAME governed-exec path (gate-wall + allowlist +
 * receipts, execFile ARRAY args — no shell), with cwd pinned to the worktree.
 * `git` is on the default binary allowlist, so these work out of the box while
 * still being governed and audited.
 *
 * Strictly read-only: only `status`, `diff`, and `log` subcommands are ever run —
 * the argv is built HERE from a fixed template, never from a model-supplied verb,
 * so the model cannot smuggle a mutating subcommand (e.g. `git push`) through.
 *
 * TRUST: git output is repo CONTENT / command output — UNTRUSTED. The builder feeds
 * it back through the neutralization chokepoint (same as terminal). This only
 * PRODUCES the result string.
 */

import type { OperationContext } from "../../../core/identity/index.js";
import type { ModelTool } from "../../../core/provider/contract.js";
import type { ExecResult, GovernedExec } from "../../governed-exec/index.js";
import { confinePath } from "./confine.js";

/** What the git tools need: the governed executor + the run's identity. */
export interface GitDeps {
  readonly governedExec: Pick<GovernedExec, "run">;
  /** The run's validated OperationContext. Absent ⇒ the tools fail closed (cannot authorize). */
  readonly parentCtx?: OperationContext;
}

/** The git tool names the builder routes to this module. */
export const GIT_TOOL_NAMES: ReadonlySet<string> = new Set(["git_status", "git_diff", "git_log"]);

/** Default and max number of commits git_log returns. */
const DEFAULT_LOG_COUNT = 15;
const MAX_LOG_COUNT = 100;

export const gitStatusTool: ModelTool = {
  name: "git_status",
  description: "Show the working-tree status of the worktree (changed/staged/untracked files). Read-only.",
  parameters: { type: "object", properties: {}, required: [] },
};

export const gitDiffTool: ModelTool = {
  name: "git_diff",
  description:
    "Show the git diff in the worktree. By default shows UNSTAGED changes; set staged:true for the staged diff. Optionally limit to one file path. Read-only.",
  parameters: {
    type: "object",
    properties: {
      staged: { type: "boolean", description: "Show the staged (index) diff instead of the unstaged diff." },
      path: { type: "string", description: "Limit the diff to this file path (within the worktree)." },
    },
    required: [],
  },
};

export const gitLogTool: ModelTool = {
  name: "git_log",
  description: "Show recent commit history (one line per commit). Read-only.",
  parameters: {
    type: "object",
    properties: { count: { type: "number", description: `How many commits to show (default ${DEFAULT_LOG_COUNT}, max ${MAX_LOG_COUNT}).` } },
    required: [],
  },
};

/** Build the FIXED git argv for a tool (never taken from a model-supplied verb). */
function buildArgv(worktreeDir: string, toolName: string, args: Record<string, unknown>): { argv: string[] } | { error: string } {
  switch (toolName) {
    case "git_status":
      return { argv: ["status", "--short", "--branch"] };
    case "git_diff": {
      const argv = ["diff"];
      if (args.staged === true) argv.push("--staged");
      if (typeof args.path === "string" && args.path.length > 0) {
        const c = confinePath(worktreeDir, args.path);
        if (!c.ok) return { error: c.error };
        argv.push("--", c.rel);
      }
      return { argv };
    }
    case "git_log": {
      const n = typeof args.count === "number" && args.count > 0 ? Math.min(Math.floor(args.count), MAX_LOG_COUNT) : DEFAULT_LOG_COUNT;
      return { argv: ["log", "--oneline", "-n", String(n)] };
    }
    default:
      return { error: `unknown git tool "${toolName}"` };
  }
}

/** Render a governed ExecResult into a bounded, model-readable string. */
function formatExecResult(result: ExecResult): string {
  if (result.denied === true) return `DENIED: ${result.reason ?? "git command not permitted by the governed executor"}`;
  if (!result.executed) return `ERROR: git did not execute${result.reason !== undefined ? `: ${result.reason}` : ""}`;
  const parts = [`exit ${result.exitCode ?? -1}`];
  if (result.stdoutTail !== undefined && result.stdoutTail.length > 0) parts.push(result.stdoutTail);
  else parts.push("(no output)");
  if (result.stderrTail !== undefined && result.stderrTail.length > 0) parts.push(`stderr:\n${result.stderrTail}`);
  return parts.join("\n");
}

/**
 * Run a read-only git inspection through governed-exec. Async (governed-exec is async).
 * Returns the raw result STRING for the builder to neutralize + append; never throws.
 */
export async function runGitTool(
  deps: GitDeps,
  worktreeDir: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (deps.parentCtx === undefined) {
    return "ERROR: git tools are unavailable (no parent identity wired to authorize the governed command).";
  }
  const built = buildArgv(worktreeDir, toolName, args);
  if ("error" in built) return `ERROR: ${built.error}`;
  try {
    const result = await deps.governedExec.run({
      parentCtx: deps.parentCtx,
      command: "git",
      args: built.argv,
      cwd: worktreeDir,
      purpose: `builder ${toolName}`,
    });
    return formatExecResult(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `ERROR: ${toolName} failed: ${msg}`;
  }
}

/**
 * ikbi builder tool — terminal (GOVERNED shell command execution).
 *
 * THE most powerful builder tool, and the one held to the strictest leash: every
 * command runs through the SAME governed-exec path the verifier's checks use. That
 * means it is gate-walled, allowlisted (default-deny binary list), receipted, and
 * run with ARRAY args via execFile — never a shell string — so there is no shell
 * metacharacter interpretation and no command injection surface. The model passes a
 * `command` line; we tokenize it into a binary + literal args (honoring simple
 * single/double quotes) and hand THAT to governed-exec, which decides allow/deny.
 *
 * FAIL-CLOSED: without a parent identity (`parentCtx`) governed-exec cannot be
 * authorized, so the tool refuses — exactly like run_checks. A binary not on the
 * allowlist comes back `denied` from governed-exec; the builder sees the denial
 * reason and adapts. The command's cwd is pinned to the worktree.
 *
 * TRUST: command output is UNTRUSTED data — the builder feeds it back through the
 * neutralization chokepoint (same as read_file / search_files). This tool only
 * PRODUCES the result string; it never builds a message.
 */

import { realpathSync } from "node:fs";

import type { OperationContext } from "../../../core/identity/index.js";
import type { ModelTool } from "../../../core/provider/contract.js";
import type { ExecResult, GovernedExec } from "../../governed-exec/index.js";
import { commandPolicyDenyReason } from "../../governed-exec/policy.js";
import { confinePath } from "./confine.js";

/** What the terminal tool needs from the builder: the governed executor + the run's identity. */
export interface TerminalDeps {
  readonly governedExec: Pick<GovernedExec, "run">;
  /** The run's validated OperationContext. Absent ⇒ the tool fails closed (cannot authorize). */
  readonly parentCtx?: OperationContext;
}

/** The tool declared to the model. */
export const terminalTool: ModelTool = {
  name: "terminal",
  description:
    "Run a shell command in the worktree through ikbi's GOVERNED executor (allowlisted binaries only, no shell metacharacters — arguments are passed literally). Returns exit code, stdout, and stderr. Use for build/inspection commands; a command whose binary is not allowlisted is denied.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line, e.g. `git status` or `ls src`. The first token is the binary; the rest are literal arguments." },
    },
    required: ["command"],
  },
};

/**
 * Tokenize a command line into a binary + argument array, honoring simple single-
 * and double-quoted spans (so `git commit -m "a b"` → ["git","commit","-m","a b"]).
 * This is NOT a shell: there is no globbing, variable expansion, piping, or
 * substitution — the tokens are handed verbatim to execFile via governed-exec.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | undefined;
  let started = false; // distinguishes an empty quoted token "" from no token
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      if (started) {
        tokens.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) tokens.push(cur);
  return tokens;
}

/**
 * For a read-only tool's argument list, return the FIRST operand that escapes the managed
 * workspace, or undefined when every path-like operand stays inside. A token is treated as a
 * path operand unless it is a flag (`-x` / `--long`); `/dev/null` is allowed (a common sink).
 * Confinement is delegated to the shared realpath-based `confinePath`, so `..` traversal,
 * absolute-outside paths, and symlink escapes are all caught — a bare in-workspace pattern
 * (e.g. the regex in `grep foo file`) resolves inside and is NOT flagged.
 */
export function firstEscapingOperand(worktreeDir: string, args: readonly string[]): string | undefined {
  // Resolve symlinks on the worktree root once so the confinement compares canonical paths
  // (matches how the session/builder pass an already-realpath'd worktree). Best-effort.
  let root = worktreeDir;
  try {
    root = realpathSync(worktreeDir);
  } catch {
    root = worktreeDir;
  }
  for (const arg of args) {
    if (arg.length === 0 || arg.startsWith("-")) continue; // flags (and the bare `-` stdin marker)
    if (arg === "/dev/null") continue; // common, harmless sink
    const c = confinePath(root, arg);
    if (!c.ok) return arg;
  }
  return undefined;
}

/** Render a governed ExecResult into a bounded, model-readable string. */
function formatExecResult(result: ExecResult): string {
  if (result.denied === true) {
    return `DENIED: ${result.reason ?? "command not permitted by the governed executor"}`;
  }
  if (!result.executed) {
    return `ERROR: command did not execute${result.reason !== undefined ? `: ${result.reason}` : ""}`;
  }
  const parts = [`exit ${result.exitCode ?? -1}`];
  if (result.stdoutTail !== undefined && result.stdoutTail.length > 0) parts.push(`stdout:\n${result.stdoutTail}`);
  if (result.stderrTail !== undefined && result.stderrTail.length > 0) parts.push(`stderr:\n${result.stderrTail}`);
  return parts.join("\n");
}

/**
 * Run a governed terminal command in the worktree. Async (governed-exec is async).
 * Returns the raw result STRING for the builder to neutralize + append; never
 * throws past the call boundary.
 */
export async function runTerminal(
  deps: TerminalDeps,
  worktreeDir: string,
  args: Record<string, unknown>,
): Promise<string> {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (command.length === 0) {
    return "ERROR: terminal requires a non-empty 'command'";
  }
  if (deps.parentCtx === undefined) {
    return "ERROR: terminal is unavailable (no parent identity wired to authorize the governed command).";
  }
  const tokens = tokenizeCommand(command);
  const binary = tokens[0];
  if (binary === undefined || binary.length === 0) {
    return "ERROR: terminal could not parse a command from the input.";
  }
  const rest = tokens.slice(1);
  // PATH CONFINEMENT: for read-only tools, resolve every path-like operand against the worktree
  // root (via the shared realpath-based `confinePath`) and DENY any escape. This blocks not just
  // absolute-outside paths (`head /etc/passwd`) but also relative `..` traversal (`ls ..`,
  // `grep x ../file`, `find ../outside`) and symlinks whose target leaves the tree — none of which
  // the old absolute-prefix check caught. Flags (tokens starting with `-`) are skipped, and a bare
  // pattern/value that resolves INSIDE the worktree (e.g. the regex in `grep foo file`) is allowed;
  // only operands that escape the managed workspace are refused.
  const READ_ONLY_TOOLS = new Set(["head", "tail", "wc", "grep", "find", "ls"]);
  if (READ_ONLY_TOOLS.has(binary)) {
    const escape = firstEscapingOperand(worktreeDir, rest);
    if (escape !== undefined) {
      return `DENIED: path '${escape}' escapes the managed workspace — read tools are confined to the worktree`;
    }
  }
  const policyDeny = commandPolicyDenyReason(binary, rest, `builder terminal: ${command.slice(0, 120)}`);
  if (policyDeny !== undefined) return `DENIED: ${policyDeny}`;
  try {
    const result = await deps.governedExec.run({
      parentCtx: deps.parentCtx,
      command: binary,
      args: rest,
      cwd: worktreeDir,
      purpose: `builder terminal: ${command.slice(0, 120)}`,
    });
    return formatExecResult(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `ERROR: terminal failed: ${msg}`;
  }
}

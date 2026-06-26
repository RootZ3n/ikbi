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
import type { ExecResult, GovernedExec, JobOutputResult } from "../../governed-exec/index.js";
import { commandPolicyDenyReason } from "../../governed-exec/policy.js";
import { confinePath } from "./confine.js";

/** The background-job control surface the terminal tool needs to poll/kill long-running jobs. */
export type JobControl = Pick<GovernedExec, "listJobs" | "readJobOutput" | "killJob" | "jobStatus">;

/** What the terminal tool needs from the builder: the governed executor + the run's identity. */
export interface TerminalDeps {
  readonly governedExec: Pick<GovernedExec, "run">;
  /**
   * BACKGROUND job control (poll/kill/list of detached processes). Absent ⇒ background mode is
   * unavailable and a `background:true` / `poll_job_id` / `kill_job_id` request returns an error;
   * the foreground path is unaffected. MUST be the SAME executor instance as `governedExec` so a
   * job started here can be polled/killed here.
   */
  readonly jobs?: JobControl;
  /** The run's validated OperationContext. Absent ⇒ the tool fails closed (cannot authorize). */
  readonly parentCtx?: OperationContext;
}

/** Default terminal timeout (ms) — generous enough for installs/test suites. */
export const DEFAULT_TERMINAL_TIMEOUT_MS = 120_000;
/** Hard ceiling for a model-requested terminal timeout (ms). Commands MUST terminate. */
export const MAX_TERMINAL_TIMEOUT_MS = 600_000;

/** The tool declared to the model. */
export const terminalTool: ModelTool = {
  name: "terminal",
  description:
    "Run a shell command in the worktree through ikbi's GOVERNED executor (allowlisted binaries only, no shell metacharacters — arguments are passed literally). Returns exit code, stdout, and stderr. Use for build/inspection commands; a command whose binary is not allowlisted is denied. " +
    "A normal (foreground) command must TERMINATE and is killed at `timeout_ms` (default 120000, max 600000) — raise it for slow installs/test suites. " +
    "For a long-running process (dev server, watch mode, a suite that may exceed the timeout) set `background: true`: it is spawned detached with NO timeout and returns a `job` id immediately. Poll its output by calling terminal again with `poll_job_id` (pass the returned `next_offset` as `offset` to read only new output), and stop it with `kill_job_id`. Background jobs are cleaned up automatically when the session ends.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line, e.g. `git status` or `ls src`. The first token is the binary; the rest are literal arguments. Required unless polling/killing a job." },
      timeout_ms: { type: "number", description: `Foreground only: max run time in ms before the command is killed. Default ${DEFAULT_TERMINAL_TIMEOUT_MS}, max ${MAX_TERMINAL_TIMEOUT_MS}. Ignored for background jobs.` },
      background: { type: "boolean", description: "Run `command` as a detached background job (no timeout). Returns a job id; use poll_job_id/kill_job_id to manage it. Use for dev servers, watch mode, or very long suites." },
      poll_job_id: { type: "string", description: "Instead of running a command, read newly captured output from this background job id. Pair with `offset`." },
      kill_job_id: { type: "string", description: "Instead of running a command, stop this background job id (SIGTERM, then SIGKILL after a grace period)." },
      offset: { type: "number", description: "With poll_job_id: the byte offset to read from (use the `next_offset` from the previous poll to read only new output). Default 0." },
    },
    required: [],
  },
};

/**
 * Tokenize a command line into a binary + argument array, honoring single- and double-quoted spans
 * AND backslash escapes (so `git commit -m "a b"` → ["git","commit","-m","a b"], and
 * `printf "%s" "a \"b\" c"` keeps the inner quotes). This is NOT a shell: there is no globbing,
 * variable expansion, piping, or substitution — the tokens are handed verbatim to execFile via
 * governed-exec.
 *
 * BACKSLASH ESCAPES (RC7):
 *   • Unquoted: `\<ch>` → literal `<ch>` (so `\ ` is a literal space, `\"` a literal quote).
 *   • Double-quoted: `\"` → `"` and `\\` → `\`; any other `\<ch>` is PRESERVED verbatim
 *     (`"\d"` stays `\d`) — matching POSIX double-quote semantics so regexes survive.
 *   • Single-quoted: `\'` → `'` and `\\` → `\`; any other `\<ch>` is PRESERVED verbatim
 *     (`'\b'` stays `\b`). This is a deliberate, documented superset of POSIX single quotes
 *     (which keep everything literal) so an inner single quote can be escaped without breaking
 *     common backslash regex patterns.
 *
 * Throws on an UNTERMINATED quote (`"abc` or `'abc`) — a clear failure the caller surfaces, rather
 * than silently shipping a half-parsed argument to exec.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | undefined;
  let started = false; // distinguishes an empty quoted token "" from no token
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];

    if (ch === "\\") {
      const next = command[i + 1];
      if (next === undefined) {
        // Trailing backslash with nothing to escape — keep it literal.
        cur += "\\";
        started = true;
        continue;
      }
      if (quote === undefined) {
        // Unquoted: backslash escapes any single character.
        cur += next;
      } else if (next === quote || next === "\\") {
        // Inside quotes: a backslash only escapes the matching quote or another backslash.
        cur += next;
      } else {
        // Any other escape inside quotes is preserved verbatim (regex backslashes survive).
        cur += "\\" + next;
      }
      started = true;
      i += 1;
      continue;
    }

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
  if (quote !== undefined) {
    throw new Error(`unterminated ${quote === '"' ? "double" : "single"} quote in command`);
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

/** Render the result of STARTING a background job (the handle the model polls/kills). */
function formatBackgroundStart(result: ExecResult): string {
  if (result.denied === true) {
    return `DENIED: ${result.reason ?? "command not permitted by the governed executor"}`;
  }
  if (!result.executed || result.jobId === undefined) {
    return `ERROR: background command did not start${result.reason !== undefined ? `: ${result.reason}` : ""}`;
  }
  return (
    `started background job ${result.jobId}${result.pid !== undefined ? ` (pid ${result.pid})` : ""}. ` +
    `Poll output: terminal poll_job_id=${result.jobId} (pass the returned next_offset as offset). ` +
    `Stop it: terminal kill_job_id=${result.jobId}.`
  );
}

/** Render a poll of a background job's captured output (status + the new bytes). */
function formatJobOutput(jobId: string, out: JobOutputResult): string {
  const exit = out.exitCode !== undefined ? ` exit ${out.exitCode}` : "";
  const header = `job ${jobId} [${out.status ?? "unknown"}${exit}] next_offset=${out.nextOffset}`;
  return out.output.length > 0 ? `${header}\n${out.output}` : `${header}\n(no new output)`;
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
  const pollJobId = typeof args.poll_job_id === "string" && args.poll_job_id.length > 0 ? args.poll_job_id : undefined;
  const killJobId = typeof args.kill_job_id === "string" && args.kill_job_id.length > 0 ? args.kill_job_id : undefined;
  const background = args.background === true;

  // BACKGROUND CONTROL (poll/kill) — operates on an EXISTING job, so no command is needed. These
  // never spawn or execute; they only read captured output or signal a job through the same
  // executor instance that started it.
  if (pollJobId !== undefined || killJobId !== undefined) {
    if (deps.jobs === undefined) {
      return "ERROR: background jobs are not available in this session.";
    }
    if (killJobId !== undefined) {
      const r = deps.jobs.killJob(killJobId);
      return r.found
        ? `killed background job ${killJobId} (SIGTERM now; SIGKILL after the grace period).`
        : `ERROR: no background job '${killJobId}'.`;
    }
    const rawOffset = typeof args.offset === "number" && Number.isFinite(args.offset) ? args.offset : 0;
    const offset = rawOffset > 0 ? Math.floor(rawOffset) : 0;
    const out = deps.jobs.readJobOutput(pollJobId as string, offset);
    if (!out.found) return `ERROR: no background job '${pollJobId as string}'.`;
    return formatJobOutput(pollJobId as string, out);
  }

  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (command.length === 0) {
    return "ERROR: terminal requires a non-empty 'command'";
  }
  if (background && deps.jobs === undefined) {
    return "ERROR: background processes are not available in this session.";
  }
  if (deps.parentCtx === undefined) {
    return "ERROR: terminal is unavailable (no parent identity wired to authorize the governed command).";
  }
  let tokens: string[];
  try {
    tokens = tokenizeCommand(command);
  } catch (e) {
    return `ERROR: ${e instanceof Error ? e.message : String(e)} — quote the argument correctly and retry.`;
  }
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
  // Model-facing timeout: a daily driver must be able to run a slow install / test suite past
  // the governed default. Clamp to a hard ceiling so a wedged command can never run unbounded
  // (governed-exec SIGKILLs the whole process group at the timeout — no orphaned processes).
  const requested = typeof args.timeout_ms === "number" && Number.isFinite(args.timeout_ms) ? args.timeout_ms : undefined;
  const timeoutMs = Math.min(MAX_TERMINAL_TIMEOUT_MS, Math.max(1_000, requested ?? DEFAULT_TERMINAL_TIMEOUT_MS));
  try {
    // BACKGROUND: spawn detached (no timeout) and return the job handle. Still routes through the
    // SAME governed-exec run() — gate-wall + allowlist + policy + receipt — only the wait is dropped.
    if (background) {
      const result = await deps.governedExec.run({
        parentCtx: deps.parentCtx,
        command: binary,
        args: rest,
        cwd: worktreeDir,
        worktreeRoot: worktreeDir, // the OS sandbox keeps ONLY this writable (F1)
        purpose: `builder terminal (background): ${command.slice(0, 120)}`,
        background: true,
      });
      return formatBackgroundStart(result);
    }
    const result = await deps.governedExec.run({
      parentCtx: deps.parentCtx,
      command: binary,
      args: rest,
      cwd: worktreeDir,
      worktreeRoot: worktreeDir, // the OS sandbox keeps ONLY this writable (F1)
      purpose: `builder terminal: ${command.slice(0, 120)}`,
      timeoutMs,
    });
    return formatExecResult(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `ERROR: terminal failed: ${msg}`;
  }
}

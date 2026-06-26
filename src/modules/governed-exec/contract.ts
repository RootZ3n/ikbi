/**
 * ikbi governed-exec — THE MODULE CONTRACT (versioned).
 *
 * Governed shell/curl execution. EVERY command is gated through gate-wall's `exec`
 * action (the shared enforcement layer — NOT a parallel gate) and is receipted;
 * HTTP routes through the egress SSRF guard, never the `curl` binary. Fail-closed:
 * a default-deny binary allowlist, sudo always gated, array args only (execFile, no
 * shell), and `dryRun` reports intent without executing anything.
 *
 * No frozen-core or gate-wall contract change — this consumes gate-wall ≥1.1.0's
 * exec action + the egress guarded fetch + the frozen receipt/identity/events core.
 *
 * CONTRACT_VERSION changelog (newest on top):
 *   1.1.0 — background processes. ExecRequest gains `background?`; when true the executor
 *           spawns the command DETACHED (own process group, NO wall-clock timeout) after the
 *           SAME gate-wall/allowlist/receipt path a foreground command passes, and returns
 *           immediately with a `jobId`/`pid` (ExecResult). New job-management surface on
 *           GovernedExec (listJobs/readJobOutput/killJob/jobStatus/disposeJobs) polls output,
 *           kills, and cleans up jobs. Additive — the foreground path is unchanged.
 *   1.0.0 — initial governed-exec contract: ExecRequest/ExecResult for governed
 *           command execution and HttpRequest/HttpResult for guarded HTTP. Policy is
 *           fail-closed v1: allowlist + sudo-always-gated + array-args + egress for
 *           HTTP; the gate-wall verdict decides allow/deny.
 */

import type { OperationContext } from "../../core/identity/index.js";

/** Semantic version of the governed-exec contract. Bump on breaking change. */
export const CONTRACT_VERSION = "1.1.0";

/** A request to run a governed command (array args — NEVER a shell string). */
export interface ExecRequest {
  /** The caller's operation context (must carry a ValidatedIdentity). */
  readonly parentCtx: OperationContext;
  /** The binary to run (must be on the allowlist). */
  readonly command: string;
  /** The command arguments, as a literal array (no shell parsing). */
  readonly args: readonly string[];
  /** Whether to run under sudo — ALWAYS gated regardless of tier. */
  readonly sudo?: boolean;
  /** Optional human purpose for the audit trail. */
  readonly purpose?: string;
  /** Working directory for the command. */
  readonly cwd?: string;
  /**
   * The WORKTREE ROOT this command runs against — the single host directory the OS sandbox keeps
   * WRITABLE (everything else is read-only). When absent the sandbox falls back to `cwd`. Builder /
   * verifier callers pass the realpath'd worktree so a risky subprocess (an interpreter running a
   * helper script) cannot write outside it — closing F1. See modules/governed-exec/sandbox.ts.
   */
  readonly worktreeRoot?: string;
  /**
   * Optional LIVE OUTPUT SINK (SG-1): when provided, the command's stdout/stderr are STREAMED
   * to this callback chunk-by-chunk as they arrive (so a user sees long check output live),
   * instead of only the buffered tail at the end. The returned `ExecResult` still carries the
   * bounded `stdoutTail`/`stderrTail` for logging/receipts — the truncation is for the record,
   * not the live view. Absent ⇒ the buffered path (unchanged).
   */
  readonly onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  /**
   * Optional per-call wall-clock timeout (ms) for THIS command, overriding the module default
   * (`IKBI_GOVERNED_EXEC_EXEC_TIMEOUT_MS`). Long verification checks (full test suites) pass a
   * larger budget here (IKBI_CHECK_TIMEOUT_MS) so the 30s read-only-tool default doesn't SIGKILL
   * them. Absent / non-positive ⇒ the module default applies (unchanged).
   *
   * IGNORED when `background` is true — a background process has NO wall-clock timeout (it runs
   * until it exits naturally or is killed via `killJob`).
   */
  readonly timeoutMs?: number;
  /**
   * BACKGROUND mode (dev servers, watch mode, >30s suites). When true the command is spawned
   * DETACHED — its own process group — and `run` returns IMMEDIATELY (a `jobId`/`pid` in the
   * result) WITHOUT waiting for completion. The command still passes the FULL gate-wall +
   * allowlist + policy + receipt path a foreground command does; only the wait + the timeout are
   * dropped. Output is captured for incremental polling via `readJobOutput`. Streaming (`onOutput`)
   * does NOT apply to a background command. Absent / false ⇒ the foreground path (unchanged).
   */
  readonly background?: boolean;
}

/**
 * The outcome of a governed command. `executed` is true iff the command actually
 * ran (it may still have exited non-zero — see `exitCode`). `denied` is true when
 * the gate/allowlist/config refused it (nothing ran). Output is tail-truncated.
 */
export interface ExecResult {
  readonly executed: boolean;
  readonly denied?: boolean;
  readonly reason?: string;
  readonly exitCode?: number;
  readonly stdoutTail?: string;
  readonly stderrTail?: string;
  /**
   * BACKGROUND only — the handle of the spawned job. Present iff the request set `background:true`
   * and the command was cleared to run; poll/kill the job through it (`readJobOutput`/`killJob`).
   */
  readonly jobId?: string;
  /** BACKGROUND only — the OS process id of the spawned (detached) command, when the OS reported one. */
  readonly pid?: number;
}

/** The run state of a background job. */
export type JobState = "running" | "exited" | "killed";

/** A one-line summary of a background job (for `listJobs`). Never carries the full output. */
export interface JobSummary {
  /** Short unique handle. */
  readonly id: string;
  /** The OS process id, when the OS reported one. */
  readonly pid: number | undefined;
  /** The rendered command line ("binary arg1 arg2 …"). */
  readonly command: string;
  /** Current run state. */
  readonly status: JobState;
  /** Exit code once the job has exited (absent while running). */
  readonly exitCode?: number;
}

/** The outcome of `jobStatus`. `found` is false for an unknown job id. */
export interface JobStatusResult {
  readonly found: boolean;
  readonly status?: JobState;
  readonly exitCode?: number;
}

/**
 * The outcome of `readJobOutput`. `output` is the captured stdout+stderr (interleaved in arrival
 * order) from the requested byte `offset` onward; `nextOffset` is the offset to pass on the next
 * poll to read only what is new (incremental tailing). `found` is false for an unknown job id.
 */
export interface JobOutputResult {
  readonly found: boolean;
  readonly output: string;
  readonly nextOffset: number;
  readonly status?: JobState;
  readonly exitCode?: number;
}

/** The outcome of `killJob`. `found` is false for an unknown job id (nothing was signalled). */
export interface JobKillResult {
  readonly found: boolean;
}

/** A request to perform a governed HTTP call (routed through the egress guard). */
export interface HttpRequest {
  /** The caller's operation context (must carry a ValidatedIdentity). */
  readonly parentCtx: OperationContext;
  /** The target URL — validated by the egress guard (scheme/allowlist/IP). */
  readonly url: string;
  /** The HTTP method. */
  readonly method: string;
  /** Optional request headers. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Optional request body. */
  readonly body?: string;
}

/**
 * The outcome of a governed HTTP call. `denied` is true when config/identity/the
 * egress guard refused it (the SSRF block is surfaced here, never swallowed).
 */
export interface HttpResult {
  readonly executed: boolean;
  readonly denied?: boolean;
  readonly reason?: string;
  readonly status?: number;
  readonly bodyTail?: string;
}

/** The governed-exec surface. */
export interface GovernedExec {
  run(request: ExecRequest): Promise<ExecResult>;
  fetch(request: HttpRequest): Promise<HttpResult>;
  /** List the background jobs spawned through this executor (running and finished). */
  listJobs(): JobSummary[];
  /**
   * Read a background job's captured output from byte `offset` (default 0). Returns the new bytes
   * plus the `nextOffset` for incremental polling. Unknown id ⇒ `{ found:false }`.
   */
  readJobOutput(jobId: string, offset?: number): JobOutputResult;
  /** Signal a background job: SIGTERM, then SIGKILL after a grace period. Unknown id ⇒ `{ found:false }`. */
  killJob(jobId: string): JobKillResult;
  /** The current run state of a background job. Unknown id ⇒ `{ found:false }`. */
  jobStatus(jobId: string): JobStatusResult;
  /**
   * Kill every still-running background job (SIGKILL on the process group) and remove the captured
   * output. The session-end cleanup hook — idempotent and best-effort.
   */
  disposeJobs(): void;
}

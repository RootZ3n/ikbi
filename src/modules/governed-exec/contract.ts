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
 *   1.0.0 — initial governed-exec contract: ExecRequest/ExecResult for governed
 *           command execution and HttpRequest/HttpResult for guarded HTTP. Policy is
 *           fail-closed v1: allowlist + sudo-always-gated + array-args + egress for
 *           HTTP; the gate-wall verdict decides allow/deny.
 */

import type { OperationContext } from "../../core/identity/index.js";

/** Semantic version of the governed-exec contract. Bump on breaking change. */
export const CONTRACT_VERSION = "1.0.0";

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
}

/**
 * ikbi check-triage — contract types.
 *
 * A DETERMINISTIC parser that turns raw stdout/stderr from a check command (test / build /
 * typecheck) into structured triage data: pass/fail, the failing test/error names, a one-line
 * summary, and a BOUNDED head+tail capture (never tail-only). No process spawn, no model, no IO.
 *
 * Lightweight framework patterns: node:test (TAP), vitest/jest, pytest, go test, TypeScript tsc.
 * Unknown formats degrade to a safe generic summary — the parser NEVER throws.
 *
 * @status dormant (library-only); nothing wires it (verifier/checks/builder) yet.
 */

/** Raw output of one check command. */
export interface CheckInput {
  /** Logical check name (e.g. "test" | "typecheck" | "build"). */
  readonly name: string;
  /** The command line that ran (used as a framework hint). */
  readonly command: string;
  /** Process exit code — the AUTHORITATIVE pass/fail signal (0 ⇒ passed). */
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

/** Structured triage for one check. */
export interface CheckTriage {
  /** True iff exitCode === 0 (the process is the source of truth for pass/fail). */
  readonly passed: boolean;
  /** Failing test / error identifiers (deduped, bounded, each length-capped). */
  readonly failures: readonly string[];
  /** One-line human summary (always non-empty, bounded). */
  readonly errorSummary: string;
  /** First slice of the ANSI-stripped combined output (bounded). */
  readonly head: string;
  /** Last slice of the ANSI-stripped combined output (bounded); empty when output fit in `head`. */
  readonly tail: string;
  /** True when the combined output exceeded the head+tail budget (the middle was dropped). */
  readonly truncated: boolean;
  /** Frameworks detected from the command + output (sorted, deduped). */
  readonly detectedFrameworks: readonly string[];
}

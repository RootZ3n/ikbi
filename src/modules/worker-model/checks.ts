/**
 * ikbi worker-model — THE SHARED CHECK DEFINITION.
 *
 * The single source of truth for the project's objective checks (typecheck + tests).
 * Both the VERIFIER (the pipeline's source of truth, end of run) and the BUILDER's
 * in-loop `run_checks` tool import `VERIFIER_CHECKS` FROM HERE — so the builder's
 * in-loop preview runs the verifier's EXACT checks, through the same governed-exec
 * path, against the same worktree. One definition, two callers: the builder can never
 * pass a weaker practice check and fail the real exam (they are provably the same).
 *
 * Read-only: the checks (`tsc --noEmit`, `test`) do not mutate the workspace.
 */

import type { ExecResult } from "../governed-exec/index.js";

/** A fixed check. The command list is a named constant — never model-chosen. */
export interface Check {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
}

/** THE fixed, read-only check set (the verifier's checks; the builder previews the same). */
export const VERIFIER_CHECKS: readonly Check[] = [
  { name: "typecheck", command: "pnpm", args: ["tsc", "--noEmit"] },
  { name: "test", command: "pnpm", args: ["test"] },
];

/** Captured output tail length retained in a check result. */
export const MAX_OUTPUT_TAIL = 2_000;

/** One check's outcome. Lives in the open `detail` bag — NOT a contract type. */
export interface CheckResult {
  readonly name: string;
  readonly command: string;
  readonly exitCode: number;
  readonly outputTail: string;
}

export function tail(s: string, max: number): string {
  return s.length <= max ? s : s.slice(s.length - max);
}

/** Map one governed ExecResult onto a CheckResult (fail-closed on deny / dry-run). */
export function mapExec(name: string, command: string, res: ExecResult): { check: CheckResult; dryRun: boolean } {
  if (res.executed) {
    const output = `${res.stdoutTail ?? ""}${res.stderrTail ?? ""}`;
    return { check: { name, command, exitCode: res.exitCode ?? 1, outputTail: tail(output, MAX_OUTPUT_TAIL) }, dryRun: false };
  }
  if (res.denied === true) {
    // FAIL CLOSED: a denied / non-allowlisted check is a non-zero check, NEVER a pass.
    const note = `governed-exec DENIED: ${res.reason ?? "denied"} — add "${command.split(" ")[0]}" to IKBI_GOVERNED_EXEC_ALLOWLIST for real checks`;
    return { check: { name, command, exitCode: res.exitCode ?? 1, outputTail: tail(note, MAX_OUTPUT_TAIL) }, dryRun: false };
  }
  // executed:false, not denied ⇒ DRY-RUN (governed-exec reported intent, ran nothing).
  const note = `governed-exec dry-run: ${res.reason ?? "intent only — not executed"}`;
  return { check: { name, command, exitCode: 1, outputTail: tail(note, MAX_OUTPUT_TAIL) }, dryRun: true };
}

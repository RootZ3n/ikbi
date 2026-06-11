/**
 * ikbi worker-model — ITERATIVE BUILD LOOP.
 *
 * Wraps the builder-verifier cycle with automatic fix retries. After the
 * builder finishes, runs the verifier (typecheck + tests). If verification
 * fails, extracts error output and feeds it back to the builder as a new
 * "fix" goal. Repeats up to `maxFixIterations` times.
 *
 * This is WRAPPER logic — it does not change the builder or verifier
 * internals. The builder already has early-stop and context compression;
 * this module only orchestrates the retry cycle.
 *
 * SECURITY: the fix loop reuses the SAME governed-exec path the verifier
 * and the builder's in-loop `run_checks` use. No shortcuts.
 */

import type { RoleResult } from "./contract.js";
import { formatDebugFixGoal } from "./debug-assistant.js";

/** Default max fix iterations (override via IKBI_MAX_FIX_ITERATIONS). */
export const DEFAULT_MAX_FIX_ITERATIONS = 3;

/**
 * The result of a single verification check inside the fix loop.
 * Distinct from the verifier's full `RoleResult` — this is the distilled
 * signal the loop needs to decide pass/fail and build the fix goal.
 */
export interface VerifierCheckResult {
  /** True when every check (typecheck + tests) passed. */
  readonly success: boolean;
  /** Concatenated error output from failed checks (raw, for the fix goal). */
  readonly errors: string;
  /** Whether typecheck passed (best-effort parsed from check results). */
  readonly typecheckPassed: boolean;
  /** Whether tests passed (best-effort parsed from check results). */
  readonly testsPassed: boolean;
}

/** Dependencies injected into the iterative loop. */
export interface IterativeLoopDeps {
  /** Max number of verify→fix cycles. Default: DEFAULT_MAX_FIX_ITERATIONS. */
  readonly maxFixIterations?: number;
  /**
   * Run the verifier's checks against the workspace. Returns a distilled
   * pass/fail + error output. Called once per loop iteration.
   */
  readonly verifier: () => Promise<VerifierCheckResult>;
  /**
   * Run the builder with a goal string. On the first call this is the
   * original goal; on subsequent calls it is a synthesized fix goal
   * containing the verifier's error output.
   */
  readonly builder: (goal: string) => Promise<RoleResult>;
}

/** The outcome of the iterative loop. */
export interface IterativeLoopOutcome {
  /**
   * The final builder result. On a successful verification this is the
   * builder result from the last successful build (preserving its detail).
   * On failure this is either a builder failure or a synthetic
   * "fix_iterations_exhausted" result.
   */
  readonly buildResult: RoleResult;
  /** Number of fix iterations actually performed (0 = first-try pass). */
  readonly fixIterations: number;
  /** The last verifier result seen (undefined if the loop body never ran). */
  readonly lastVerifierResult?: VerifierCheckResult;
}

/**
 * Run the iterative build-fix loop.
 *
 * ASSUMES the initial build has already completed successfully — the loop
 * starts by VERIFYING the current workspace state. Call this after the
 * builder's first successful dispatch.
 *
 * Flow:
 *   verify → pass? → return (fixIterations = 0)
 *   verify → fail → build fix → build fail? → return builder failure
 *   verify → fail → build fix → build pass → verify → ... (repeat)
 *   after maxIterations → final verify → pass? → return
 *   after maxIterations → final verify → fail → return exhausted failure
 */
export async function runIterativeLoop(
  initialBuildResult: RoleResult,
  deps: IterativeLoopDeps,
): Promise<IterativeLoopOutcome> {
  const maxIterations = deps.maxFixIterations ?? DEFAULT_MAX_FIX_ITERATIONS;
  let currentBuildResult = initialBuildResult;

  for (let i = 0; i < maxIterations; i++) {
    const verifyResult = await deps.verifier();
    if (verifyResult.success) {
      return { buildResult: currentBuildResult, fixIterations: i, lastVerifierResult: verifyResult };
    }

    // Feed errors back to the builder as a fix goal.
    const fixGoal = formatFixGoal(verifyResult.errors);
    currentBuildResult = await deps.builder(fixGoal);
    if (currentBuildResult.outcome !== "success") {
      return { buildResult: currentBuildResult, fixIterations: i + 1, lastVerifierResult: verifyResult };
    }
  }

  // Exhausted all iterations — one final verify.
  const finalVerify = await deps.verifier();
  if (finalVerify.success) {
    return { buildResult: currentBuildResult, fixIterations: maxIterations, lastVerifierResult: finalVerify };
  }

  // Still failing after all fix attempts.
  return {
    buildResult: {
      role: "builder",
      outcome: "failure",
      summary: `verification still failing after ${maxIterations} fix iteration(s)`,
      detail: {
        stopReason: "fix_iterations_exhausted",
        fixIterations: maxIterations,
        lastErrors: finalVerify.errors,
        typecheckPassed: finalVerify.typecheckPassed,
        testsPassed: finalVerify.testsPassed,
      },
    },
    fixIterations: maxIterations,
    lastVerifierResult: finalVerify,
  };
}

/** Format a fix goal from the verifier's error output. */
function formatFixGoal(errors: string): string {
  return formatDebugFixGoal(errors);
}

/**
 * Extract a distilled VerifierCheckResult from the verifier's RoleResult.
 * The verifier returns a full RoleResult with `detail.checks` — this helper
 * parses it into the compact signal the iterative loop needs.
 */
export function extractVerifierCheckResult(vResult: RoleResult): VerifierCheckResult {
  const detail = (vResult.detail ?? {}) as Record<string, unknown>;
  const checks = Array.isArray(detail.checks)
    ? (detail.checks as Array<{ name: string; exitCode: number; outputTail: string }>)
    : [];
  const find = (name: string) => checks.find((c) => c.name === name);
  const typecheckPassed = (find("typecheck")?.exitCode ?? 1) === 0;
  const testsPassed = (find("test")?.exitCode ?? 1) === 0;
  const failedChecks = checks.filter((c) => c.exitCode !== 0);
  const errors = failedChecks.map((c) => `[${c.name}] ${c.outputTail}`).join("\n");
  return {
    success: vResult.outcome === "success",
    errors: failedChecks.length > 0 ? errors : (vResult.outcome !== "success" ? (vResult.summary ?? "unknown verification error") : ""),
    typecheckPassed,
    testsPassed,
  };
}

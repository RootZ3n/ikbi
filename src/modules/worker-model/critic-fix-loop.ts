/**
 * ikbi worker-model — CRITIC-DRIVEN FIX LOOP.
 *
 * A critic FAIL used to be able only to KILL a build (the integrator's AND-gate
 * discards on `critic.pass !== true`) — the strong critic model's feedback was
 * computed and then thrown away. This module turns a subjective FAIL into a fix
 * goal: it formats the critic's feedback + issues the same way the verifier's
 * errors are formatted, retries the builder ONCE with that goal, re-verifies, and
 * re-critiques. The single retry is deliberate — subjective feedback must not loop
 * forever (unlike the verifier-driven loop, whose objective red/green converges).
 *
 * This is WRAPPER logic — it does not change the builder, verifier, or critic
 * internals. It is COMPLEMENTARY to the verifier-driven `runIterativeLoop`: that
 * one retries on RED objective checks; this one retries on a GREEN-but-wrong build
 * the critic flagged. The two never fight — by the time the critic runs, the
 * verifier already passed (a red verifier short-circuits before the critic).
 */

import type { RoleResult } from "./contract.js";

/** Safe accessor for a role result's open detail bag. */
function detailOf(result: RoleResult | undefined): Record<string, unknown> {
  const d = result?.detail;
  return typeof d === "object" && d !== null ? (d as Record<string, unknown>) : {};
}

/**
 * Format the critic's feedback as a builder fix goal — the critic-side analogue of
 * `formatDebugFixGoal`. Mirrors that shape ("…found problems. Fix them:") so the
 * builder sees a consistent repair instruction whether the source was the verifier
 * (objective errors) or the critic (subjective review).
 */
export function formatCriticFixGoal(feedback: string, issues: readonly string[]): string {
  const parts: string[] = ["The critic REJECTED your work. Address its feedback and fix the issues:", ""];
  const fb = feedback.trim();
  if (fb.length > 0) parts.push(`Critic feedback: ${fb}`);
  const cleaned = issues.map((i) => i.trim()).filter((i) => i.length > 0);
  if (cleaned.length > 0) {
    parts.push("", `Specific issues (${cleaned.length}):`);
    for (let i = 0; i < cleaned.length; i++) parts.push(`${i + 1}. ${cleaned[i]}`);
  }
  parts.push("", "Make the minimal change that resolves these concerns without breaking the passing checks.");
  return parts.join("\n");
}

/** Dependencies injected into the critic-fix loop. */
export interface CriticFixLoopDeps {
  /** Re-run the builder with the critic-derived fix goal. */
  readonly builder: (fixGoal: string) => Promise<RoleResult>;
  /**
   * Re-run the verifier against the (now-modified) workspace. Receives the fresh
   * builder result so the caller can thread it into the verifier's priorResults.
   */
  readonly verifier: (builderResult: RoleResult) => Promise<RoleResult>;
  /**
   * Re-run the critic against the fresh state. Receives the fresh builder + verifier
   * results so the caller can thread them into the critic's priorResults.
   */
  readonly critic: (builderResult: RoleResult, verifierResult: RoleResult) => Promise<RoleResult>;
}

/** The outcome of a critic-fix attempt. */
export interface CriticFixLoopOutcome {
  /** Did a retry actually run? (false when the verdict was not a retryable subjective FAIL.) */
  readonly ran: boolean;
  /** The FINAL critic result — the re-critique when a retry ran, else the original verdict. */
  readonly criticResult: RoleResult;
  /** The retry builder result (present iff a retry ran). */
  readonly builderResult?: RoleResult;
  /** The re-verify result (present iff the retry builder succeeded). */
  readonly verifierResult?: RoleResult;
}

/**
 * Decide whether a critic result is a RETRYABLE subjective FAIL.
 *
 * Retry ONLY a critique that actually RAN and produced a model FAIL verdict
 * (`outcome: "success"` + `detail.pass === false`). The fail-closed OBJECTIVE
 * gates (`detail.objectiveFailure`: empty diff, missing files, unparseable verdict,
 * truncated response, no diff source) are NOT subjective feedback the builder can
 * act on — retrying them is pointless and risks churn, so they are excluded.
 */
export function isRetryableCriticFail(criticResult: RoleResult): boolean {
  const d = detailOf(criticResult);
  return criticResult.outcome === "success" && d.pass === false && d.objectiveFailure !== true;
}

/**
 * Run the single-shot critic-driven fix loop.
 *
 * Flow (at most ONE retry):
 *   critic FAIL? no  → return { ran:false } (original verdict stands)
 *   critic FAIL? yes → builder(fixGoal)
 *                        builder failed → return { ran:true } keeping the ORIGINAL FAIL (fail-closed)
 *                        builder ok     → verifier → critic → return the RE-critique verdict
 */
export async function runCriticFixLoop(
  criticResult: RoleResult,
  deps: CriticFixLoopDeps,
): Promise<CriticFixLoopOutcome> {
  if (!isRetryableCriticFail(criticResult)) {
    return { ran: false, criticResult };
  }

  const d = detailOf(criticResult);
  const feedback = typeof d.feedback === "string" ? d.feedback : "";
  const issues = Array.isArray(d.issues) ? d.issues.filter((x): x is string => typeof x === "string") : [];
  const fixGoal = formatCriticFixGoal(feedback, issues);

  const builderResult = await deps.builder(fixGoal);
  if (builderResult.outcome !== "success") {
    // The builder could not act on the feedback — keep the ORIGINAL FAIL verdict so the
    // integrator still discards (fail-closed). Surface the retry builder for the trail.
    return { ran: true, criticResult, builderResult };
  }

  const verifierResult = await deps.verifier(builderResult);
  const reCritique = await deps.critic(builderResult, verifierResult);
  return { ran: true, criticResult: reCritique, builderResult, verifierResult };
}

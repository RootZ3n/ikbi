/**
 * ikbi escalation — THE CONTEXT HANDOFF BUILDER.
 *
 * When a task crosses a tier, the new (more expensive) model must NOT start cold.
 * This packages everything it needs to do better than its predecessor:
 *   • the original goal + the failing attempts (model, tier, outcome, score, reasons),
 *   • the scout's findings, the critic's feedback, the verifier's failure detail,
 *   • the prior conversation history (opaque — threaded straight through),
 *   • a human-readable reason explaining WHY escalation fired (the score breakdown).
 *
 * Pure + deterministic: same context + score ⇒ same handoff string.
 */

import type {
  AttemptSummary,
  EscalationContext,
  EscalationHandoff,
  EscalationScore,
  EscalationRecord,
  ModelTier,
} from "./contract.js";

/** Render the score breakdown as a stable, sorted, human-readable string. */
export function formatScoreBreakdown(score: EscalationScore): string {
  const parts = Object.keys(score.breakdown)
    .sort()
    .filter((k) => (score.breakdown[k] ?? 0) > 0)
    .map((k) => `${k}=${round2(score.breakdown[k] ?? 0)}`);
  const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `score ${round2(score.total)}/100${detail}`;
}

/** Build the one-line escalation reason: tier transition + score breakdown. */
export function escalationReason(from: ModelTier, to: ModelTier, score: EscalationScore): string {
  return `escalating ${from}→${to}: ${formatScoreBreakdown(score)}`;
}

/** Summarize the CURRENT (failing) attempt for the handoff. */
function currentAttempt(context: EscalationContext, score: EscalationScore): AttemptSummary {
  return Object.freeze({
    model: context.currentModel ?? "(unknown)",
    tier: context.currentTier,
    outcome: context.outcomeSummary ?? "failed",
    score: score.total,
    failureReasons: Object.freeze([...(context.failureReasons ?? [])]),
  });
}

/**
 * Reconstruct prior-attempt summaries from the recorded tier transitions. Each
 * record marks a transition INTO `to`; we surface the source tier as a prior
 * attempt so the handoff shows the full escalation chain (detail is bounded — the
 * records only retain tiers, not full per-attempt signals).
 */
function priorAttempts(history: readonly EscalationRecord[]): AttemptSummary[] {
  return history.map((r) =>
    Object.freeze({
      model: "(prior tier)",
      tier: r.from,
      outcome: "escalated",
      score: 0,
      failureReasons: Object.freeze([]) as readonly string[],
    }),
  );
}

/**
 * Build the full handoff package for a transition `from → to`.
 *
 * @param history prior escalation records for this task (oldest first).
 */
export function buildHandoff(
  context: EscalationContext,
  score: EscalationScore,
  to: ModelTier,
  history: readonly EscalationRecord[] = [],
): EscalationHandoff {
  const previousAttempts: AttemptSummary[] = [...priorAttempts(history), currentAttempt(context, score)];

  return Object.freeze({
    goal: context.goal,
    previousAttempts: Object.freeze(previousAttempts),
    ...(context.scoutFindings !== undefined ? { scoutFindings: context.scoutFindings } : {}),
    ...(context.criticFeedback !== undefined ? { criticFeedback: context.criticFeedback } : {}),
    ...(context.verificationDetails !== undefined ? { verificationDetails: context.verificationDetails } : {}),
    ...(context.conversationHistory !== undefined
      ? { conversationHistory: Object.freeze([...context.conversationHistory]) }
      : {}),
    escalationReason: escalationReason(context.currentTier, to, score),
  });
}

/** Round to 2 decimals for stable display (does not affect the underlying score). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

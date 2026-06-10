/**
 * ikbi escalation — THE DETERMINISTIC SCORER.
 *
 * A PURE function: `EscalationSignals` + `EscalationWeights` → `EscalationScore`.
 * No side effects, no model calls, no IO, no clock. The SAME inputs ALWAYS produce
 * the SAME output — this is the load-bearing property of the whole engine (an
 * operator can replay any escalation decision from the recorded signals).
 *
 * Per-signal contribution (each clamped to a non-negative cap so one signal can
 * never dominate or go negative):
 *
 *   schemaFailures      min(n * w, 30)              count, capped
 *   retryCount          min(n * w, 20)              count, capped
 *   scoutScore          (1 - score) * w             INVERTED (low score ⇒ high pressure); 0 if absent
 *   contextPressure     pressure * w                fraction 0-1
 *   criticRejected      w if true else 0            binary
 *   verificationFailed  w if true else 0            binary
 *   rejectedToolCalls   min(n * (w / 3), 15)        count, normalized + capped
 *   benchmarkPassRate   (1 - rate) * w              INVERTED (low pass rate ⇒ high pressure); 0 if absent
 *
 * The total is the sum, clamped to [0, 100]. `shouldEscalate` is left FALSE here —
 * the scorer has no tier context; the policy resolves it.
 */

import type { EscalationScore, EscalationSignals, EscalationWeights } from "./contract.js";

/** Absolute caps (independent of the configured weights). */
const CAP_SCHEMA_FAILURES = 30;
const CAP_RETRY_COUNT = 20;
const CAP_REJECTED_TOOL_CALLS = 15;

/** Clamp `n` to `[0, cap]`. */
function capped(n: number, cap: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > cap ? cap : n;
}

/** Clamp `n` to `[0, +∞)` (a bare floor; no upper cap). */
function floored(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Compute the escalation score for one attempt. Pure + deterministic.
 *
 * `shouldEscalate` is always `false` and `targetTier` is always absent on the
 * returned score — the policy fills those in once it knows the tier + threshold.
 */
export function computeScore(signals: EscalationSignals, weights: EscalationWeights): EscalationScore {
  const breakdown: Record<string, number> = {
    schemaFailures: capped(signals.schemaFailures * weights.schemaFailures, CAP_SCHEMA_FAILURES),
    retryCount: capped(signals.retryCount * weights.retryCount, CAP_RETRY_COUNT),
    scoutScore: signals.scoutScore === undefined ? 0 : floored((1 - signals.scoutScore) * weights.scoutScore),
    contextPressure: floored(signals.contextPressure * weights.contextPressure),
    criticRejected: signals.criticRejected ? weights.criticRejected : 0,
    verificationFailed: signals.verificationFailed ? weights.verificationFailed : 0,
    rejectedToolCalls: capped(signals.rejectedToolCalls * (weights.rejectedToolCalls / 3), CAP_REJECTED_TOOL_CALLS),
    benchmarkPassRate:
      signals.benchmarkPassRate === undefined ? 0 : floored((1 - signals.benchmarkPassRate) * weights.benchmarkPassRate),
  };

  let sum = 0;
  for (const key of Object.keys(breakdown)) sum += breakdown[key] ?? 0;
  const total = sum > 100 ? 100 : sum;

  return Object.freeze({
    total,
    breakdown: Object.freeze(breakdown),
    shouldEscalate: false,
  });
}

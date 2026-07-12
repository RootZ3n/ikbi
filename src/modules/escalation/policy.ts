/**
 * ikbi escalation — THE POLICY.
 *
 * Maps tiers to their successor + model roster, owns the thresholds, and turns a
 * bare score into a tier-aware verdict. Pure: every input it needs (thresholds,
 * weights→already applied, rosters, the current escalation count) is passed in, so
 * it is trivially testable and deterministic.
 *
 * THE TWO GATES this encodes:
 *   • worker→mid is AUTOMATIC — `requiresApproval` stays false.
 *   • mid→frontier ALWAYS sets `requiresApproval: true` — there is no code path
 *     that escalates to frontier without it.
 */

import type { EscalationConfig, EscalationScore, ModelTier } from "./contract.js";
import { MODEL_TIERS } from "./contract.js";

/** The next tier up, or `undefined` when already at the top (frontier). */
export function nextTier(tier: ModelTier): ModelTier | undefined {
  const i = MODEL_TIERS.indexOf(tier);
  if (i < 0 || i >= MODEL_TIERS.length - 1) return undefined;
  return MODEL_TIERS[i + 1];
}

/** The score threshold a tier must cross to escalate, or `undefined` at the top. */
export function thresholdFor(tier: ModelTier, config: EscalationConfig): number | undefined {
  if (tier === "worker") return config.workerToMidThreshold;
  if (tier === "mid") return config.midToFrontierThreshold;
  return undefined; // frontier has no successor
}

/**
 * The model the retry should switch to for `tier`, or `undefined` for an empty roster.
 *
 * With no `isResolvable` predicate this is the first roster entry (pure, deterministic).
 * WITH the predicate (the engine wires it from the provider registry), it returns the
 * first roster model that resolves to a REGISTERED provider — so an unwired/stub tier
 * model (e.g. an `opus-4.8` stub with no API route) is transparently skipped rather than
 * chosen as the target and dead-ended on invocation. If none resolve, it falls back to
 * the first entry (unchanged behavior — the invocation then fails gracefully as before).
 */
export function modelFor(
  tier: ModelTier,
  config: EscalationConfig,
  isResolvable?: (modelId: string) => boolean,
): string | undefined {
  const roster = config.tierModels[tier];
  if (roster.length === 0) return undefined;
  if (isResolvable !== undefined) {
    const wired = roster.find((m) => isResolvable(m));
    if (wired !== undefined) return wired;
  }
  return roster[0];
}

/** A tier-aware verdict the engine wraps into a full `EscalationDecision`. */
export interface PolicyOutcome {
  /** The score, enriched with `shouldEscalate` + `targetTier` (the threshold view). */
  readonly score: EscalationScore;
  /** Whether to escalate now (threshold crossed AND under the per-task cap). */
  readonly escalate: boolean;
  /** The tier to escalate to — present only when `escalate === true`. */
  readonly targetTier?: ModelTier;
  /** Human approval required — true iff escalating to frontier. */
  readonly requiresApproval: boolean;
  /** The model to switch to — present only when `escalate === true`. */
  readonly targetModel?: string;
  /** Why escalation was declined despite the score (cap hit / already at top). */
  readonly declineReason?: string;
}

/**
 * Decide, for `currentTier` and a bare `raw` score, whether to escalate.
 *
 * @param escalationCount how many escalations this task has already taken (cap input).
 */
export function decideEscalation(
  raw: EscalationScore,
  currentTier: ModelTier,
  config: EscalationConfig,
  escalationCount: number,
  isResolvable?: (modelId: string) => boolean,
): PolicyOutcome {
  const target = nextTier(currentTier);
  const threshold = thresholdFor(currentTier, config);

  // Already at the top tier — there is nowhere to escalate.
  if (target === undefined || threshold === undefined) {
    return {
      score: Object.freeze({ total: raw.total, breakdown: raw.breakdown, shouldEscalate: false }),
      escalate: false,
      requiresApproval: false,
      declineReason: `already at the frontier tier (no higher tier than "${currentTier}")`,
    };
  }

  const crossed = raw.total >= threshold;
  const underCap = escalationCount < config.maxEscalations;
  const escalate = crossed && underCap;

  const score: EscalationScore = Object.freeze({
    total: raw.total,
    breakdown: raw.breakdown,
    shouldEscalate: crossed,
    ...(crossed ? { targetTier: target } : {}),
  });

  if (!escalate) {
    return {
      score,
      escalate: false,
      requiresApproval: false,
      ...(crossed && !underCap
        ? { declineReason: `escalation cap reached (${config.maxEscalations} transition(s) already taken)` }
        : {}),
    };
  }

  const targetModel = modelFor(target, config, isResolvable);
  return {
    score,
    escalate: true,
    targetTier: target,
    requiresApproval: target === "frontier",
    ...(targetModel !== undefined ? { targetModel } : {}),
  };
}

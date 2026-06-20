/**
 * ikbi trust system — the deterministic transition engine (pure).
 *
 * Given the prior durable state and one VALIDATED outcome, compute the next state
 * and any tier transition. RULE-BASED + DETERMINISTIC (no model call, no
 * randomness) so decisions are predictable, auditable, and cheap-model-safe.
 *
 * Anti-gaming:
 *   - Promotion credit comes ONLY from substantive successes (read-only/no-op
 *     operations are excluded) AND a streak must span >= `minDistinctOps` DISTINCT
 *     substantive operations — so an agent cannot farm a run of trivial/identical
 *     self-triggerable successes to climb.
 *   - Demotion is fast (a short failure streak, or a single rejected/injection
 *     event). Any failure / rejection / partial / injection resets the promotion
 *     streak (and its op-diversity set).
 *   - An injection attempt sets a NON-RECOVERABLE flag: while flagged, promotion is
 *     blocked entirely — an operator reset is required. Quality-failure demotion
 *     remains recoverable.
 *   - Demotion below the floor and promotion above the kind ceiling are impossible.
 */

import type { IdentityKind } from "../identity/contract.js";
import {
  AGENT_CEILING,
  asTier,
  clampTier,
  demoteTier,
  isPromotableOperation,
  MAX_TRANSITIONS,
  promoteTier,
  type RecordOutcomeInput,
  TRUST_CONTRACT_VERSION,
  TRUST_FLOOR,
  type TrustState,
  type TrustTransition,
} from "./contract.js";

export interface RuleOptions {
  readonly promoteStreak: number;
  readonly demoteStreak: number;
  /** Min distinct substantive operations a promotion streak must span. */
  readonly minDistinctOps: number;
  readonly now: number;
  /**
   * Time window (ms) for failure decay. If the last failure was more than this
   * many milliseconds ago, the consecutive-failure streak resets to 0 before
   * evaluating the current outcome. Default: undefined (no decay — legacy behavior).
   * Recommended: 4 hours (14_400_000) for production; keeps "consecutive" temporal.
   */
  readonly failureWindowMs?: number;
}

export interface ApplyResult {
  readonly state: TrustState;
  readonly transition?: TrustTransition;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Build a fresh trust state for an agent from its registry default (clamped into bounds). */
export function freshState(
  input: { agentId: string; kind: IdentityKind; defaultTrustTier: string },
  now: number,
): TrustState {
  const start = clampTier(asTier(input.defaultTrustTier, "probation"), TRUST_FLOOR, AGENT_CEILING);
  return {
    contractVersion: TRUST_CONTRACT_VERSION,
    agentId: input.agentId,
    kind: input.kind,
    defaultTrustTier: start,
    tier: start,
    successCount: 0,
    failureCount: 0,
    partialCount: 0,
    rejectedCount: 0,
    injectionFlags: 0,
    injectionFlagged: false,
    promotableStreak: 0,
    streakOperations: [],
    consecutiveFailures: 0,
    operations: {},
    transitions: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Apply one validated outcome to the prior state. Pure: returns a new state (+ transition). */
export function applyOutcome(
  prev: TrustState | undefined,
  input: RecordOutcomeInput,
  opts: RuleOptions,
): ApplyResult {
  const base = prev ?? freshState(input, opts.now);
  const operations: Record<string, number> = { ...base.operations };
  operations[input.operation] = (operations[input.operation] ?? 0) + 1;
  const s: Mutable<TrustState> = {
    ...base,
    operations,
    transitions: [...base.transitions],
    streakOperations: [...base.streakOperations],
  };

  const injection = input.signals?.injection === true;
  const promotable = input.status === "success" && isPromotableOperation(input.operation);

  // FIX 6: time-windowed failure decay. If the last failure was more than
  // `failureWindowMs` ago, reset the consecutive-failure streak so stale
  // failures don't accumulate across idle periods.
  if (opts.failureWindowMs !== undefined && s.lastFailureAt !== undefined && (opts.now - s.lastFailureAt) > opts.failureWindowMs) {
    s.consecutiveFailures = 0;
  }

  // --- counters + streaks ---
  switch (input.status) {
    case "success":
      s.successCount += 1;
      // FIX C: any success breaks the consecutive-failure streak so cross-build
      // accumulation stops.  Previously consecutiveFailures was NEVER reset on
      // success — it only reset AFTER a demotion fired, meaning failures could
      // accumulate across builds and trigger a delayed demotion.
      s.consecutiveFailures = 0;
      if (promotable) {
        s.promotableStreak += 1;
        if (!s.streakOperations.includes(input.operation)) {
          s.streakOperations = [...s.streakOperations, input.operation];
        }
      }
      // read-only success is neutral (doesn't build OR reset the promotion streak)
      break;
    case "failure":
      s.failureCount += 1;
      s.consecutiveFailures += 1;
      s.lastFailureAt = opts.now;
      s.promotableStreak = 0;
      s.streakOperations = [];
      break;
    case "rejected":
      s.rejectedCount += 1;
      s.consecutiveFailures += 1;
      s.lastFailureAt = opts.now;
      s.promotableStreak = 0;
      s.streakOperations = [];
      break;
    case "partial":
      s.partialCount += 1;
      // FIX 1C: partial is not a failure — reset consecutive failures so
      // "consecutive" means consecutive failures, not failures-since-last-success.
      s.consecutiveFailures = 0;
      s.promotableStreak = 0;
      s.streakOperations = [];
      break;
  }
  if (injection) {
    s.injectionFlags += 1;
    s.promotableStreak = 0;
    s.streakOperations = [];
  }

  // --- deterministic transition evaluation (demotion wins ties) ---
  const demote = injection || input.status === "rejected" || s.consecutiveFailures >= opts.demoteStreak;
  const promotionReady =
    !demote &&
    !s.injectionFlagged && // injection-flagged agents cannot auto-recover
    s.promotableStreak >= opts.promoteStreak &&
    s.streakOperations.length >= opts.minDistinctOps;

  let transition: TrustTransition | undefined;
  if (demote) {
    if (injection) {
      s.injectionFlagged = true;
      s.flaggedAt = opts.now;
      s.flagReason = "injection_attempt";
    }
    const to = demoteTier(s.tier, TRUST_FLOOR);
    const reason = injection
      ? "injection_attempt"
      : input.status === "rejected"
        ? "rejected_work"
        : `consecutive_failures>=${opts.demoteStreak}`;
    if (to !== s.tier) {
      transition = { at: opts.now, direction: "demote", from: s.tier, to, reason };
      s.tier = to;
      s.transitions = [...s.transitions, transition].slice(-MAX_TRANSITIONS);
      s.lastTransition = transition;
    }
    s.consecutiveFailures = 0;
    s.promotableStreak = 0;
    s.streakOperations = [];
  } else if (promotionReady) {
    const to = promoteTier(s.tier, AGENT_CEILING);
    if (to !== s.tier) {
      transition = {
        at: opts.now,
        direction: "promote",
        from: s.tier,
        to,
        reason: `promotable_streak>=${opts.promoteStreak}&distinct_ops>=${opts.minDistinctOps}`,
      };
      s.tier = to;
      s.transitions = [...s.transitions, transition].slice(-MAX_TRANSITIONS);
      s.lastTransition = transition;
    }
    s.promotableStreak = 0;
    s.streakOperations = [];
  }

  // Security backstop: the tier is always within [floor, ceiling].
  s.tier = clampTier(s.tier, TRUST_FLOOR, AGENT_CEILING);
  s.lastOutcomeAt = opts.now;
  s.updatedAt = opts.now;

  return { state: s as TrustState, ...(transition ? { transition } : {}) };
}

/** Operator reset: clear the non-recoverable injection flag (operator action only). */
export function clearInjectionFlag(prev: TrustState, now: number): TrustState {
  const s: Mutable<TrustState> = { ...prev, operations: { ...prev.operations }, transitions: [...prev.transitions], streakOperations: [] };
  s.injectionFlagged = false;
  delete s.flaggedAt;
  delete s.flagReason;
  s.promotableStreak = 0;
  s.consecutiveFailures = 0;
  s.updatedAt = now;
  return s as TrustState;
}

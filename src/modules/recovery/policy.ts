/**
 * ikbi recovery — the pure pool/decision layer.
 *
 *   recoveryFloor()   — the monotonic tier floor (highest tier used so far): the "up the ladder"
 *                       invariant. Recovery never drops below it.
 *   eligiblePool()    — every untried model at-or-above the floor and within the auto ceiling,
 *                       cost-ascending: the set ikbi may "call upon any of" next.
 *   decideRecovery()  — the next action: attempt a pool model (the caller's requested one when
 *                       eligible, else cheapest-first), consult the frontier (only when
 *                       authorized), or terminate (recovered / exhausted / needs-authorization).
 *
 * No side effects, no model calls. The orchestrator enacts the action and owns trust.
 */

import { rankModelsInTier, TIER_ORDER } from "../model-router/index.js";
import type {
  ModelTier,
  RecoveryAction,
  RecoveryAttempt,
  RecoveryCandidate,
  RecoveryInput
} from "./contract.js";

function tierRank(tier: ModelTier): number {
  return TIER_ORDER.indexOf(tier);
}

/** The monotonic floor: the highest tier any attempt has used, or `startTier` if none. */
export function recoveryFloor(attempts: readonly RecoveryAttempt[], startTier: ModelTier = "worker"): ModelTier {
  let floor = startTier;
  for (const a of attempts) {
    if (tierRank(a.tier) > tierRank(floor)) floor = a.tier;
  }
  return floor;
}

/**
 * The eligible pool, cheapest-first: untried models whose tier is in [floor, autoCeiling].
 * This is the set "ikbi can call upon any of" — bounded by the up-the-ladder floor and the
 * no-silent-frontier ceiling.
 */
export function eligiblePool(input: RecoveryInput): RecoveryCandidate[] {
  const autoCeiling = input.autoCeiling ?? "mid";
  const floor = recoveryFloor(input.attempts, input.startTier ?? "worker");
  const tried = new Set(input.attempts.map((a) => a.model));

  const pool: RecoveryCandidate[] = [];
  for (const tier of TIER_ORDER) {
    if (tierRank(tier) < tierRank(floor) || tierRank(tier) > tierRank(autoCeiling)) continue;
    for (const c of rankModelsInTier(input.tierRosters[tier], input.leaderboard ?? [])) {
      if (tried.has(c.id)) continue;
      pool.push({
        tier,
        model: c.id,
        ...(c.costPerMTok !== undefined ? { costPerMTok: c.costPerMTok } : {}),
        ...(c.score !== undefined ? { score: c.score } : {})
      });
    }
  }
  // Cheapest-first across the whole pool; ties keep tier order (lower tier first), then list order.
  const anyCost = pool.some((c) => c.costPerMTok !== undefined);
  return pool
    .map((c, index) => ({ c, index }))
    .sort((a, b) => {
      if (anyCost) {
        const ca = a.c.costPerMTok ?? Infinity;
        const cb = b.c.costPerMTok ?? Infinity;
        if (ca !== cb) return ca - cb;
      }
      const ta = tierRank(a.c.tier);
      const tb = tierRank(b.c.tier);
      if (ta !== tb) return ta - tb;
      return a.index - b.index;
    })
    .map((entry) => entry.c);
}

export function decideRecovery(input: RecoveryInput): RecoveryAction {
  const frontierAuthorized = input.frontierAuthorized ?? false;

  // A verified-green attempt resolved the failure — the loop is done.
  const last = input.attempts[input.attempts.length - 1];
  if (last?.outcome === "green") {
    return { kind: "terminate", terminal: "recovered", reason: `recovered on ${last.tier}/${last.model}` };
  }

  const pool = eligiblePool(input);

  if (pool.length > 0) {
    // Honor an explicit, still-eligible request ("call upon any model it needs"); else cheapest.
    if (input.requestedModel !== undefined) {
      const chosen = pool.find((c) => c.model === input.requestedModel);
      if (chosen !== undefined) {
        return { kind: "attempt", tier: chosen.tier, model: chosen.model, requested: true, reason: "caller-requested model (eligible, up the ladder)" };
      }
    }
    const next = pool[0]!;
    return { kind: "attempt", tier: next.tier, model: next.model, requested: false, reason: `cheapest eligible model at-or-above the ${recoveryFloor(input.attempts, input.startTier ?? "worker")} floor` };
  }

  // Pool exhausted (worker+mid all tried from the floor up). Only the gated frontier remains.
  if (!frontierAuthorized) {
    return { kind: "terminate", terminal: "needs-authorization", reason: "worker+mid pool exhausted; frontier (consult) requires authorization" };
  }
  if (input.attempts.some((a) => a.tier === "frontier")) {
    return { kind: "terminate", terminal: "exhausted", reason: "frontier consult already attempted and did not recover" };
  }
  return { kind: "consult", tier: "frontier", reason: "worker+mid pool exhausted; escalating to a frontier consult" };
}

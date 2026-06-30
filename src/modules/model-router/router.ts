/**
 * ikbi model-router — resolveModel: the "cheapest sufficient model" decision.
 *
 * Pure composition over escalation's tier rosters and model-evaluation's Luak ranking.
 * No model calls, no filesystem, no network — deterministic given its inputs, so the whole
 * thing is unit-testable. This is the keystone both the consult path and the cascade share:
 * consultModel() is just resolveModel({ role: "consultant", requestedTier: "frontier" }).
 */

import { pickCheapestAboveThreshold, rankCandidates } from "../model-evaluation/index.js";
import type { LuakLeaderboardEntry, ModelTier, RankCandidate, RosterModel } from "./contract.js";
import {
  ModelRouterError,
  ROLE_MIN_SCORE,
  ROLE_TIER_BOUNDS,
  TIER_ORDER
} from "./contract.js";
import type {
  ResolveModelInput,
  ResolveModelResult,
  RouterRole,
  TierBounds,
  TierSelection
} from "./contract.js";

function tierRank(tier: ModelTier): number {
  return TIER_ORDER.indexOf(tier);
}

/** The role's [floor, ceiling] tier bounds. */
export function tierBounds(role: RouterRole): TierBounds {
  return ROLE_TIER_BOUNDS[role];
}

/** Clamp a requested tier into [floor, ceiling]; returns the same tier when already in range. */
export function clampTier(requested: ModelTier, bounds: TierBounds): ModelTier {
  if (tierRank(requested) < tierRank(bounds.floor)) {
    return bounds.floor;
  }
  if (tierRank(requested) > tierRank(bounds.ceiling)) {
    return bounds.ceiling;
  }
  return requested;
}

/** Lift bare roster ids (escalation config) into RosterModels without cost/leaderboard data. */
export function rosterFromIds(ids: readonly string[]): RosterModel[] {
  return ids.map((id) => ({ id }));
}

/**
 * Pick the cheapest model in a tier's roster scoring >= minScore (Luak), or the roster's
 * first entry when no leaderboard row matches. Returns undefined only for an empty roster.
 */
export function selectModelInTier(
  roster: readonly RosterModel[],
  leaderboard: readonly LuakLeaderboardEntry[],
  minScore: number
): TierSelection | undefined {
  if (roster.length === 0) {
    return undefined;
  }
  const ranked = rankCandidates(roster, leaderboard);
  const pick = pickCheapestAboveThreshold(ranked, minScore);
  if (pick !== undefined) {
    return {
      modelId: pick.id,
      via: "luak-cheapest-above-threshold",
      ...(pick.score !== undefined ? { score: pick.score } : {})
    };
  }
  // No measured row qualified — keep the roster's intended primary.
  return { modelId: roster[0]!.id, via: "roster-first-fallback" };
}

/**
 * The ORDERED list of models to attempt within a tier BEFORE escalating to the next tier.
 * Exhaust the cheap options first: every model in the tier's roster is tried in order, and
 * only when all fail does the cascade pay for a higher tier.
 *
 * Ordering embodies "use the cheapest model that can do the job":
 *   - COST ASCENDING is the primary key — the cheapest model is attempted first (e.g.
 *     deepseek-v4-flash / mimo-v2.5 before the pro pair), so the verification ladder gets a
 *     chance to pass on the cheapest option before any pricier one runs.
 *   - REASONING-QUALITY DESC (Luak) breaks ties among EQUAL-priced models — e.g. mimo-v2.5-pro
 *     ahead of deepseek-v4-pro (both $0.435/$0.87, Luak ranks Mimo higher).
 *   - ROSTER ORDER is the final tie-break, and the SOLE ordering when no price signal exists —
 *     so an operator's explicit IKBI_ESCALATION_*_MODELS order is honored verbatim and never
 *     silently re-sorted by quality alone.
 */
export function rankModelsInTier(
  roster: readonly RosterModel[],
  leaderboard: readonly LuakLeaderboardEntry[]
): RankCandidate[] {
  const scored = rankCandidates(roster, leaderboard);
  const scoreById = new Map(scored.map((c) => [c.id, c.score]));
  const anyCost = roster.some((m) => m.costPerMTok !== undefined);

  return roster
    .map((m, index) => ({
      candidate: {
        id: m.id,
        ...(m.role !== undefined ? { role: m.role } : {}),
        ...(scoreById.get(m.id) !== undefined ? { score: scoreById.get(m.id) } : {}),
        ...(m.costPerMTok !== undefined ? { costPerMTok: m.costPerMTok } : {})
      } as RankCandidate,
      index,
      cost: m.costPerMTok,
      score: scoreById.get(m.id)
    }))
    .sort((a, b) => {
      if (anyCost) {
        const ca = a.cost ?? Infinity;
        const cb = b.cost ?? Infinity;
        if (ca !== cb) return ca - cb; // cheapest first
        const sa = a.score ?? -Infinity;
        const sb = b.score ?? -Infinity;
        if (sb !== sa) return sb - sa; // quality breaks a price tie
      }
      return a.index - b.index; // roster order: final tie-break, or sole order when no price signal
    })
    .map((entry) => entry.candidate);
}

/** Tiers within [floor, ceiling], starting at `start` and walking DOWN toward the floor. */
function inBoundsTiersDownFrom(start: ModelTier, bounds: TierBounds): ModelTier[] {
  const tiers: ModelTier[] = [];
  for (let rank = tierRank(start); rank >= tierRank(bounds.floor); rank -= 1) {
    tiers.push(TIER_ORDER[rank]!);
  }
  return tiers;
}

/**
 * Resolve one concrete model id for (role, requestedTier): clamp the tier into the role's
 * bounds, then pick the cheapest sufficient model within it. If the resolved tier's roster
 * is empty, fall DOWN to the nearest non-empty in-bounds tier (never up past the request).
 */
export function resolveModel(input: ResolveModelInput): ResolveModelResult {
  const bounds = tierBounds(input.role);
  const clampedTier = clampTier(input.requestedTier, bounds);
  const minScore = input.minScore ?? ROLE_MIN_SCORE[input.role];
  const leaderboard = input.leaderboard ?? [];

  for (const tier of inBoundsTiersDownFrom(clampedTier, bounds)) {
    const selection = selectModelInTier(input.tierRosters[tier], leaderboard, minScore);
    if (selection !== undefined) {
      const clampedFrom = clampedTier === input.requestedTier ? undefined : input.requestedTier;
      const rosterFallbackFrom = tier === clampedTier ? undefined : clampedTier;
      const reasonParts = [`role=${input.role}`, `tier=${tier}`, `via=${selection.via}`];
      if (clampedFrom !== undefined) reasonParts.push(`clamped<-${clampedFrom}`);
      if (rosterFallbackFrom !== undefined) reasonParts.push(`emptyRoster<-${rosterFallbackFrom}`);
      if (selection.score !== undefined) reasonParts.push(`score=${selection.score}`);
      return {
        role: input.role,
        tier,
        ...(clampedFrom !== undefined ? { clampedFrom } : {}),
        ...(rosterFallbackFrom !== undefined ? { rosterFallbackFrom } : {}),
        modelId: selection.modelId,
        via: selection.via,
        ...(selection.score !== undefined ? { score: selection.score } : {}),
        reason: reasonParts.join(" ")
      };
    }
  }

  throw new ModelRouterError(
    `no non-empty roster for role=${input.role} within bounds [${bounds.floor}, ${bounds.ceiling}] (requested ${input.requestedTier})`
  );
}

/** Convenience: the frontier model that a consult should use. */
export function consultModel(
  tierRosters: ResolveModelInput["tierRosters"],
  leaderboard?: readonly LuakLeaderboardEntry[]
): ResolveModelResult {
  return resolveModel({
    role: "consultant",
    requestedTier: "frontier",
    tierRosters,
    ...(leaderboard !== undefined ? { leaderboard } : {})
  });
}

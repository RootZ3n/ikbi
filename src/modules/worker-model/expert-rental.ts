/**
 * ikbi worker-model — EXPERT RENTAL (the cheap-tier coordinator's "rent per sub-task" gate).
 *
 * The cheap tier is not a lone builder with an escalation ladder, and not a tournament that races
 * candidates and discards losers. It is a MIXTURE OF EXPERTS: a pool of cheap models (two vendors ×
 * two tiers) treated as ONE virtual builder. For each sub-task the coordinator RENTS the cheapest
 * expert that can plausibly do THAT task — mechanical work goes to the worker roster (flash /
 * mimo-v2.5); work that needs real reasoning is rented up to the mid roster (mimo-v2.5-pro /
 * deepseek-v4-pro) FROM THE START, not after a failure. There is no "escalation event" — the right
 * expert is picked up front by difficulty.
 *
 * This module is the routing decision only: given a sub-task's goal + the pool's tier rosters, it
 * asks model-router's `resolveModel` (the cheapest-sufficient gate) for the builder expert. The
 * difficulty estimate here is a zero-cost heuristic; the cognition-layer can supersede it later as
 * the coordinator's deliberation without changing this seam.
 */

import { resolveModel, rosterFromIds, type ModelTier } from "../model-router/index.js";

/** Regexes that mark a sub-task as needing a stronger (mid-roster) expert from the start. */
const HARDER_SIGNALS: readonly RegExp[] = Object.freeze([
  /\balgorithm/i,
  /\bconcurren/i,
  /\brace condition/i,
  /\bdeadlock/i,
  /\brefactor/i,
  /\boptimi[sz]e/i,
  /\bdebug\b/i,
  /\bfix\b[^.]*\b(bug|failure|error|regression|crash)/i,
  /\bprotocol\b/i,
  /\bstate machine\b/i,
  /\bparser?\b/i,
  /\bmigrat/i,
  /\bsecurity\b/i,
  /\bperformance\b/i,
  /\bconcurrency\b/i,
  /\brecursi/i,
  // BEHAVIORAL difficulty cues only (verbs/techniques), never entity NAMES — a step that merely
  // name-drops a function like `subtreeBounds` is not itself hard. Semantic difficulty (which step
  // actually implements the tricky logic) is the cognition-layer coordinator's job, not regex.
  /\btravers(e|al|ing)\b/i,
  /\b(depth|breadth)-first\b/i,
]);

/**
 * The coordinator's per-sub-task difficulty → requested tier. Defaults to the cheapest tier
 * (`worker`); bumps to `mid` when the goal names work that a flash-class model reliably fumbles,
 * or when the caller already classified the goal as a large build. Deliberately conservative — the
 * rental only spends UP when there is a concrete reason to, so most steps stay on the cheap roster.
 */
export function estimateTaskTier(goal: string, complexity?: string): ModelTier {
  if (complexity === "large") return "mid";
  return HARDER_SIGNALS.some((r) => r.test(goal)) ? "mid" : "worker";
}

/** Inputs for a single builder-expert rental. */
export interface RentBuilderExpertInput {
  /** The sub-task goal being built (the coordinator's routing signal). */
  readonly goal: string;
  /** Optional pre-classified complexity (`--complexity large` forces the mid roster). */
  readonly complexity?: string;
  /** The pool's per-tier rosters (escalation config's tierModels). */
  readonly tierRosters: Readonly<Record<ModelTier, readonly string[]>>;
  /** Model to fall back to if the router has no usable roster (never throws to the caller). */
  readonly fallback: string;
  /** Optional explicit tier override (e.g. a future cognition decision), skipping the heuristic. */
  readonly tierOverride?: ModelTier;
  /**
   * Optional VENDOR LANE: restrict rentals to models whose id begins with this prefix (e.g.
   * "deepseek", "mimo"). Used by the duel-on-failure path to make the second attempt a genuine PEER
   * of the first — a different vendor's experts, not a stronger rung of the same ladder. A lane that
   * filters a tier down to nothing transparently falls back to that tier's full roster.
   */
  readonly vendorLane?: string;
}

/** Restrict a roster to one vendor lane; fall back to the full roster if the lane is empty. */
function laneRoster(ids: readonly string[], lane: string | undefined): readonly string[] {
  if (lane === undefined || lane === "") return ids;
  const filtered = ids.filter((id) => id.startsWith(lane));
  return filtered.length > 0 ? filtered : ids;
}

/** The rented expert for one sub-task. */
export interface RentedExpert {
  readonly modelId: string;
  readonly tier: ModelTier;
  readonly reason: string;
}

/**
 * Rent the cheapest-sufficient builder expert for one sub-task. Pure + total: on any router error
 * (e.g. an empty roster) it returns the caller's fallback rather than throwing, so a rental decision
 * can never break a build — the worst case is "use the tier's default builder".
 */
export function rentBuilderExpert(input: RentBuilderExpertInput): RentedExpert {
  const requestedTier = input.tierOverride ?? estimateTaskTier(input.goal, input.complexity);
  try {
    const res = resolveModel({
      role: "builder",
      requestedTier,
      tierRosters: {
        worker: rosterFromIds(laneRoster(input.tierRosters.worker, input.vendorLane)),
        mid: rosterFromIds(laneRoster(input.tierRosters.mid, input.vendorLane)),
        frontier: rosterFromIds(laneRoster(input.tierRosters.frontier, input.vendorLane)),
      },
    });
    return { modelId: res.modelId, tier: res.tier, reason: `rented ${res.modelId} (${res.reason})` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { modelId: input.fallback, tier: requestedTier, reason: `rental fell back to ${input.fallback} (${detail})` };
  }
}

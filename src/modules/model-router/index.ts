/**
 * ikbi model-router — module entrypoint (library-only).
 *
 * @status library-only (no CLI, no server route, no model calls).
 *
 * The cascade keystone: "use the cheapest model that can do THIS task." resolveModel()
 * clamps a requested tier into a role's [floor, ceiling] bounds and picks the cheapest
 * sufficient model within it (Luak cheapest-above-threshold, roster-first fallback). Both
 * the consult path (consultModel) and the coordinator cascade resolve every model through
 * this one pure function. Composes escalation's tier rosters with model-evaluation's Luak
 * ranking; changes neither.
 */

export {
  tierBounds,
  clampTier,
  rosterFromIds,
  selectModelInTier,
  rankModelsInTier,
  resolveModel,
  consultModel
} from "./router.js";
export {
  TIER_ORDER,
  ROLE_TIER_BOUNDS,
  ROLE_MIN_SCORE,
  ModelRouterError
} from "./contract.js";
export type {
  ModelTier,
  RouterRole,
  TierBounds,
  TierSelection,
  ModelSelectionVia,
  ResolveModelInput,
  ResolveModelResult,
  RosterModel,
  RankCandidate,
  LuakLeaderboardEntry
} from "./contract.js";

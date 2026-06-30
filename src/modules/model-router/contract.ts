/**
 * ikbi model-router — contract types for "cheapest model that can do the job".
 *
 * The router turns the cascade principle into a pure function. Given a role, a requested
 * tier, the per-tier rosters (from escalation config) and an optional Luak leaderboard, it
 * resolves ONE concrete model id by:
 *   1. clamping the requested tier into the role's [floor, ceiling] bounds, then
 *   2. picking, within that tier's roster, the CHEAPEST model scoring >= the role's
 *      within-tier quality floor (Luak), falling back to the roster's first entry when
 *      there is no leaderboard match.
 *
 * Two bounds per role, not one:
 *   - ceiling — the HIGHEST tier a role may ever run at. "Don't scout with GPT-5.5" is a
 *     ceiling: scout is pinned to worker and never escalates.
 *   - floor   — the LOWEST tier a role may run at. The consultant is pinned to frontier.
 *
 * Quality comes from tier ESCALATION (the ladder bumps the tier on deterministic failure);
 * WITHIN a tier the router spends as little as possible. So the within-tier quality floor
 * (`minScore`) defaults to 0 — cheapest-in-tier — and is tightened per-role only when a
 * role needs a measurably stronger model even at its starting tier.
 *
 * @status library-only (no model calls; pure composition over escalation + model-evaluation).
 */

import type { ModelTier } from "../escalation/contract.js";
import type { LuakLeaderboardEntry, RosterModel } from "../model-evaluation/index.js";

export type { ModelTier } from "../escalation/contract.js";
export type { LuakLeaderboardEntry, RankCandidate, RosterModel } from "../model-evaluation/index.js";

/** Roles the router resolves a model for. Mirrors the worker-model roles + cascade additions. */
export type RouterRole =
  | "scout"
  | "builder"
  | "critic"
  | "refuter"
  | "integrator"
  | "classifier" // the coordinator's ambiguity-gate fallback (always cheap)
  | "consultant"; // the frontier expert summoned with a ConsultPacket

/** Tier order, cheapest → strongest. Index is the comparable rank. */
export const TIER_ORDER: readonly ModelTier[] = ["worker", "mid", "frontier"];

/** The lowest and highest tier a role may run at. */
export interface TierBounds {
  readonly floor: ModelTier;
  readonly ceiling: ModelTier;
}

/**
 * Per-role tier bounds. The cascade clamps every tier decision through these, so a role
 * can never be cheaper than it needs nor more expensive than it should be.
 *   - scout / classifier: pinned to worker — these run constantly and must stay free-ish.
 *   - builder / integrator / critic / refuter: worker→frontier, climb on deterministic failure.
 *   - consultant: pinned to frontier — it only exists as the expensive last resort.
 */
export const ROLE_TIER_BOUNDS: Readonly<Record<RouterRole, TierBounds>> = Object.freeze({
  scout: { floor: "worker", ceiling: "worker" },
  classifier: { floor: "worker", ceiling: "worker" },
  builder: { floor: "worker", ceiling: "frontier" },
  integrator: { floor: "worker", ceiling: "frontier" },
  critic: { floor: "worker", ceiling: "frontier" },
  refuter: { floor: "worker", ceiling: "frontier" },
  consultant: { floor: "frontier", ceiling: "frontier" },
});

/**
 * Per-role WITHIN-TIER quality floor (Luak score 0–100). Default 0 = cheapest-in-tier;
 * quality is bought by escalating the TIER, not by overspending within one. Tighten a
 * role here only when it needs a stronger model even at its starting tier.
 */
export const ROLE_MIN_SCORE: Readonly<Record<RouterRole, number>> = Object.freeze({
  scout: 0,
  classifier: 0,
  builder: 0,
  integrator: 0,
  critic: 0,
  refuter: 0,
  consultant: 0,
});

export type ModelSelectionVia = "luak-cheapest-above-threshold" | "roster-first-fallback";

export interface TierSelection {
  readonly modelId: string;
  readonly via: ModelSelectionVia;
  readonly score?: number;
}

export interface ResolveModelInput {
  readonly role: RouterRole;
  /** The tier the cascade wants (e.g. the tier after an escalation step). */
  readonly requestedTier: ModelTier;
  /** Per-tier rosters — typically escalation config's tierModels, lifted to RosterModel. */
  readonly tierRosters: Readonly<Record<ModelTier, readonly RosterModel[]>>;
  /** Optional measured leaderboard; absent → roster-first fallback. */
  readonly leaderboard?: readonly LuakLeaderboardEntry[];
  /** Override the role's within-tier quality floor. */
  readonly minScore?: number;
}

export interface ResolveModelResult {
  readonly role: RouterRole;
  /** The tier actually used (after clamping into the role's bounds). */
  readonly tier: ModelTier;
  /** Set when `requestedTier` was clamped into the role's bounds. */
  readonly clampedFrom?: ModelTier;
  /** Set when the resolved tier's roster was empty and a nearby in-bounds tier was used. */
  readonly rosterFallbackFrom?: ModelTier;
  readonly modelId: string;
  readonly via: ModelSelectionVia;
  readonly score?: number;
  /** Human-readable decision trail (one line). */
  readonly reason: string;
}

/** A typed router failure (e.g. no non-empty roster anywhere in the role's bounds). */
export class ModelRouterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelRouterError";
  }
}

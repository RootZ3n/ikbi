/**
 * ikbi recovery — contract types for the first-class, self-healing recovery loop.
 *
 * A failure is not an outcome — it is a transition into a recovery STATE that ikbi owns until
 * it is either resolved (a verified-green attempt) or genuinely exhausted. The loop drives a
 * POOL of models to exhaustion in a single invocation, so an external wrapper (Hermes) only
 * ever sees a terminal verdict — never a recoverable failure it must notice and re-invoke.
 *
 * THE POOL (operator-confirmed shape):
 *   - ikbi may call upon ANY model in the worker+mid pool, at any point, AS LONG AS IT GOES UP
 *     THE LADDER — recovery tracks a monotonic tier FLOOR (the highest tier used so far) and a
 *     model is eligible only if its tier is at-or-above the floor and it hasn't been tried yet.
 *     Once recovery has used a mid model it never drops back to a worker model.
 *   - The pool tops out at the AUTO CEILING = mid. The FRONTIER sits above the pool and is
 *     never entered silently — crossing it needs explicit AUTHORIZATION (a token budget or
 *     `--escalate`); unattended, recovery stops at the ceiling and reports needs-authorization
 *     rather than billing Opus.
 *   - The frontier step is a CONSULT, not a blind swap — the cheap pre-pass assembles a
 *     ConsultPacket and the frontier model returns a plan/patch (see the consult module).
 *
 * Selection within the eligible pool defaults to CHEAPEST-FIRST (model-router cost-ascending),
 * but a caller may request a specific model — honored as long as it is eligible (i.e. it does
 * not go down the ladder). Pure decision layer: no side effects, no model calls.
 */

import type { LuakLeaderboardEntry, ModelTier, RosterModel } from "../model-router/index.js";

export type { ModelTier } from "../model-router/index.js";

/** One attempt already made during this recovery, with its verified outcome. */
export interface RecoveryAttempt {
  readonly tier: ModelTier;
  readonly model: string;
  /** "green" = the verification ladder passed; "fail" = it did not. */
  readonly outcome: "green" | "fail";
}

/** A model the recovery loop may draw from the pool, tagged with its tier. */
export interface RecoveryCandidate {
  readonly tier: ModelTier;
  readonly model: string;
  readonly costPerMTok?: number;
  /** Luak reasoning score, when a leaderboard was supplied. */
  readonly score?: number;
}

/** Why recovery ended. */
export type RecoveryTerminal =
  | "recovered" // a verified-green attempt resolved the failure
  | "exhausted" // every reachable model was tried and none recovered it
  | "needs-authorization"; // the worker+mid pool is exhausted; only the gated frontier remains

export interface RecoveryInput {
  /** Attempt history in order (the original failed build is the first entry). */
  readonly attempts: readonly RecoveryAttempt[];
  /** Per-tier rosters (escalation config's tierModels, lifted to RosterModel). */
  readonly tierRosters: Readonly<Record<ModelTier, readonly RosterModel[]>>;
  /** Optional measured leaderboard for the cost-ascending tie-break. */
  readonly leaderboard?: readonly LuakLeaderboardEntry[];
  /** Highest tier in the auto pool (reachable WITHOUT authorization). Default "mid". */
  readonly autoCeiling?: ModelTier;
  /** True when a token budget / --escalate has authorized frontier (consult) spend. */
  readonly frontierAuthorized?: boolean;
  /** Where the cascade begins when there is no history yet. Default "worker". */
  readonly startTier?: ModelTier;
  /**
   * An explicit model the caller wants to call upon next. Honored only when it is eligible
   * (untried and at-or-above the floor); an ineligible request falls back to cheapest-first.
   */
  readonly requestedModel?: string;
}

export type RecoveryAction =
  /** Run the builder again on this (tier, model). `requested` flags a caller-chosen pick. */
  | { readonly kind: "attempt"; readonly tier: ModelTier; readonly model: string; readonly requested: boolean; readonly reason: string }
  /** Summon the frontier via a ConsultPacket (only ever returned when authorized). */
  | { readonly kind: "consult"; readonly tier: "frontier"; readonly reason: string }
  /** Stop — recovery reached a terminal state. `terminal` distinguishes the three exits. */
  | { readonly kind: "terminate"; readonly terminal: RecoveryTerminal; readonly reason: string };

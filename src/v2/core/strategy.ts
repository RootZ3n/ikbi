/**
 * ikbi v2 — THE CANDIDATE STRATEGY POLICY + THE ONE WINNER SELECTOR (V2-017).
 *
 * A candidate strategy decides HOW MANY candidates an attempt generates and, deterministically,
 * WHICH completed candidate is chosen for promotion. It is ORCHESTRATION, NOT GOVERNANCE:
 *
 *   - it does NOT verify, adjudicate, promote, retry, or select a model;
 *   - every candidate it produces is judged by the SAME canonical verification / critic /
 *     disposition authorities (the lifecycle in run.ts calls them, never this module);
 *   - it never touches a workspace, a transport, git, or a filesystem — this file is PURE.
 *
 * TWO THINGS LIVE HERE, and only these:
 *   1. StrategyPolicy — the frozen, content-addressed description of the strategy (kind, candidate
 *      count, selection rule, partial-completion policy). Frozen per attempt.
 *   2. selectCandidate — THE ONE winner selector. Given the immutable per-candidate EVALUATIONS
 *      (each already carrying a canonical disposition), it deterministically picks at most one
 *      promotion-ELIGIBLE candidate. No I/O, no model, no mutation, no promotion.
 *
 * single, shadow and tournament differ ONLY in this policy (count) — they share the one selector.
 */

import { contentDigest, type V2CandidateId, type V2Digest, type V2RunId } from "./identity.js";
import type { CandidateStrategyKind } from "./contract.js";
import type { DispositionDecision } from "./disposition.js";

// ---------------------------------------------------------------------------
// Strategy policy
// ---------------------------------------------------------------------------

export type V2StrategyPolicyId = V2Digest<"strategy_policy">;

/**
 * The deterministic selection rule version. Bumped only when the ranking below changes, so a
 * SelectionRecord proves exactly which rule produced it.
 */
export const SELECTION_RULE_VERSION = "v2-017-deterministic-1";

/**
 * How a strategy behaves when not every candidate completes canonical evaluation (a build/critic
 * engine failure, or a mid-attempt budget denial).
 *
 *   require_all  the DEFAULT and conservative posture: selection proceeds only when EVERY planned
 *                candidate completed evaluation. Strategy semantics never silently change because a
 *                candidate failed or the budget ran out.
 *   allow_partial  selection may proceed over the candidates that DID complete. Opt-in only.
 */
export type PartialCompletionPolicy = "require_all" | "allow_partial";

/** The immutable, content-addressed description of a candidate strategy, frozen per attempt. */
export interface StrategyPolicy {
  readonly policyId: V2StrategyPolicyId;
  readonly kind: CandidateStrategyKind;
  /** How many independent candidates this attempt generates. single=1; shadow=2; tournament=N. */
  readonly candidateCount: number;
  /** A hard ceiling, independent of `candidateCount`, so a bug cannot fan out unboundedly. */
  readonly maxCandidates: number;
  readonly partialCompletion: PartialCompletionPolicy;
  readonly selectionRule: string;
}

/** The independent hard ceiling on candidates per attempt — bounds tournament fanout. */
export const STRATEGY_CANDIDATE_HARD_CAP = 4;

/** Build a strategy policy, computing its content id. `candidateCount` is clamped to the hard cap. */
export function buildStrategyPolicy(input: {
  readonly kind: CandidateStrategyKind;
  readonly candidateCount?: number;
  readonly partialCompletion?: PartialCompletionPolicy;
}): StrategyPolicy {
  const requested = input.candidateCount ?? defaultCandidateCount(input.kind);
  const candidateCount = Math.max(1, Math.min(requested, STRATEGY_CANDIDATE_HARD_CAP));
  const semantic = {
    kind: input.kind,
    candidateCount,
    maxCandidates: STRATEGY_CANDIDATE_HARD_CAP,
    partialCompletion: input.partialCompletion ?? "require_all",
    selectionRule: SELECTION_RULE_VERSION,
  };
  return Object.freeze({ policyId: contentDigest("strategy_policy", semantic), ...semantic });
}

/** The default candidate count per kind. shadow is 2; tournament is 3; single is 1. */
export function defaultCandidateCount(kind: CandidateStrategyKind): number {
  switch (kind) {
    case "single":
      return 1;
    case "shadow":
      return 2;
    case "tournament":
      return 3;
  }
}

/** The frozen default policy for a strategy kind. */
export function defaultStrategyPolicy(kind: CandidateStrategyKind): StrategyPolicy {
  return buildStrategyPolicy({ kind });
}

// ---------------------------------------------------------------------------
// Candidate evaluation — the immutable per-candidate input the selector reads
// ---------------------------------------------------------------------------

/**
 * How far a candidate got through canonical evaluation.
 *
 *   evaluated   reached the disposition authority — it carries a lawful disposition.
 *   incomplete  a build/critic/engine failure (or a budget denial) stopped it BEFORE disposition;
 *               it can never be selected, and under `require_all` it blocks selection entirely.
 */
export type CandidateEvaluationStatus = "evaluated" | "incomplete";

/**
 * The immutable evaluation of ONE candidate, as the selector sees it. Every field is derived from
 * the canonical authorities (verification, critic, disposition) or the cost ledger — the selector
 * invents nothing and re-judges nothing.
 */
export interface CandidateEvaluation {
  readonly candidateId: V2CandidateId;
  readonly workspaceId: string;
  /** 0-based generation slot, for provenance/ordering. */
  readonly slot: number;
  readonly status: CandidateEvaluationStatus;
  /** Present iff `status === "evaluated"`. */
  readonly decision?: DispositionDecision;
  readonly promotionEligible: boolean;
  readonly verificationVerdict?: string;
  readonly criticVerdict?: string;
  /** This candidate's OWN known cost (its builder + critic invocations). A floor when unknown. */
  readonly knownCostMicroUsd: number;
  readonly hasUnknownCost: boolean;
  readonly mutationCount: number;
  readonly changedPathCount: number;
  /** Present when the candidate failed before disposition — the structured reason, for the receipt. */
  readonly failureCode?: string;
}

// ---------------------------------------------------------------------------
// Selection record + the ONE selector
// ---------------------------------------------------------------------------

export type V2SelectionId = V2Digest<"selection">;

/** Why the selector chose (or did not choose) a candidate. Closed, machine-readable set. */
export type SelectionReason =
  | "single_eligible" //          exactly one promotion-eligible candidate
  | "cost_tiebreak" //            >1 eligible; chosen by lower known cost
  | "mutation_tiebreak" //        >1 eligible, equal known cost; fewer mutations/changed paths
  | "identity_tiebreak" //        >1 eligible, otherwise equal; stable CandidateId lexical order
  | "no_eligible_candidate" //    zero promotion-eligible candidates
  | "require_all_candidates_incomplete"; // require_all policy + a candidate did not complete

/** The immutable, content-addressed record of ONE winner selection. */
export interface SelectionRecord {
  readonly selectionId: V2SelectionId;
  readonly runId: string;
  readonly strategyPolicyId: V2StrategyPolicyId;
  readonly selectionRule: string;
  /** Every candidate evaluated, in a STABLE order (by candidateId), for provenance. */
  readonly candidateEvaluationIds: readonly string[];
  /** The chosen candidate, when one is promotion-eligible AND selection was allowed. */
  readonly selectedCandidateId?: string;
  readonly reason: SelectionReason;
  /** The eligible pool the selector ranked over, in stable order — the tie-break audit trail. */
  readonly eligiblePool: readonly string[];
}

/**
 * THE ONE WINNER SELECTOR — pure, deterministic, total.
 *
 * It NEVER re-judges a candidate. It ranks the EXISTING canonical evaluations:
 *
 *   1. only `evaluated` candidates whose disposition is `acceptable_for_promotion` enter the pool
 *      (a weaker disposition is NEVER ranked above a stronger one — correctness before cost);
 *   2. `require_all` + any incomplete candidate ⇒ no selection (strategy semantics do not silently
 *      change because a candidate failed or the budget ran out);
 *   3. among the eligible pool: lower KNOWN cost (a fully-known cost is preferred over an unknown
 *      one, correctness being equal), then fewer mutations, then fewer changed paths, then the
 *      stable lexical CandidateId — so the result is reproducible from the evidence alone.
 */
export function selectCandidate(input: {
  readonly runId: V2RunId;
  readonly policy: StrategyPolicy;
  readonly evaluations: readonly CandidateEvaluation[];
  /**
   * How many candidates the strategy LAUNCHED. A candidate that failed generation never produced a
   * tree, so it has no CandidateId and cannot appear as an evaluation — but under `require_all` its
   * absence is exactly the incompleteness the policy exists to catch. Defaults to `evaluations.length`
   * (so callers that reason purely over a hand-built evaluation set are unaffected).
   */
  readonly launchedCount?: number;
}): SelectionRecord {
  const { runId, policy } = input;
  // Stable provenance ordering by candidate id.
  const evaluations = [...input.evaluations].sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  const candidateEvaluationIds = evaluations.map((e) => e.candidateId);
  const launchedCount = input.launchedCount ?? evaluations.length;
  const missingCandidates = Math.max(0, launchedCount - evaluations.length);

  const record = (selectedCandidateId: string | undefined, reason: SelectionReason, eligiblePool: readonly string[]): SelectionRecord => {
    const semantic = {
      runId,
      strategyPolicyId: policy.policyId,
      selectionRule: policy.selectionRule,
      candidateEvaluationIds,
      reason,
      ...(selectedCandidateId !== undefined ? { selectedCandidateId } : {}),
      eligiblePool: [...eligiblePool],
    };
    return Object.freeze({ selectionId: contentDigest("selection", semantic), ...semantic });
  };

  // 2. require_all: an incomplete candidate — OR a candidate that never produced an evaluation at all
  // (generation failed) — blocks selection outright. The strategy's semantics do not silently change
  // because a candidate failed or the budget ran out.
  if (policy.partialCompletion === "require_all" && (missingCandidates > 0 || evaluations.some((e) => e.status === "incomplete"))) {
    return record(undefined, "require_all_candidates_incomplete", []);
  }

  // 1. The eligible pool: completed AND canonically acceptable_for_promotion.
  const pool = evaluations.filter((e) => e.status === "evaluated" && e.promotionEligible && e.decision === "acceptable_for_promotion");
  if (pool.length === 0) return record(undefined, "no_eligible_candidate", []);

  const poolIds = pool.map((e) => e.candidateId);
  if (pool.length === 1) return record(pool[0]!.candidateId, "single_eligible", poolIds);

  // 3. Deterministic tie-break among eligible candidates (correctness is already equal).
  let reason: SelectionReason = "identity_tiebreak";
  const ranked = [...pool].sort((a, b) => {
    // A fully-KNOWN cost outranks an unknown one; then lower known cost.
    if (a.hasUnknownCost !== b.hasUnknownCost) { reason = "cost_tiebreak"; return a.hasUnknownCost ? 1 : -1; }
    if (a.knownCostMicroUsd !== b.knownCostMicroUsd) { reason = "cost_tiebreak"; return a.knownCostMicroUsd - b.knownCostMicroUsd; }
    if (a.mutationCount !== b.mutationCount) { reason = "mutation_tiebreak"; return a.mutationCount - b.mutationCount; }
    if (a.changedPathCount !== b.changedPathCount) { reason = "mutation_tiebreak"; return a.changedPathCount - b.changedPathCount; }
    return a.candidateId.localeCompare(b.candidateId); // stable final tie-break
  });
  return record(ranked[0]!.candidateId, reason, poolIds);
}

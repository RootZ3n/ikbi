/**
 * V2-017 — THE CANDIDATE STRATEGY POLICY + THE ONE PURE WINNER SELECTOR.
 *
 * The selector NEVER re-judges: it ranks the immutable canonical evaluations. These suites pin the
 * deterministic ranking (correctness before cost), the require-all/allow-partial semantics, and the
 * content-addressed identity of the policy + selection.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildStrategyPolicy,
  defaultStrategyPolicy,
  defaultCandidateCount,
  selectCandidate,
  STRATEGY_CANDIDATE_HARD_CAP,
  type CandidateEvaluation,
  type StrategyPolicy,
} from "./strategy.js";
import type { V2CandidateId, V2RunId } from "./identity.js";

const RUN = "run_seed-00000001" as V2RunId;

function evaluated(over: Omit<Partial<CandidateEvaluation>, "candidateId"> & { candidateId: string; slot: number }): CandidateEvaluation {
  const { candidateId, slot, ...rest } = over;
  return {
    candidateId: candidateId as V2CandidateId,
    workspaceId: `ws-${slot}`,
    slot,
    status: "evaluated",
    decision: "acceptable_for_promotion",
    promotionEligible: true,
    verificationVerdict: "pass",
    criticVerdict: "satisfied",
    knownCostMicroUsd: 0,
    hasUnknownCost: false,
    mutationCount: 1,
    changedPathCount: 1,
    ...rest,
  };
}

function incomplete(candidateId: string, slot: number, failureCode: string): CandidateEvaluation {
  const { decision: _drop, ...base } = evaluated({ candidateId, slot });
  void _drop;
  return { ...base, status: "incomplete", promotionEligible: false, failureCode };
}

// ---------------------------------------------------------------------------
// Strategy policy identity
// ---------------------------------------------------------------------------

test("policy: single=1, shadow=2, tournament=3; default partial policy is require_all", () => {
  assert.equal(defaultCandidateCount("single"), 1);
  assert.equal(defaultCandidateCount("shadow"), 2);
  assert.equal(defaultCandidateCount("tournament"), 3);
  assert.equal(defaultStrategyPolicy("tournament").partialCompletion, "require_all");
});

test("policy: content-addressed id is stable and moves with a changed field", () => {
  const a = buildStrategyPolicy({ kind: "tournament" });
  const b = buildStrategyPolicy({ kind: "tournament" });
  assert.equal(a.policyId, b.policyId);
  assert.notEqual(a.policyId, buildStrategyPolicy({ kind: "shadow" }).policyId);
  assert.notEqual(a.policyId, buildStrategyPolicy({ kind: "tournament", partialCompletion: "allow_partial" }).policyId);
});

test("policy: candidate count is clamped to the hard cap (bounded fanout)", () => {
  const p = buildStrategyPolicy({ kind: "tournament", candidateCount: 99 });
  assert.equal(p.candidateCount, STRATEGY_CANDIDATE_HARD_CAP);
  assert.equal(buildStrategyPolicy({ kind: "single", candidateCount: 0 }).candidateCount, 1);
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

const TOUR: StrategyPolicy = buildStrategyPolicy({ kind: "tournament" });

test("select: exactly one eligible candidate is chosen", () => {
  const r = selectCandidate({ runId: RUN, policy: TOUR, evaluations: [
    evaluated({ candidateId: "cand_a", slot: 0 }),
    evaluated({ candidateId: "cand_b", slot: 1, promotionEligible: false, decision: "withhold" }),
    { ...evaluated({ candidateId: "cand_c", slot: 2 }), status: "evaluated", promotionEligible: false, decision: "reject" },
  ] });
  assert.equal(r.selectedCandidateId, "cand_a");
  assert.equal(r.reason, "single_eligible");
  assert.deepEqual([...r.eligiblePool], ["cand_a"]);
});

test("select: >1 eligible ⇒ LOWER known cost wins (correctness already equal)", () => {
  const r = selectCandidate({ runId: RUN, policy: TOUR, evaluations: [
    evaluated({ candidateId: "cand_expensive", slot: 0, knownCostMicroUsd: 5000 }),
    evaluated({ candidateId: "cand_cheap", slot: 1, knownCostMicroUsd: 1000 }),
  ] });
  assert.equal(r.selectedCandidateId, "cand_cheap");
  assert.equal(r.reason, "cost_tiebreak");
});

test("select: a fully-KNOWN cost outranks an unknown cost", () => {
  const r = selectCandidate({ runId: RUN, policy: TOUR, evaluations: [
    evaluated({ candidateId: "cand_unknown", slot: 0, knownCostMicroUsd: 10, hasUnknownCost: true }),
    evaluated({ candidateId: "cand_known", slot: 1, knownCostMicroUsd: 9999, hasUnknownCost: false }),
  ] });
  assert.equal(r.selectedCandidateId, "cand_known", "a known (even if larger) cost is preferred over an unbounded unknown");
});

test("select: equal cost ⇒ fewer mutations; then stable CandidateId", () => {
  const byMutations = selectCandidate({ runId: RUN, policy: TOUR, evaluations: [
    evaluated({ candidateId: "cand_b", slot: 0, mutationCount: 3 }),
    evaluated({ candidateId: "cand_a", slot: 1, mutationCount: 1 }),
  ] });
  assert.equal(byMutations.selectedCandidateId, "cand_a");
  assert.equal(byMutations.reason, "mutation_tiebreak");

  const byId = selectCandidate({ runId: RUN, policy: TOUR, evaluations: [
    evaluated({ candidateId: "cand_z", slot: 0 }),
    evaluated({ candidateId: "cand_a", slot: 1 }),
  ] });
  assert.equal(byId.selectedCandidateId, "cand_a", "stable lexical CandidateId is the final tie-break");
  assert.equal(byId.reason, "identity_tiebreak");
});

test("select: a weaker disposition is NEVER ranked above a stronger one (only acceptable enters the pool)", () => {
  const r = selectCandidate({ runId: RUN, policy: TOUR, evaluations: [
    { ...evaluated({ candidateId: "cand_cheap_but_withheld", slot: 0, knownCostMicroUsd: 1 }), promotionEligible: false, decision: "withhold" },
    evaluated({ candidateId: "cand_eligible", slot: 1, knownCostMicroUsd: 9999 }),
  ] });
  assert.equal(r.selectedCandidateId, "cand_eligible", "cost never trumps correctness — a withheld candidate cannot win");
});

test("select: NO eligible candidate ⇒ no selection, reason recorded", () => {
  const r = selectCandidate({ runId: RUN, policy: TOUR, evaluations: [
    { ...evaluated({ candidateId: "cand_a", slot: 0 }), promotionEligible: false, decision: "reject" },
    { ...evaluated({ candidateId: "cand_b", slot: 1 }), promotionEligible: false, decision: "withhold" },
  ] });
  assert.equal(r.selectedCandidateId, undefined);
  assert.equal(r.reason, "no_eligible_candidate");
});

test("select: require_all + an INCOMPLETE candidate ⇒ NO selection (semantics do not silently change)", () => {
  const r = selectCandidate({ runId: RUN, policy: TOUR, evaluations: [
    evaluated({ candidateId: "cand_a", slot: 0 }),
    incomplete("cand_b", 1, "build.turn_limit"),
  ] });
  assert.equal(r.selectedCandidateId, undefined);
  assert.equal(r.reason, "require_all_candidates_incomplete");
});

test("select: require_all + a MISSING candidate (generation failed, no evaluation) ⇒ NO selection", () => {
  // A candidate that failed generation produced no tree, so it never becomes an evaluation. Under
  // require_all its absence still blocks: the selector is told how many were launched.
  const r = selectCandidate({ runId: RUN, policy: TOUR, launchedCount: 3, evaluations: [
    evaluated({ candidateId: "cand_a", slot: 1 }),
    evaluated({ candidateId: "cand_b", slot: 2 }),
  ] });
  assert.equal(r.selectedCandidateId, undefined);
  assert.equal(r.reason, "require_all_candidates_incomplete");
});

test("select: allow_partial + a MISSING candidate ⇒ selection proceeds over the survivors", () => {
  const partial = buildStrategyPolicy({ kind: "tournament", partialCompletion: "allow_partial" });
  const r = selectCandidate({ runId: RUN, policy: partial, launchedCount: 3, evaluations: [
    evaluated({ candidateId: "cand_a", slot: 1 }),
    evaluated({ candidateId: "cand_b", slot: 2, knownCostMicroUsd: 5 }),
  ] });
  assert.equal(r.selectedCandidateId, "cand_a", "allow_partial promotes the cheaper survivor even with a missing sibling");
});

test("select: allow_partial + an incomplete candidate ⇒ selection proceeds over the completed pool", () => {
  const partial = buildStrategyPolicy({ kind: "tournament", partialCompletion: "allow_partial" });
  const r = selectCandidate({ runId: RUN, policy: partial, evaluations: [
    evaluated({ candidateId: "cand_a", slot: 0 }),
    incomplete("cand_b", 1, "x"),
  ] });
  assert.equal(r.selectedCandidateId, "cand_a", "opt-in partial completion selects from what completed");
});

test("select: is DETERMINISTIC — same evaluations ⇒ same selectionId", () => {
  const evals = [evaluated({ candidateId: "cand_b", slot: 0, knownCostMicroUsd: 2 }), evaluated({ candidateId: "cand_a", slot: 1, knownCostMicroUsd: 1 })];
  const a = selectCandidate({ runId: RUN, policy: TOUR, evaluations: evals });
  const b = selectCandidate({ runId: RUN, policy: TOUR, evaluations: [...evals].reverse() });
  assert.equal(a.selectionId, b.selectionId, "selection identity is order-independent + content-addressed");
  assert.equal(a.selectedCandidateId, b.selectedCandidateId);
});

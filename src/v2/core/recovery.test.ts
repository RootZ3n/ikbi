/**
 * THE RECOVERY CONTROLLER — the pure decision, in isolation.
 *
 * The load-bearing properties: an ENVIRONMENTAL condition (moved target, drift, timeout, infra,
 * transient provider) may be auto-retried with a fresh attempt while budget remains; an ADVERSE
 * JUDGMENT (verification fail, critic defects) is NEVER a retry (no semantic repair here); a
 * dirty source/target requires an operator (a fresh attempt over the same dirt changes nothing);
 * and a degraded landing is reconciliation, never a re-publish.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyAttempt,
  classifyPublicationLanding,
  decideRecovery,
  buildRecoveryPolicy,
  recoveryPolicyDigest,
  recoveryDecisionDigest,
  DEFAULT_RECOVERY_POLICY,
  type RecoveryPolicy,
  type RecoveryTrigger,
} from "./recovery.js";
import type { V2RunResult } from "./result.js";
import type { RunFailure, RunFailureCategory } from "./failure.js";

// ── minimal attempt-result stubs (only the fields the classifier reads) ───────

function result(over: {
  outcome: V2RunResult["outcome"];
  promotionDegraded?: boolean;
  dispositionPrimaryReason?: string;
}): V2RunResult {
  return {
    runId: "run_x" as never,
    outcome: over.outcome,
    receipt: {
      startedAt: 1,
      endedAt: 2,
      evidence: { invocations: 2 },
      ...(over.promotionDegraded !== undefined ? { promotion: { degraded: over.promotionDegraded } } : {}),
      ...(over.dispositionPrimaryReason !== undefined ? { disposition: { primaryReason: over.dispositionPrimaryReason } } : {}),
    },
  } as unknown as V2RunResult;
}

const failure = (category: RunFailureCategory, code: string, retryable = false): RunFailure =>
  ({ category, code, message: "x", retryable } as RunFailure);

// ── policy identity ───────────────────────────────────────────────────────────

test("policy: the default is conservative — 2 attempts, environmental retries on", () => {
  assert.equal(DEFAULT_RECOVERY_POLICY.maxAttempts, 2);
  assert.equal(DEFAULT_RECOVERY_POLICY.retryOnTargetMoved, true);
});

test("policy: identity is content-addressed and changes with a knob", () => {
  const a = buildRecoveryPolicy();
  const b = buildRecoveryPolicy({ maxAttempts: 3 });
  assert.match(a.policyId, /^[0-9a-f]{64}$/);
  assert.notEqual(a.policyId, b.policyId);
  assert.equal(recoveryPolicyDigest({ ...DEFAULT_RECOVERY_POLICY }), a.policyId);
});

// ── classification ────────────────────────────────────────────────────────────

const CLASSIFY: readonly [string, V2RunResult, RecoveryTrigger][] = [
  ["accepted", result({ outcome: { kind: "accepted", candidateId: "c" as never, verificationId: "v" as never, promotionId: "p" as never } }), "accepted"],
  ["accepted degraded", result({ outcome: { kind: "accepted", candidateId: "c" as never, verificationId: "v" as never, promotionId: "p" as never }, promotionDegraded: true }), "accepted_degraded"],
  ["withheld target_moved", result({ outcome: { kind: "withheld", candidateId: "c" as never, verificationId: "v" as never, reason: "target_moved" } }), "target_moved"],
  ["withheld dirty", result({ outcome: { kind: "withheld", candidateId: "c" as never, verificationId: "v" as never, reason: "unsupported_publication" } }), "dirty_source"],
  ["withheld operator", result({ outcome: { kind: "withheld", candidateId: "c" as never, verificationId: "v" as never, reason: "operator" } }), "operator_required"],
  ["withheld critic_defects", result({ outcome: { kind: "withheld", candidateId: "c" as never, verificationId: "v" as never, reason: "policy" }, dispositionPrimaryReason: "critic_defects" }), "critic_defects"],
  ["withheld indeterminate", result({ outcome: { kind: "withheld", candidateId: "c" as never, verificationId: "v" as never, reason: "policy" }, dispositionPrimaryReason: "critic_indeterminate" }), "critic_indeterminate"],
  ["withheld no_checks", result({ outcome: { kind: "withheld", candidateId: "c" as never, verificationId: "v" as never, reason: "policy" }, dispositionPrimaryReason: "no_checks" }), "no_checks"],
  ["withheld governance", result({ outcome: { kind: "withheld", candidateId: "c" as never, verificationId: "v" as never, reason: "governance" } }), "governance_withheld"],
  ["rejected", result({ outcome: { kind: "rejected", reason: "verification_red" } }), "verification_failed"],
  ["quarantined timeout", result({ outcome: { kind: "quarantined", reason: "adjudication_incomplete", detail: "verification_timeout" }, dispositionPrimaryReason: "verification_timeout" }), "verification_timeout"],
  ["quarantined infra", result({ outcome: { kind: "quarantined", reason: "adjudication_incomplete", detail: "x" }, dispositionPrimaryReason: "verification_infrastructure_failure" }), "verification_infrastructure_failure"],
  ["quarantined drift (no disposition)", result({ outcome: { kind: "quarantined", reason: "safety_forensics", detail: "drift" } }), "candidate_drift"],
  ["failed provider transient", result({ outcome: { kind: "failed", failure: failure("provider", "invocation.transport_failure") } }), "provider_transient"],
  ["failed provider permanent", result({ outcome: { kind: "failed", failure: failure("provider", "invocation.credential_missing") } }), "provider_permanent"],
  ["failed build", result({ outcome: { kind: "failed", failure: failure("build", "build.turn_limit_exceeded") } }), "build_failed"],
  ["failed wiring", result({ outcome: { kind: "failed", failure: failure("internal", "x") } }), "wiring_defect"],
];

for (const [name, r, expected] of CLASSIFY) {
  test(`classify: ${name} ⇒ ${expected}`, () => {
    assert.equal(classifyAttempt(r), expected);
  });
}

// ── the decision matrix ───────────────────────────────────────────────────────

const P = DEFAULT_RECOVERY_POLICY;
const decide = (r: V2RunResult, attemptNumber = 1, policy: RecoveryPolicy = P) => decideRecovery({ attemptNumber, result: r, policy });
const stub = (name: string) => CLASSIFY.find(([n]) => n === name)![1];

test("decide: accepted ⇒ stop_accepted, no new attempt", () => {
  const d = decide(stub("accepted"));
  assert.equal(d.kind, "stop_accepted");
  assert.equal(d.authorizesNewAttempt, false);
});

test("decide: accepted degraded ⇒ reconciliation_required, NEVER a new attempt", () => {
  const d = decide(stub("accepted degraded"));
  assert.equal(d.kind, "reconciliation_required");
  assert.equal(d.authorizesNewAttempt, false, "the ref already moved — never re-publish");
});

test("decide: verification FAIL ⇒ ONE semantic-repair attempt under the default policy", () => {
  const d = decide(stub("rejected"));
  assert.equal(d.kind, "retry_fresh_attempt");
  assert.equal(d.mode, "semantic_repair");
  assert.equal(d.repairTrigger, "verification_failure");
  assert.equal(d.authorizesNewAttempt, true);
});

test("decide: verification FAIL with repair DISABLED ⇒ stop_rejected", () => {
  const noRepair = buildRecoveryPolicy({ retryOnVerificationFailureForRepair: false });
  const d = decide(stub("rejected"), 1, noRepair);
  assert.equal(d.kind, "stop_rejected");
  assert.equal(d.reason, "repair_disabled_by_policy");
  assert.equal(d.authorizesNewAttempt, false);
});

test("decide: critic defects ⇒ ONE semantic-repair attempt under the default policy", () => {
  const d = decide(stub("withheld critic_defects"));
  assert.equal(d.kind, "retry_fresh_attempt");
  assert.equal(d.mode, "semantic_repair");
  assert.equal(d.repairTrigger, "critic_defects");
});

test("decide: critic defects with repair DISABLED ⇒ stop_withheld (no critic-fix loop)", () => {
  const noRepair = buildRecoveryPolicy({ retryOnCriticDefectsForRepair: false });
  assert.equal(decide(stub("withheld critic_defects"), 1, noRepair).kind, "stop_withheld");
});

test("decide: a semantic-repair attempt that ITSELF fails again is NOT repaired (budget=1)", () => {
  // repairsSoFar=1 ⇒ the one semantic-repair budget is spent ⇒ stop adverse.
  const d = decideRecovery({ attemptNumber: 2, result: stub("rejected"), policy: P, semanticRepairsSoFar: 1 });
  assert.equal(d.kind, "stop_rejected");
  assert.equal(d.reason, "repair_budget_exhausted");
});

test("decide: critic INDETERMINATE and NO_CHECKS are NEVER repaired", () => {
  assert.equal(decide(stub("withheld indeterminate")).kind, "stop_withheld");
  assert.equal(decide(stub("withheld indeterminate")).authorizesNewAttempt, false);
  assert.equal(decide(stub("withheld no_checks")).kind, "stop_withheld");
  assert.equal(decide(stub("withheld no_checks")).authorizesNewAttempt, false);
});

test("decide: dirty source ⇒ require_operator, NEVER an auto-retry over the same dirt", () => {
  const d = decide(stub("withheld dirty"));
  assert.equal(d.kind, "require_operator");
  assert.equal(d.reason, "operator_must_resolve");
  assert.equal(d.authorizesNewAttempt, false);
});

test("decide: dirty target worktree ⇒ require_operator", () => {
  assert.equal(decide(stub("withheld operator")).kind, "require_operator");
});

test("decide: build turn-limit ⇒ stop_failed, no retry", () => {
  assert.equal(decide(stub("failed build")).kind, "stop_failed");
});

test("decide: a wiring defect ⇒ stop_failed", () => {
  assert.equal(decide(stub("failed wiring")).kind, "stop_failed");
});

test("decide: a permanent provider failure ⇒ require_operator, never spins attempts", () => {
  assert.equal(decide(stub("failed provider permanent")).kind, "require_operator");
});

// environmental — policy + budget gated
for (const name of ["withheld target_moved", "quarantined drift (no disposition)", "quarantined timeout", "quarantined infra", "failed provider transient"]) {
  test(`decide: ${name} ⇒ retry_fresh_attempt while budget remains`, () => {
    const d = decide(stub(name), 1);
    assert.equal(d.kind, "retry_fresh_attempt");
    assert.equal(d.authorizesNewAttempt, true);
    assert.equal(d.nextAttemptNumber, 2);
  });

  test(`decide: ${name} ⇒ require_operator when the budget is exhausted`, () => {
    const d = decide(stub(name), 2); // attempt 2 of maxAttempts 2
    assert.equal(d.kind, "require_operator");
    assert.equal(d.reason, "retry_budget_exhausted");
    assert.equal(d.authorizesNewAttempt, false);
  });
}

test("decide: an environmental trigger with its policy flag OFF ⇒ require_operator (retry disabled)", () => {
  const noRetry = buildRecoveryPolicy({ retryOnTargetMoved: false, retryOnCasConflict: false });
  const d = decide(stub("withheld target_moved"), 1, noRetry);
  assert.equal(d.kind, "require_operator");
  assert.equal(d.reason, "retry_disabled_by_policy");
});

test("decide: a transient provider failure with retry OFF ⇒ require_operator", () => {
  const noRetry = buildRecoveryPolicy({ retryOnTransientProviderFailure: false });
  assert.equal(decide(stub("failed provider transient"), 1, noRetry).kind, "require_operator");
});

// ── decision identity ─────────────────────────────────────────────────────────

test("decision identity: same attempt + policy + decision ⇒ same id; clock excluded", () => {
  const args = { buildSessionId: "sess_1" as never, recoveryPolicyId: P.policyId, attemptNumber: 1, completedRunId: "run_1" as never, trigger: "target_moved" as const, kind: "retry_fresh_attempt" as const, reason: "environmental_retry" as const };
  assert.equal(recoveryDecisionDigest(args), recoveryDecisionDigest(args));
  assert.notEqual(recoveryDecisionDigest(args), recoveryDecisionDigest({ ...args, attemptNumber: 2 }));
});

// ── crash reconciliation — git state wins, journal never required ─────────────

test("reconcile: the candidate tree on target ⇒ landed_exact", () => {
  assert.equal(classifyPublicationLanding({ candidateTree: "T", targetTree: "T", targetHead: "P" }), "landed_exact");
});

test("reconcile: ref at the intended commit but a different tree ⇒ landed_degraded", () => {
  assert.equal(classifyPublicationLanding({ candidateTree: "T", targetTree: "OTHER", targetHead: "P", afterRef: "P" }), "landed_degraded");
});

test("reconcile: ref still at the authorized base ⇒ not_landed", () => {
  assert.equal(classifyPublicationLanding({ candidateTree: "T", targetTree: "B", targetHead: "H0", beforeRef: "H0" }), "not_landed");
});

test("reconcile: ref somewhere else entirely ⇒ ambiguous (never assume not-landed)", () => {
  assert.equal(classifyPublicationLanding({ candidateTree: "T", targetTree: "Z", targetHead: "H2" }), "ambiguous");
});

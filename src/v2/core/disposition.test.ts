/**
 * THE DISPOSITION / ADJUDICATION AUTHORITY — the pure decision, in isolation.
 *
 * The load-bearing property under test: NO single evidence source overrides another. A happy
 * critic never turns a red verifier green; a passing verifier never erases a concrete defect.
 * The combined matrix is exhaustive and explicit, the policy is a real identity-bearing input,
 * the subject refuses incoherent evidence, and the secondary flags are DERIVED — an impossible
 * combination cannot be built through the public API.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  adjudicate,
  buildDispositionPolicy,
  buildDispositionRecord,
  DEFAULT_DISPOSITION_POLICY,
  deriveDispositionFlags,
  dispositionDigest,
  dispositionPolicyDigest,
  judgeDisposition,
  summarizeDisposition,
  validateDispositionSubject,
  dispositionSubjectOf,
  V2_DISPOSITION_FAILURE_CODES,
  type DispositionDecision,
  type DispositionPolicy,
} from "./disposition.js";
import type { CandidateRecord } from "./candidate.js";
import type { VerificationRecord, VerificationVerdict } from "./verification.js";
import type { CriticRecord, CriticVerdict } from "./critic.js";
import type {
  V2CandidateId,
  V2CriticId,
  V2PlanDigest,
  V2RunId,
  V2SnapshotDigest,
  V2TaskId,
  V2VerificationId,
} from "./identity.js";

// ── hermetic evidence records ────────────────────────────────────────────────

const RUN = "run_disp" as V2RunId;
const TASK = "task_disp" as V2TaskId;
const SNAP = ("snap" + "0".repeat(60)) as V2SnapshotDigest;
const TREE = "a".repeat(40);
const CAND = "cand".repeat(16) as V2CandidateId;
const VERI = ("veri" + "0".repeat(60)) as V2VerificationId;
const CRIT = ("crit" + "0".repeat(60)) as V2CriticId;

function candidate(over: Partial<{ treeId: string; candidateId: V2CandidateId; runId: V2RunId; snapshot: V2SnapshotDigest }> = {}): CandidateRecord {
  return {
    candidateId: over.candidateId ?? CAND,
    runId: over.runId ?? RUN,
    taskId: TASK,
    sourceSnapshotId: over.snapshot ?? SNAP,
    workspaceId: "ws_x" as never,
    builderDecisionId: "d".repeat(64) as never,
    tree: { treeId: over.treeId ?? TREE, baseTreeId: "b".repeat(40), startTree: over.treeId ?? TREE, materializedStateDigest: "m".repeat(64), changed: true },
    claim: { believesComplete: true, summary: "did the thing" },
    invocationIds: [],
    mutationIds: [],
  } as unknown as CandidateRecord;
}

function verification(verdict: VerificationVerdict, over: Partial<{ candidateId: V2CandidateId; treeId: string; runId: V2RunId; treeAfter: string }> = {}): VerificationRecord {
  const tree = over.treeId ?? TREE;
  return {
    verificationId: VERI,
    runId: over.runId ?? RUN,
    candidateId: over.candidateId ?? CAND,
    candidateTreeId: tree,
    planId: "plan".repeat(16) as V2PlanDigest,
    treeBeforeChecks: tree,
    treeAfterChecks: over.treeAfter ?? tree,
    checks: [],
    verdict,
    workspaceDisposition: "retained",
    startedAt: 1,
    endedAt: 2,
  };
}

function critic(verdict: CriticVerdict, over: Partial<{ candidateId: V2CandidateId; treeId: string; runId: V2RunId; verificationId: V2VerificationId }> = {}): CriticRecord {
  return {
    criticId: CRIT,
    runId: over.runId ?? RUN,
    taskId: TASK,
    candidateId: over.candidateId ?? CAND,
    candidateTreeId: over.treeId ?? TREE,
    verificationId: over.verificationId ?? VERI,
    reviewPackageId: "rev".repeat(16) as never,
    criticDecisionId: "cd".repeat(32) as never,
    invocationId: "invocation_x" as never,
    verdict,
    summary: "a judgment",
    defects: [],
  } as unknown as CriticRecord;
}

const noDrift = async () => TREE;

// ── policy identity ──────────────────────────────────────────────────────────

test("policy: the default is the SAFE posture — pass AND satisfied required, no permissions", () => {
  assert.equal(DEFAULT_DISPOSITION_POLICY.requireVerificationPass, true);
  assert.equal(DEFAULT_DISPOSITION_POLICY.requireCriticSatisfied, true);
  assert.equal(DEFAULT_DISPOSITION_POLICY.allowNoChecks, false);
  assert.equal(DEFAULT_DISPOSITION_POLICY.allowIndeterminateCritic, false);
});

test("policy: identity is content-addressed and CHANGES with a permission", () => {
  const base = buildDispositionPolicy();
  const permissive = buildDispositionPolicy({ allowNoChecks: true });
  assert.match(base.policyId, /^[0-9a-f]{64}$/);
  assert.notEqual(base.policyId, permissive.policyId, "a different rule is a different policy");
  assert.equal(buildDispositionPolicy({ allowNoChecks: true }).policyId, permissive.policyId, "same rules ⇒ same id");
  assert.equal(dispositionPolicyDigest({ ...DEFAULT_DISPOSITION_POLICY }), base.policyId);
});

// ── the combined matrix: no source overrides another ─────────────────────────

const P = DEFAULT_DISPOSITION_POLICY;
const decide = (v: VerificationVerdict, c: CriticVerdict, policy: DispositionPolicy = P) =>
  adjudicate({ verificationVerdict: v, criticVerdict: c, policy });

test("matrix: PASS + satisfied ⇒ acceptable_for_promotion", () => {
  const o = decide("pass", "satisfied");
  assert.equal(o.decision, "acceptable_for_promotion");
  assert.equal(o.primaryReason, "acceptable");
});

test("matrix: PASS + defects_found ⇒ WITHHOLD — a passing verifier cannot erase a defect", () => {
  const o = decide("pass", "defects_found");
  assert.equal(o.decision, "withhold");
  assert.equal(o.primaryReason, "critic_defects");
});

test("matrix: PASS + indeterminate ⇒ WITHHOLD under the safe default", () => {
  assert.equal(decide("pass", "indeterminate").decision, "withhold");
  assert.equal(decide("pass", "indeterminate").primaryReason, "critic_indeterminate");
});

test("matrix: FAIL + satisfied ⇒ REJECT — a happy critic cannot override deterministic red", () => {
  const o = decide("fail", "satisfied");
  assert.equal(o.decision, "reject");
  assert.equal(o.primaryReason, "verification_failed");
});

test("matrix: FAIL + defects_found ⇒ REJECT, with the defect recorded as supporting", () => {
  const o = decide("fail", "defects_found");
  assert.equal(o.decision, "reject");
  assert.equal(o.primaryReason, "verification_failed");
  assert.deepEqual([...o.supportingReasons], ["critic_defects"]);
});

test("matrix: NO_CHECKS + satisfied ⇒ WITHHOLD (no deterministic evidence) under the default", () => {
  const o = decide("no_checks", "satisfied");
  assert.equal(o.decision, "withhold");
  assert.equal(o.primaryReason, "no_checks");
});

test("matrix: timeout / infrastructure_failure ⇒ QUARANTINE regardless of the critic", () => {
  for (const c of ["satisfied", "defects_found", "indeterminate"] as const) {
    assert.equal(decide("timeout", c).decision, "quarantine");
    assert.equal(decide("timeout", c).primaryReason, "verification_timeout");
    assert.equal(decide("infrastructure_failure", c).decision, "quarantine");
    assert.equal(decide("infrastructure_failure", c).primaryReason, "verification_infrastructure_failure");
  }
});

test("matrix: candidate_drift / workspace_mutated_by_checks ⇒ QUARANTINE hard", () => {
  assert.equal(decide("candidate_drift", "satisfied").primaryReason, "candidate_drift");
  assert.equal(decide("candidate_drift", "satisfied").decision, "quarantine");
  assert.equal(decide("workspace_mutated_by_checks", "satisfied").primaryReason, "check_mutated_candidate");
  assert.equal(decide("workspace_mutated_by_checks", "satisfied").decision, "quarantine");
});

// ── policy VARIATION genuinely changes the decision (and the identity) ─────────

test("policy variation: allowNoChecks flips NO_CHECKS + satisfied to acceptable", () => {
  const permissive = buildDispositionPolicy({ allowNoChecks: true });
  const o = decide("no_checks", "satisfied", permissive);
  assert.equal(o.decision, "acceptable_for_promotion");
  // The disposition IDENTITY differs from the default-policy decision on the same evidence.
  const idDefault = dispositionDigest({ candidateId: CAND, candidateTreeId: TREE, verificationId: VERI, criticId: CRIT, policyId: P.policyId, decision: "withhold", primaryReason: "no_checks", supportingReasons: [] });
  const idPermissive = dispositionDigest({ candidateId: CAND, candidateTreeId: TREE, verificationId: VERI, criticId: CRIT, policyId: permissive.policyId, decision: o.decision, primaryReason: o.primaryReason, supportingReasons: o.supportingReasons });
  assert.notEqual(idDefault, idPermissive, "policy is a real input to identity");
});

test("policy variation: allowIndeterminateCritic flips PASS + indeterminate to acceptable", () => {
  const permissive = buildDispositionPolicy({ allowIndeterminateCritic: true });
  assert.equal(decide("pass", "indeterminate", permissive).decision, "acceptable_for_promotion");
});

test("policy variation: autonomousPromotionAllowed=false withholds an otherwise-eligible candidate for the operator", () => {
  const held = buildDispositionPolicy({ autonomousPromotionAllowed: false });
  const o = decide("pass", "satisfied", held);
  assert.equal(o.decision, "withhold");
  assert.equal(o.primaryReason, "policy_requires_operator");
});

// ── derived flags — no boolean soup ───────────────────────────────────────────

test("flags: eligibleForPromotion is EXCLUSIVELY the acceptable decision", () => {
  const decisions: DispositionDecision[] = ["acceptable_for_promotion", "withhold", "reject", "quarantine"];
  for (const d of decisions) {
    const flags = deriveDispositionFlags(d, "acceptable");
    assert.equal(flags.eligibleForPromotion, d === "acceptable_for_promotion");
  }
});

test("flags: an eligible decision NEVER also requires recovery or operator", () => {
  const flags = deriveDispositionFlags("acceptable_for_promotion", "acceptable");
  assert.equal(flags.eligibleForPromotion, true);
  assert.equal(flags.requiresRecovery, false);
  assert.equal(flags.requiresOperator, false);
});

test("flags: requiresRecovery is set only for transient/suspect quarantines", () => {
  assert.equal(deriveDispositionFlags("quarantine", "verification_timeout").requiresRecovery, true);
  assert.equal(deriveDispositionFlags("quarantine", "verification_infrastructure_failure").requiresRecovery, true);
  assert.equal(deriveDispositionFlags("quarantine", "candidate_drift").requiresRecovery, true);
  assert.equal(deriveDispositionFlags("withhold", "no_checks").requiresRecovery, false);
});

test("flags: the built record derives its flags — they are not accepted as input", () => {
  const rec = buildDispositionRecord({
    runId: RUN, taskId: TASK, candidate: candidate(), verification: verification("pass"), critic: critic("satisfied"),
    policyId: P.policyId, outcome: decide("pass", "satisfied"),
  });
  assert.equal(rec.eligibleForPromotion, true);
  assert.equal(rec.requiresRecovery, false);
  assert.equal(rec.decision, "acceptable_for_promotion");
  // The identity excludes the run/clock — it is a statement about the evidence + policy.
  assert.match(rec.dispositionId, /^[0-9a-f]{64}$/);
});

// ── subject binding ──────────────────────────────────────────────────────────

test("subject: coherent evidence validates", () => {
  const subject = dispositionSubjectOf({ taskId: TASK, candidate: candidate(), verification: verification("pass"), critic: critic("satisfied"), policyId: P.policyId });
  assert.equal(validateDispositionSubject({ subject, candidate: candidate(), verification: verification("pass"), critic: critic("satisfied") }).ok, true);
});

test("subject: a verification of a DIFFERENT candidate is refused", () => {
  const other = "ffff".repeat(16) as V2CandidateId;
  const subject = dispositionSubjectOf({ taskId: TASK, candidate: candidate(), verification: verification("pass"), critic: critic("satisfied"), policyId: P.policyId });
  const r = validateDispositionSubject({ subject, candidate: candidate(), verification: verification("pass", { candidateId: other }), critic: critic("satisfied") });
  assert.equal(r.ok, false);
});

test("subject: a critic resting on a DIFFERENT verification is refused", () => {
  const otherVeri = "eeee".repeat(16) as V2VerificationId;
  const subject = dispositionSubjectOf({ taskId: TASK, candidate: candidate(), verification: verification("pass"), critic: critic("satisfied"), policyId: P.policyId });
  const r = validateDispositionSubject({ subject, candidate: candidate(), verification: verification("pass"), critic: critic("satisfied", { verificationId: otherVeri }) });
  assert.equal(r.ok, false);
});

// ── judgeDisposition: the wrapped authority ──────────────────────────────────

test("judge: coherent PASS + satisfied yields a bound record", async () => {
  const r = await judgeDisposition({
    runId: RUN, taskId: TASK, candidate: candidate(), verification: verification("pass"), critic: critic("satisfied"),
    policy: P, workspacePath: "/ws", probeTree: noDrift,
  });
  assert.ok(r.ok);
  assert.equal(r.record.decision, "acceptable_for_promotion");
  assert.equal(r.record.candidateId, CAND);
  assert.equal(r.record.verificationId, VERI);
  assert.equal(r.record.criticId, CRIT);
});

test("judge: a MISMATCH is a hard failure, not a decision", async () => {
  const foreign = critic("satisfied", { candidateId: "9999".repeat(16) as V2CandidateId });
  const r = await judgeDisposition({
    runId: RUN, taskId: TASK, candidate: candidate(), verification: verification("pass"), critic: foreign,
    policy: P, workspacePath: "/ws", probeTree: noDrift,
  });
  assert.ok(!r.ok && r.kind === "mismatch");
  assert.equal(r.failure.code, V2_DISPOSITION_FAILURE_CODES.subjectMismatch);
  assert.equal(r.failure.stage, "disposition");
});

test("judge: a tree that MOVED since the critic looked ⇒ DRIFT, no decision", async () => {
  const movedTree = "c".repeat(40);
  const r = await judgeDisposition({
    runId: RUN, taskId: TASK, candidate: candidate(), verification: verification("pass"), critic: critic("satisfied"),
    policy: P, workspacePath: "/ws", probeTree: async () => movedTree,
  });
  assert.ok(!r.ok && r.kind === "drift");
  assert.match(r.detail, /no longer matches/);
  assert.equal(r.currentTree, movedTree);
});

test("judge: a verification that ended on a different tree ⇒ DRIFT (stale evidence)", async () => {
  const r = await judgeDisposition({
    runId: RUN, taskId: TASK, candidate: candidate(), verification: verification("pass", { treeAfter: "d".repeat(40) }), critic: critic("satisfied"),
    policy: P, workspacePath: "/ws", probeTree: noDrift,
  });
  assert.ok(!r.ok && r.kind === "drift");
  assert.match(r.detail, /verification ended on tree/);
});

// ── receipt projection ───────────────────────────────────────────────────────

test("summary: the projection carries the decision, reasons and flags — no bodies", () => {
  const rec = buildDispositionRecord({
    runId: RUN, taskId: TASK, candidate: candidate(), verification: verification("pass"), critic: critic("defects_found"),
    policyId: P.policyId, outcome: decide("pass", "defects_found"),
  });
  const s = summarizeDisposition(rec);
  assert.equal(s.decision, "withhold");
  assert.equal(s.primaryReason, "critic_defects");
  assert.equal(s.verificationVerdict, "pass");
  assert.equal(s.criticVerdict, "defects_found");
  assert.equal(s.eligibleForPromotion, false);
});

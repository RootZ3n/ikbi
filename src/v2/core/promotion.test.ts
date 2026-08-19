/**
 * THE PROMOTION / PUBLICATION AUTHORITY — the pure decision, in isolation.
 *
 * Promotion re-adjudicates NOTHING. It proves authorization from the DispositionRecord,
 * rechecks every mutable fact at its own boundary, refuses anything unsafe WITHOUT touching
 * git, and lands EXACTLY the candidate tree by a clean-ref CAS. These tests drive the pure
 * `promoteAuthorized` with a fake `PromotionTarget`, so every refusal and every landing is
 * exercised without a real repository. The real git path is proven in `cli/promotion-truth`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  promoteAuthorized,
  promotionRecordDigest,
  promotionSubjectOf,
  summarizePromotion,
  validatePromotionSubject,
  V2_PROMOTION_FAILURE_CODES,
  type PromotionTarget,
  type PublicationOutcome,
} from "./promotion.js";
import type { CandidateRecord } from "./candidate.js";
import type { VerificationRecord, VerificationVerdict } from "./verification.js";
import type { CriticRecord, CriticVerdict } from "./critic.js";
import type { DispositionRecord, DispositionDecision } from "./disposition.js";
import type {
  V2CandidateId,
  V2CriticId,
  V2DispositionId,
  V2DispositionPolicyDigest,
  V2PlanDigest,
  V2RunId,
  V2SnapshotDigest,
  V2TaskId,
  V2VerificationId,
} from "./identity.js";

// ── hermetic evidence records ────────────────────────────────────────────────

const RUN = "run_promo" as V2RunId;
const TASK = "task_promo" as V2TaskId;
const SNAP = ("snap" + "0".repeat(60)) as V2SnapshotDigest;
const TREE = "a".repeat(40);
const BASE = "b".repeat(40);
const CAND = "cand".repeat(16) as V2CandidateId;
const VERI = ("veri" + "0".repeat(60)) as V2VerificationId;
const CRIT = ("crit" + "0".repeat(60)) as V2CriticId;
const DISP = ("disp" + "0".repeat(60)) as V2DispositionId;
const POLICY = ("pol" + "0".repeat(61)) as V2DispositionPolicyDigest;

function candidate(over: Partial<{ treeId: string; candidateId: V2CandidateId; snapshot: V2SnapshotDigest }> = {}): CandidateRecord {
  return {
    candidateId: over.candidateId ?? CAND,
    runId: RUN,
    taskId: TASK,
    sourceSnapshotId: over.snapshot ?? SNAP,
    workspaceId: "ws_x" as never,
    builderDecisionId: "d".repeat(64) as never,
    tree: { treeId: over.treeId ?? TREE, baseTreeId: "z".repeat(40), startTree: over.treeId ?? TREE, materializedStateDigest: "m".repeat(64), changed: true },
    claim: { believesComplete: true, summary: "did the thing" },
    invocationIds: [],
    mutationIds: [],
  } as unknown as CandidateRecord;
}

function verification(over: Partial<{ treeAfter: string; verdict: VerificationVerdict }> = {}): VerificationRecord {
  return {
    verificationId: VERI, runId: RUN, candidateId: CAND, candidateTreeId: TREE,
    planId: "plan".repeat(16) as V2PlanDigest, treeBeforeChecks: TREE, treeAfterChecks: over.treeAfter ?? TREE,
    checks: [], verdict: over.verdict ?? "pass", workspaceDisposition: "retained", startedAt: 1, endedAt: 2,
  };
}

function critic(over: Partial<{ verdict: CriticVerdict }> = {}): CriticRecord {
  return {
    criticId: CRIT, runId: RUN, taskId: TASK, candidateId: CAND, candidateTreeId: TREE, verificationId: VERI,
    reviewPackageId: "rev".repeat(16) as never, criticDecisionId: "cd".repeat(32) as never, invocationId: "invocation_x" as never,
    verdict: over.verdict ?? "satisfied", summary: "ok", defects: [],
  } as unknown as CriticRecord;
}

function disposition(over: Partial<{ decision: DispositionDecision; eligible: boolean }> = {}): DispositionRecord {
  const decision = over.decision ?? "acceptable_for_promotion";
  return {
    dispositionId: DISP, runId: RUN, taskId: TASK, candidateId: CAND, candidateTreeId: TREE,
    verificationId: VERI, verificationVerdict: "pass", criticId: CRIT, criticVerdict: "satisfied",
    policyId: POLICY, decision, primaryReason: "acceptable", supportingReasons: [],
    eligibleForPromotion: over.eligible ?? decision === "acceptable_for_promotion",
    requiresRecovery: false, requiresOperator: false,
  };
}

const TARGET = { repositoryPath: "/repo", baseBranch: "main", baseCommit: BASE };
const noDrift = async () => TREE;

/** A fake publication target. Defaults: unmoved clean target that LANDS the candidate tree. */
function fakeTarget(over: Partial<{
  liveHead: string | undefined;
  liveTree: string;
  checkout: { checkedOutPath?: string; clean: boolean };
  publish: PublicationOutcome;
}> = {}): { target: PromotionTarget; published: string[] } {
  const published: string[] = [];
  return {
    published,
    target: {
      liveHead: async () => ("liveHead" in over ? over.liveHead : BASE),
      treeOfCommit: async () => over.liveTree ?? "live".repeat(10),
      targetCheckout: async () => over.checkout ?? { clean: true },
      publish: async (input) => {
        published.push(input.candidateTreeId);
        return over.publish ?? { kind: "landed", beforeRef: BASE, afterCommit: "p".repeat(40), publishedTree: TREE, worktreeSynced: true, stashed: false };
      },
    },
  };
}

const authorize = (over: Parameters<typeof promoteAuthorized>[0] extends infer T ? Partial<T> : never = {}) =>
  promoteAuthorized({
    taskId: TASK,
    candidate: candidate(),
    verification: verification(),
    critic: critic(),
    disposition: disposition(),
    target: TARGET,
    sourceClean: true,
    workspacePath: "/ws",
    probeTree: noDrift,
    publisher: fakeTarget().target,
    now: () => 111,
    ...over,
  });

// ── subject validation ───────────────────────────────────────────────────────

test("subject: coherent + eligible evidence validates", () => {
  const subject = promotionSubjectOf({ taskId: TASK, candidate: candidate(), verification: verification(), critic: critic(), disposition: disposition() });
  assert.equal(subject.eligibleForPromotion, true);
  const r = validatePromotionSubject({ subject, candidate: candidate(), verification: verification(), critic: critic(), disposition: disposition() });
  assert.equal(r.ok, true);
});

test("subject: a NON-eligible disposition is refused as not_eligible (not a mismatch)", () => {
  const held = disposition({ decision: "withhold", eligible: false });
  const subject = promotionSubjectOf({ taskId: TASK, candidate: candidate(), verification: verification(), critic: critic(), disposition: held });
  const r = validatePromotionSubject({ subject, candidate: candidate(), verification: verification(), critic: critic(), disposition: held });
  assert.ok(!r.ok && r.kind === "not_eligible");
});

test("subject: a disposition adjudicating a DIFFERENT candidate is a mismatch", () => {
  const subject = promotionSubjectOf({ taskId: TASK, candidate: candidate(), verification: verification(), critic: critic(), disposition: disposition() });
  const foreign = { ...disposition(), candidateId: "ffff".repeat(16) as V2CandidateId };
  const r = validatePromotionSubject({ subject, candidate: candidate(), verification: verification(), critic: critic(), disposition: foreign });
  assert.ok(!r.ok && r.kind === "mismatch");
});

// ── the clean happy path ─────────────────────────────────────────────────────

test("promote: a clean eligible candidate LANDS exactly its tree", async () => {
  const fake = fakeTarget();
  const r = await authorize({ publisher: fake.target });
  assert.ok(r.kind === "promoted");
  assert.equal(r.record.publishedTree, TREE, "the EXACT candidate tree");
  assert.equal(r.record.beforeRef, BASE);
  assert.equal(r.record.strategy, "clean_ref_cas");
  assert.equal(r.record.degraded, false);
  assert.equal(r.record.idempotent, false);
  assert.deepEqual(fake.published, [TREE], "the seam was asked to publish exactly the candidate tree");
  assert.match(r.record.promotionId, /^[0-9a-f]{64}$/);
});

// ── the refusals — NONE touch git ────────────────────────────────────────────

test("promote: a NON-eligible disposition is refused BEFORE any publish", async () => {
  const fake = fakeTarget();
  const r = await authorize({ disposition: disposition({ decision: "reject", eligible: false }), publisher: fake.target });
  assert.ok(r.kind === "refused_not_eligible");
  assert.deepEqual(fake.published, [], "nothing was published");
});

test("promote: WRONG evidence (foreign critic) is a hard failure, no publish", async () => {
  const fake = fakeTarget();
  const foreignCritic = { ...critic(), candidateId: "9999".repeat(16) as V2CandidateId } as CriticRecord;
  const r = await authorize({ critic: foreignCritic, publisher: fake.target });
  assert.ok(r.kind === "refused_wrong_evidence");
  assert.equal(r.failure.code, V2_PROMOTION_FAILURE_CODES.wrongEvidence);
  assert.deepEqual(fake.published, []);
});

test("promote: a DIRTY source snapshot is refused (unsupported), no publish", async () => {
  const fake = fakeTarget();
  const r = await authorize({ sourceClean: false, publisher: fake.target });
  assert.ok(r.kind === "refused_dirty_source_unsupported");
  assert.deepEqual(fake.published, [], "the operator's dirty work is never folded into a commit");
});

test("promote: CANDIDATE DRIFT (workspace tree moved) is refused before publish", async () => {
  const fake = fakeTarget();
  const r = await authorize({ probeTree: async () => "c".repeat(40), publisher: fake.target });
  assert.ok(r.kind === "refused_candidate_drift");
  assert.equal(r.observedTree, "c".repeat(40));
  assert.deepEqual(fake.published, []);
});

test("promote: a verification on a DIFFERENT tree is candidate drift", async () => {
  const fake = fakeTarget();
  const r = await authorize({ verification: verification({ treeAfter: "d".repeat(40) }), publisher: fake.target });
  assert.ok(r.kind === "refused_candidate_drift");
  assert.deepEqual(fake.published, []);
});

test("promote: a MOVED target is refused — NO auto-merge", async () => {
  const fake = fakeTarget({ liveHead: "moved".repeat(8) });
  const r = await authorize({ publisher: fake.target });
  assert.ok(r.kind === "refused_stale_target");
  assert.equal(r.expectedHead, BASE);
  assert.equal(r.observedHead, "moved".repeat(8));
  assert.deepEqual(fake.published, [], "a moved target is never merged");
});

test("promote: a DIRTY checked-out target worktree is refused", async () => {
  const fake = fakeTarget({ checkout: { checkedOutPath: "/repo", clean: false } });
  const r = await authorize({ publisher: fake.target });
  assert.ok(r.kind === "refused_target_worktree_dirty");
  assert.deepEqual(fake.published, []);
});

test("promote: a CAS CONFLICT is reported distinctly — no force, no retry", async () => {
  const fake = fakeTarget({ publish: { kind: "cas_conflict", observedHead: "race".repeat(10) } });
  const r = await authorize({ publisher: fake.target });
  assert.ok(r.kind === "cas_conflict");
  assert.equal(r.observedHead, "race".repeat(10));
});

// ── idempotency ──────────────────────────────────────────────────────────────

test("promote: an ALREADY-landed candidate is idempotent — no second publish", async () => {
  // The live head already holds the exact candidate tree.
  const fake = fakeTarget({ liveHead: "landed".repeat(7).slice(0, 40), liveTree: TREE });
  const r = await authorize({ publisher: fake.target });
  assert.ok(r.kind === "already_promoted");
  assert.equal(r.record.idempotent, true);
  assert.equal(r.record.publishedTree, TREE);
  assert.deepEqual(fake.published, [], "no second CAS, no duplicate commit");
});

test("promote: the SAME candidate to the SAME target has the SAME promotion identity", () => {
  const a = promotionRecordDigest({ candidateId: CAND, candidateTreeId: TREE, dispositionId: DISP, sourceSnapshotId: SNAP, targetBranch: "main", publishedTree: TREE });
  const b = promotionRecordDigest({ candidateId: CAND, candidateTreeId: TREE, dispositionId: DISP, sourceSnapshotId: SNAP, targetBranch: "main", publishedTree: TREE });
  assert.equal(a, b, "identity binds what was authorized + what landed — an idempotent re-request reproduces it");
  const different = promotionRecordDigest({ candidateId: CAND, candidateTreeId: TREE, dispositionId: DISP, sourceSnapshotId: SNAP, targetBranch: "release", publishedTree: TREE });
  assert.notEqual(a, different, "a different target is a different promotion");
});

// ── degraded success ─────────────────────────────────────────────────────────

test("promote: a landed-but-desynced publish is a DEGRADED SUCCESS — the ref moved", async () => {
  const fake = fakeTarget({ publish: { kind: "landed_desynced", beforeRef: BASE, afterCommit: "p".repeat(40), publishedTree: TREE, detail: "worktree sync failed" } });
  const r = await authorize({ publisher: fake.target });
  assert.ok(r.kind === "promoted_degraded");
  assert.equal(r.record.degraded, true);
  assert.equal(r.record.worktreeSynced, false);
  assert.equal(r.record.afterRef, "p".repeat(40), "the ref DID move — never reported as an ordinary failure");
});

test("promote: a pre-CAS tree mismatch is an infrastructure failure — nothing landed", async () => {
  const fake = fakeTarget({ publish: { kind: "tree_mismatch", builtTree: "wrong".repeat(8) } });
  const r = await authorize({ publisher: fake.target });
  assert.ok(r.kind === "infrastructure_failure");
  assert.equal(r.failure.code, V2_PROMOTION_FAILURE_CODES.publicationFailed);
});

// ── summary ──────────────────────────────────────────────────────────────────

test("summary: the projection carries target, before/after and published tree", async () => {
  const r = await authorize();
  assert.ok(r.kind === "promoted");
  const s = summarizePromotion(r.record);
  assert.equal(s.targetBranch, "main");
  assert.equal(s.publishedTree, TREE);
  assert.equal(s.strategy, "clean_ref_cas");
  assert.equal(s.degraded, false);
});

/**
 * The canonical lifecycle: legal ordering, and — the point of the file — the
 * illegal moves it REFUSES. Every negative case here is a class of bug that v1 had
 * to catch downstream with scattered checks; in v2 the spine cannot express them.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createSequentialIdFactory, type V2ContextDigest, type V2DecisionDigest, type V2PolicyDigest, type V2SnapshotDigest } from "./identity.js";
import {
  LIFECYCLE_STAGES,
  LifecycleViolationError,
  RunLifecycle,
  canEnter,
  isLifecycleStage,
  stageIndex,
  successorStage,
  type LifecycleStage,
  type LifecycleViolationCode,
} from "./lifecycle.js";
import type { V2CandidateId, V2VerificationId, V2CriticId } from "./identity.js";
import { summarizeEvidence } from "./result.js";

const ids = createSequentialIdFactory("lcx");

/** A stand-in policy digest. Content-addressed identity is the config suite's concern. */
const POLICY = "0".repeat(64) as V2PolicyDigest;
/** A stand-in decision digest. Decision identity is the resolver suite's concern. */
const DECISION = "1".repeat(64) as V2DecisionDigest;
/** A stand-in context digest. Package identity is the context suite's concern. */
const CONTEXT = "2".repeat(64) as V2ContextDigest;
/** A stand-in invocation id. Invocation identity is the invocation suite's concern. */
const INVOCATION = ids.mint("invocation");
const CRITIC_INVOCATION = ids.mint("invocation");
/** A stand-in workspace id. Workspace identity is the workspace suite's concern. */
const WORKSPACE = ids.mint("workspace");
/** A stand-in snapshot digest. Snapshot identity is the source suite's concern. */
const SNAPSHOT = "5".repeat(64) as V2SnapshotDigest;

/**
 * A distinct content-addressed candidate id.
 *
 * V2-007 made candidate identity a DIGEST rather than a minted id — a candidate IS the
 * state it produced — so tests construct them instead of minting them. Candidate identity
 * itself is the candidate suite's concern.
 */
let candidateSeed = 0;
const fakeCandidateId = (seed: string): V2CandidateId => (`${seed}`.repeat(64).slice(0, 64) as V2CandidateId);

/**
 * A distinct content-addressed verification id. V2-008 made verification identity a DIGEST
 * (a verification IS a statement about an exact candidate tree + plan + results).
 */
let verificationSeed = 0;
const fakeVerificationId = (seed: string): V2VerificationId => (`${seed}`.repeat(64).slice(0, 64) as V2VerificationId);
const fakeCriticId = (seed: string): V2CriticId => (`${seed}`.repeat(64).slice(0, 64) as V2CriticId);

function fresh() {
  const ids = createSequentialIdFactory("lc");
  const runId = ids.mint("run");
  let tick = 0;
  return { lifecycle: new RunLifecycle({ runId, now: () => (tick += 1) }), ids, runId };
}

/** Walk the machine to `target`, recording the minimum evidence each stage needs. */
function walkTo(target: LifecycleStage) {
  const ctx = fresh();
  const { lifecycle, ids, runId } = ctx;
  // V2-007: a candidate is CONTENT-ADDRESSED — it is the state it produced, not an event
  // that occurred. The test mints distinct digests the same way the real code does.
  const candidateId = fakeCandidateId("a");
  const workspaceId = ids.mint("workspace");
  const verificationId = fakeVerificationId("v");
  const criticId = fakeCriticId("c");
  const promotionId = ids.mint("promotion");
  for (const stage of LIFECYCLE_STAGES) {
    lifecycle.enter(runId, stage);
    // V2-002: model_resolution now REQUIRES a recorded configuration, so a full walk
    // must establish one in preflight — the stage that owns configuration truth.
    if (stage === "preflight") {
      lifecycle.record(runId, { kind: "configuration", policyId: POLICY });
      // V2-006A: context and candidate_strategy both require the run's source snapshot.
      lifecycle.record(runId, { kind: "snapshot", id: SNAPSHOT, clean: true });
    }
    // V2-003: `context` REQUIRES a recorded resolution — its budget is a function of the
    // resolved model's window, so a full walk must authorize a route first.
    if (stage === "model_resolution") lifecycle.record(runId, { kind: "resolution", decisionId: DECISION, role: "builder" });
    // V2-004: `candidate_strategy` REQUIRES an authorized context package.
    if (stage === "context") lifecycle.record(runId, { kind: "context", packageId: CONTEXT, artifacts: 3 });
    // V2-007: invocation evidence belongs to candidate_generation — the builder loop is
    // where a model is actually called, and the standalone qualification stage is gone.
    if (stage === "candidate_generation") lifecycle.record(runId, { kind: "invocation", id: INVOCATION, role: "builder" });
    // V2-006: `candidate_generation` REQUIRES an isolated workspace to build in.
    if (stage === "candidate_strategy") lifecycle.record(runId, { kind: "workspace", id: WORKSPACE, baseTree: "t" });
    if (stage === "candidate_generation") lifecycle.record(runId, { kind: "candidate", id: candidateId, workspaceId });
    if (stage === "verification") lifecycle.record(runId, { kind: "verification", id: verificationId, candidateId });
    // V2-009: the critic's judgment (and its one invocation) belong to the criticism stage.
    if (stage === "criticism") {
      lifecycle.record(runId, { kind: "invocation", id: CRITIC_INVOCATION, role: "critic" });
      lifecycle.record(runId, { kind: "critic", id: criticId, candidateId, verificationId });
    }
    if (stage === "promotion") lifecycle.record(runId, { kind: "promotion", id: promotionId, candidateId, verificationId });
    if (stage === target) break;
  }
  return { ...ctx, candidateId, verificationId, criticId, promotionId };
}

function violation(fn: () => void): LifecycleViolationCode {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof LifecycleViolationError, `expected a LifecycleViolationError, got ${String(err)}`);
    return err.code;
  }
  assert.fail("expected a lifecycle violation, but the call succeeded");
}

// ── ordering ────────────────────────────────────────────────────────────────

test("lifecycle: the canonical order is preflight -> … -> promotion", () => {
  // V2-007 removed the standalone `invocation` stage: a model is invoked BY the builder,
  // during candidate_generation, so invocation is an act rather than a place.
  assert.deepEqual([...LIFECYCLE_STAGES], [
    "preflight",
    "model_resolution",
    "context",
    "candidate_strategy",
    "candidate_generation",
    "verification",
    "criticism",
    "disposition",
    "promotion",
  ]);
  assert.equal(successorStage("promotion"), undefined, "promotion is the last stage");
  assert.ok(isLifecycleStage("verification"));
  assert.equal(isLifecycleStage("receipt"), false, "a receipt is produced, never a stage a run sits in");
});

test("lifecycle: a full legal walk reaches promotion and journals every step", () => {
  const { lifecycle } = walkTo("promotion");
  assert.deepEqual([...lifecycle.stagesEntered], [...LIFECYCLE_STAGES]);
  assert.equal(lifecycle.journal[0]?.from, "pending");
  assert.equal(lifecycle.journal[0]?.to, "preflight");
  assert.equal(lifecycle.journal.length, LIFECYCLE_STAGES.length);
});

test("lifecycle: a run must start at preflight — no entering the middle", () => {
  const { lifecycle, runId } = fresh();
  assert.equal(violation(() => lifecycle.enter(runId, "verification")), "illegal_stage_order");
  assert.equal(violation(() => lifecycle.enter(runId, "promotion")), "illegal_stage_order");
});

test("lifecycle: stages cannot be SKIPPED", () => {
  const { lifecycle, runId } = fresh();
  lifecycle.enter(runId, "preflight");
  lifecycle.record(runId, { kind: "configuration", policyId: POLICY });
  lifecycle.enter(runId, "model_resolution");
  assert.equal(violation(() => lifecycle.enter(runId, "candidate_strategy")), "illegal_stage_order");
});

test("lifecycle: stages cannot be RE-ENTERED or walked backwards", () => {
  const { lifecycle, runId } = fresh();
  lifecycle.enter(runId, "preflight");
  lifecycle.record(runId, { kind: "configuration", policyId: POLICY });
  lifecycle.enter(runId, "model_resolution");
  assert.equal(violation(() => lifecycle.enter(runId, "model_resolution")), "illegal_stage_order");
  assert.equal(violation(() => lifecycle.enter(runId, "preflight")), "illegal_stage_order");
});

test("lifecycle: canEnter is the pure twin of enter", () => {
  assert.equal(canEnter({ kind: "pending" }, "preflight"), true);
  assert.equal(canEnter({ kind: "pending" }, "context"), false);
  assert.equal(canEnter({ kind: "pending" }, "model_resolution"), false);
  assert.equal(canEnter({ kind: "running", stage: "preflight" }, "model_resolution"), true);
  assert.equal(canEnter({ kind: "running", stage: "verification" }, "criticism"), true);
  assert.equal(canEnter({ kind: "running", stage: "verification" }, "disposition"), false);
  assert.equal(canEnter({ kind: "running", stage: "criticism" }, "disposition"), true);
  assert.equal(canEnter({ kind: "terminal", outcome: { kind: "rejected", reason: "no_work" } }, "preflight"), false);
});

// ── evidence preconditions ──────────────────────────────────────────────────

test("lifecycle: VERIFICATION cannot be entered before a candidate exists", () => {
  const { lifecycle, runId } = fresh();
  lifecycle.enter(runId, "preflight");
  lifecycle.record(runId, { kind: "configuration", policyId: POLICY });
  lifecycle.record(runId, { kind: "snapshot", id: SNAPSHOT, clean: true });
  lifecycle.enter(runId, "model_resolution");
  lifecycle.record(runId, { kind: "resolution", decisionId: DECISION, role: "builder" });
  lifecycle.enter(runId, "context");
  lifecycle.record(runId, { kind: "context", packageId: CONTEXT, artifacts: 3 });
  lifecycle.enter(runId, "candidate_strategy");
  lifecycle.record(runId, { kind: "workspace", id: WORKSPACE, baseTree: "t" });
  lifecycle.enter(runId, "candidate_generation");
  // candidate_generation ran but produced nothing — there is nothing to verify.
  assert.equal(violation(() => lifecycle.enter(runId, "verification")), "missing_required_evidence");
});

test("lifecycle: CRITICISM cannot be entered before a verification VERDICT exists (V2-008)", () => {
  const { lifecycle, runId } = walkTo("candidate_generation");
  // The verification STAGE is entered, but no verdict is recorded — criticism must not run
  // on a candidate deterministic verification has not judged.
  lifecycle.enter(runId, "verification");
  assert.equal(violation(() => lifecycle.enter(runId, "criticism")), "missing_required_evidence");
});

test("lifecycle: DISPOSITION cannot be entered before a CRITIC VERDICT exists (V2-009)", () => {
  const { lifecycle, runId, candidateId, verificationId } = walkTo("verification");
  // Verification recorded, criticism entered — but no critic judgment yet. Disposition
  // needs BOTH evidence classes.
  void candidateId; void verificationId;
  lifecycle.enter(runId, "criticism");
  assert.equal(violation(() => lifecycle.enter(runId, "disposition")), "missing_required_evidence");
});

test("lifecycle: a stage may only record the evidence it owns", () => {
  const { lifecycle, ids, runId } = fresh();
  lifecycle.enter(runId, "preflight");
  assert.equal(
    violation(() => lifecycle.record(runId, { kind: "candidate", id: fakeCandidateId(String(candidateSeed += 1)), workspaceId: ids.mint("workspace") })),
    "stage_not_permitted_for_evidence",
    "preflight cannot mint candidates",
  );
  assert.equal(
    violation(() => lifecycle.record(runId, { kind: "invocation", id: ids.mint("invocation"), role: "builder" })),
    "stage_not_permitted_for_evidence",
    "no model may be invoked from preflight",
  );
});

test("lifecycle: a verification must name a candidate that was actually recorded", () => {
  const { lifecycle, runId } = walkTo("verification");
  assert.equal(
    violation(() =>
      lifecycle.record(runId, { kind: "verification", id: fakeVerificationId(String(verificationSeed += 1)), candidateId: fakeCandidateId(String(candidateSeed += 1)) }),
    ),
    "unrecorded_evidence",
  );
});

test("lifecycle: a promotion cannot ride a verification of a DIFFERENT candidate", () => {
  const { lifecycle, ids, runId, verificationId } = walkTo("candidate_generation");
  const other = fakeCandidateId(String(candidateSeed += 1));
  lifecycle.record(runId, { kind: "candidate", id: other, workspaceId: ids.mint("workspace") });
  lifecycle.enter(runId, "verification");
  const firstCandidate = lifecycle.ledger.candidates[0]!;
  lifecycle.record(runId, { kind: "verification", id: verificationId, candidateId: firstCandidate });
  lifecycle.enter(runId, "criticism");
  lifecycle.record(runId, { kind: "critic", id: fakeCriticId(String(candidateSeed += 1)), candidateId: firstCandidate, verificationId });
  lifecycle.enter(runId, "disposition");
  lifecycle.enter(runId, "promotion");
  assert.equal(
    violation(() =>
      lifecycle.record(runId, { kind: "promotion", id: ids.mint("promotion"), candidateId: other, verificationId }),
    ),
    "evidence_mismatch",
  );
});

// ── terminalization ─────────────────────────────────────────────────────────

test("lifecycle: a run can terminalize exactly ONCE", () => {
  const { lifecycle, runId } = fresh();
  lifecycle.enter(runId, "preflight");
  lifecycle.terminalize(runId, { kind: "rejected", reason: "no_work" });
  assert.equal(violation(() => lifecycle.terminalize(runId, { kind: "rejected", reason: "aborted" })), "already_terminal");
});

test("lifecycle: nothing may happen after a run terminalizes", () => {
  const { lifecycle, ids, runId } = fresh();
  lifecycle.enter(runId, "preflight");
  lifecycle.terminalize(runId, { kind: "quarantined", reason: "operator_hold", detail: "held" });
  assert.equal(violation(() => lifecycle.enter(runId, "context")), "already_terminal");
  assert.equal(violation(() => lifecycle.record(runId, { kind: "invocation", id: ids.mint("invocation"), role: "builder" })), "already_terminal");
});

test("lifecycle: ACCEPTED requires a promotion that was really recorded", () => {
  const { lifecycle, ids, runId, candidateId, verificationId } = walkTo("promotion");
  assert.equal(
    violation(() =>
      lifecycle.terminalize(runId, { kind: "accepted", candidateId, verificationId, promotionId: ids.mint("promotion") }),
    ),
    "unrecorded_evidence",
    "a fabricated promotion id cannot become a success",
  );
});

test("lifecycle: ACCEPTED is impossible without ever reaching the promotion stage", () => {
  const { lifecycle, ids, runId, candidateId, verificationId } = walkTo("disposition");
  assert.equal(
    violation(() =>
      lifecycle.terminalize(runId, { kind: "accepted", candidateId, verificationId, promotionId: ids.mint("promotion") }),
    ),
    "outcome_stage_not_reached",
  );
});

test("lifecycle: ACCEPTED on real evidence is allowed, and the receipt counts it", () => {
  const { lifecycle, runId, candidateId, verificationId, promotionId } = walkTo("promotion");
  lifecycle.terminalize(runId, { kind: "accepted", candidateId, verificationId, promotionId });
  const outcome = lifecycle.outcome!;
  const summary = summarizeEvidence(lifecycle.ledger, outcome);
  assert.equal(summary.promoted, true);
  assert.equal(summary.sourceRepositoryMutated, true);
  assert.equal(summary.candidatesCreated, 1);
  assert.equal(summary.verificationsPerformed, 1);
});

test("lifecycle: WITHHELD must cite the verification that judged its own candidate", () => {
  const { lifecycle, runId, candidateId, verificationId } = walkTo("disposition");
  assert.equal(
    violation(() =>
      lifecycle.terminalize(runId, {
        kind: "withheld",
        candidateId: fakeCandidateId(String(candidateSeed += 1)),
        verificationId,
        reason: "governance",
      }),
    ),
    "evidence_mismatch",
  );
  lifecycle.terminalize(runId, { kind: "withheld", candidateId, verificationId, reason: "governance" });
  const summary = summarizeEvidence(lifecycle.ledger, lifecycle.outcome!);
  assert.equal(summary.promoted, false, "withheld work is verified but NOT promoted");
  assert.equal(summary.sourceRepositoryMutated, false);
});

test("lifecycle: a recorded promotion that did not become the outcome never reads as landed", () => {
  const { lifecycle, runId } = walkTo("promotion");
  lifecycle.terminalize(runId, { kind: "rejected", reason: "aborted" });
  const summary = summarizeEvidence(lifecycle.ledger, lifecycle.outcome!);
  assert.equal(summary.promotionsAttempted, 1, "the attempt is still recorded, honestly");
  assert.equal(summary.promoted, false, "but it did not land");
  assert.equal(summary.sourceRepositoryMutated, false);
});

// ── run identity ────────────────────────────────────────────────────────────

test("lifecycle: a foreign run id is rejected on every mutating call", () => {
  const { lifecycle, ids, runId } = fresh();
  const foreign = ids.mint("run");
  assert.notEqual(foreign, runId);
  assert.equal(violation(() => lifecycle.enter(foreign, "preflight")), "run_identity_mismatch");
  lifecycle.enter(runId, "preflight");
  assert.equal(violation(() => lifecycle.record(foreign, { kind: "invocation", id: ids.mint("invocation"), role: "builder" })), "run_identity_mismatch");
  assert.equal(violation(() => lifecycle.terminalize(foreign, { kind: "rejected", reason: "aborted" })), "run_identity_mismatch");
});

// ── multi-candidate (shadow / tournament) compatibility ─────────────────────

test("lifecycle: MANY candidates are first-class — the spine never assumes one", () => {
  const { lifecycle, ids, runId } = walkTo("candidate_generation");
  const second = fakeCandidateId(String(candidateSeed += 1));
  const third = fakeCandidateId(String(candidateSeed += 1));
  lifecycle.record(runId, { kind: "candidate", id: second, workspaceId: ids.mint("workspace") });
  lifecycle.record(runId, { kind: "candidate", id: third, workspaceId: ids.mint("workspace") });
  lifecycle.enter(runId, "verification");
  // The SAME verification authority judges every candidate — no per-strategy verifier.
  for (const candidateId of lifecycle.ledger.candidates) {
    lifecycle.record(runId, { kind: "verification", id: fakeVerificationId(String(verificationSeed += 1)), candidateId });
  }
  assert.equal(lifecycle.ledger.candidates.length, 3);
  assert.equal(lifecycle.ledger.verifications.length, 3);
  lifecycle.enter(runId, "criticism");
  // The SAME critic authority judges every candidate — no per-strategy critic.
  for (const candidateId of lifecycle.ledger.candidates) {
    const v = lifecycle.ledger.entries.find((e) => e.kind === "verification" && e.candidateId === candidateId)!;
    lifecycle.record(runId, { kind: "critic", id: fakeCriticId(String(candidateSeed += 1)), candidateId, verificationId: (v as { id: V2VerificationId }).id });
  }
  assert.equal(lifecycle.ledger.critics.length, 3);
  lifecycle.enter(runId, "disposition");
  lifecycle.enter(runId, "promotion");
  assert.equal(lifecycle.stage, "promotion", "N candidates converge on ONE promotion stage");
});

// ── configuration precondition (V2-002) ─────────────────────────────────────

test("lifecycle: MODEL_RESOLUTION cannot be entered before configuration is recorded", () => {
  const { lifecycle, runId } = fresh();
  lifecycle.enter(runId, "preflight");
  // No configuration was established, so there is no policy a resolver could read.
  assert.equal(violation(() => lifecycle.enter(runId, "model_resolution")), "missing_required_evidence");
});

test("lifecycle: configuration is PREFLIGHT's to record and no one else's", () => {
  const { lifecycle, runId } = fresh();
  lifecycle.enter(runId, "preflight");
  lifecycle.record(runId, { kind: "configuration", policyId: POLICY });
  lifecycle.enter(runId, "model_resolution");
  assert.equal(
    violation(() => lifecycle.record(runId, { kind: "configuration", policyId: POLICY })),
    "stage_not_permitted_for_evidence",
    "no later stage may re-resolve configuration",
  );
});

test("lifecycle: a recorded configuration unlocks model_resolution", () => {
  const { lifecycle, runId } = fresh();
  lifecycle.enter(runId, "preflight");
  lifecycle.record(runId, { kind: "configuration", policyId: POLICY });
  lifecycle.enter(runId, "model_resolution");
  assert.equal(lifecycle.stage, "model_resolution");
  assert.deepEqual([...lifecycle.ledger.configurations], [POLICY]);
});

// ── resolution precondition + ordering correction (V2-003) ──────────────────

test("lifecycle: MODEL_RESOLUTION now precedes CONTEXT — context needs the model", () => {
  // The dependency is one-way: resolution needs only the policy, while context sizing is
  // computed from the resolved model's window. V2-001's placeholder order was backwards.
  assert.ok(stageIndex("model_resolution") < stageIndex("context"));
});

test("lifecycle: CONTEXT cannot be entered before a route is authorized", () => {
  const { lifecycle, runId } = fresh();
  lifecycle.enter(runId, "preflight");
  lifecycle.record(runId, { kind: "configuration", policyId: POLICY });
  lifecycle.enter(runId, "model_resolution");
  // The stage ran but authorized nothing — there is no model to size a context against.
  assert.equal(violation(() => lifecycle.enter(runId, "context")), "missing_required_evidence");
});

test("lifecycle: a resolution is MODEL_RESOLUTION's to record and no one else's", () => {
  const { lifecycle, runId } = fresh();
  lifecycle.enter(runId, "preflight");
  assert.equal(
    violation(() => lifecycle.record(runId, { kind: "resolution", decisionId: DECISION, role: "builder" })),
    "stage_not_permitted_for_evidence",
    "preflight may not authorize a route",
  );
});

test("lifecycle: a recorded resolution unlocks context and is counted", () => {
  const { lifecycle, runId } = fresh();
  lifecycle.enter(runId, "preflight");
  lifecycle.record(runId, { kind: "configuration", policyId: POLICY });
  lifecycle.record(runId, { kind: "snapshot", id: SNAPSHOT, clean: true });
  lifecycle.enter(runId, "model_resolution");
  lifecycle.record(runId, { kind: "resolution", decisionId: DECISION, role: "builder" });
  lifecycle.enter(runId, "context");
  assert.equal(lifecycle.stage, "context");
  assert.deepEqual([...lifecycle.ledger.resolutions], [DECISION]);
  lifecycle.terminalize(runId, { kind: "rejected", reason: "aborted" });
  const summary = summarizeEvidence(lifecycle.ledger, lifecycle.outcome!);
  assert.equal(summary.modelResolutionCompleted, true);
  assert.equal(summary.modelResolutions, 1);
  assert.equal(summary.providerInvoked, false, "authorizing a route is not invoking one");
  assert.equal(summary.invocations, 0);
});

test("lifecycle: the receipt counts configuration rather than assuming it", () => {
  const { lifecycle, runId } = fresh();
  lifecycle.enter(runId, "preflight");
  lifecycle.terminalize(runId, { kind: "rejected", reason: "no_work" });
  assert.equal(summarizeEvidence(lifecycle.ledger, lifecycle.outcome!).configurationResolved, false);
});

// ── context precondition + resolution ambiguity (V2-004) ────────────────────

test("lifecycle: INVOCATION cannot be entered before context is assembled (V2-004 rule)", () => {
  const { lifecycle, runId } = fresh();
  lifecycle.enter(runId, "preflight");
  lifecycle.record(runId, { kind: "configuration", policyId: POLICY });
  lifecycle.record(runId, { kind: "snapshot", id: SNAPSHOT, clean: true });
  lifecycle.enter(runId, "model_resolution");
  lifecycle.record(runId, { kind: "resolution", decisionId: DECISION, role: "builder" });
  lifecycle.enter(runId, "context");
  // The stage ran but assembled nothing — there is nothing to build a candidate from.
  assert.equal(violation(() => lifecycle.enter(runId, "candidate_strategy")), "missing_required_evidence");
});

test("lifecycle: a context package is CONTEXT's to record and no one else's", () => {
  const { lifecycle, runId } = fresh();
  lifecycle.enter(runId, "preflight");
  lifecycle.record(runId, { kind: "configuration", policyId: POLICY });
  lifecycle.enter(runId, "model_resolution");
  assert.equal(
    violation(() => lifecycle.record(runId, { kind: "context", packageId: CONTEXT, artifacts: 1 })),
    "stage_not_permitted_for_evidence",
    "model resolution may not assemble context",
  );
});

test("lifecycle: at most ONE resolution per role — ambiguity is refused, not resolved", () => {
  const { lifecycle, runId } = fresh();
  lifecycle.enter(runId, "preflight");
  lifecycle.record(runId, { kind: "configuration", policyId: POLICY });
  lifecycle.enter(runId, "model_resolution");
  lifecycle.record(runId, { kind: "resolution", decisionId: DECISION, role: "builder" });
  assert.equal(
    violation(() => lifecycle.record(runId, { kind: "resolution", decisionId: "3".repeat(64) as V2DecisionDigest, role: "builder" })),
    "duplicate_role_resolution",
    "a second builder route would make context binding ambiguous",
  );
  // A DIFFERENT role is still fine — this is not a one-resolution-per-run rule.
  lifecycle.record(runId, { kind: "resolution", decisionId: "4".repeat(64) as V2DecisionDigest, role: "critic" });
  assert.equal(lifecycle.ledger.resolutions.length, 2);
});

test("lifecycle: the receipt counts context assembly rather than assuming it", () => {
  const { lifecycle, runId } = fresh();
  lifecycle.enter(runId, "preflight");
  lifecycle.terminalize(runId, { kind: "rejected", reason: "no_work" });
  const summary = summarizeEvidence(lifecycle.ledger, lifecycle.outcome!);
  assert.equal(summary.contextAssemblyCompleted, false);
  assert.equal(summary.contextPackages, 0);
});

// ── invocation stage (V2-005) ───────────────────────────────────────────────

test("lifecycle: INVOCATION cannot be entered before context is assembled", () => {
  const { lifecycle, runId } = fresh();
  lifecycle.enter(runId, "preflight");
  lifecycle.record(runId, { kind: "configuration", policyId: POLICY });
  lifecycle.record(runId, { kind: "snapshot", id: SNAPSHOT, clean: true });
  lifecycle.enter(runId, "model_resolution");
  lifecycle.record(runId, { kind: "resolution", decisionId: DECISION, role: "builder" });
  lifecycle.enter(runId, "context");
  assert.equal(violation(() => lifecycle.enter(runId, "candidate_strategy")), "missing_required_evidence");
});

test("lifecycle: an invocation is CANDIDATE_GENERATION's to record and no one else's", () => {
  const { lifecycle, runId } = fresh();
  lifecycle.enter(runId, "preflight");
  lifecycle.record(runId, { kind: "configuration", policyId: POLICY });
  lifecycle.record(runId, { kind: "snapshot", id: SNAPSHOT, clean: true });
  lifecycle.enter(runId, "model_resolution");
  lifecycle.record(runId, { kind: "resolution", decisionId: DECISION, role: "builder" });
  lifecycle.enter(runId, "context");
  assert.equal(
    violation(() => lifecycle.record(runId, { kind: "invocation", id: INVOCATION, role: "builder" })),
    "stage_not_permitted_for_evidence",
    "context assembly may not invoke a model",
  );
});

test("lifecycle: CANDIDATE_GENERATION cannot be entered without a workspace to build in", () => {
  const { lifecycle, runId } = fresh();
  lifecycle.enter(runId, "preflight");
  lifecycle.record(runId, { kind: "configuration", policyId: POLICY });
  lifecycle.record(runId, { kind: "snapshot", id: SNAPSHOT, clean: true });
  lifecycle.enter(runId, "model_resolution");
  lifecycle.record(runId, { kind: "resolution", decisionId: DECISION, role: "builder" });
  lifecycle.enter(runId, "context");
  lifecycle.record(runId, { kind: "context", packageId: CONTEXT, artifacts: 3 });
  lifecycle.enter(runId, "candidate_strategy");
  assert.equal(violation(() => lifecycle.enter(runId, "candidate_generation")), "missing_required_evidence");
});

test("lifecycle: THE STANDALONE INVOCATION STAGE IS GONE (V2-007)", () => {
  // V2-005 introduced it to prove one authorized route could be called. With a real
  // builder that invokes N times, keeping it would mean paying for a qualification call
  // whose only finding the builder's first turn establishes anyway.
  assert.equal(
    (LIFECYCLE_STAGES as readonly string[]).includes("invocation"),
    false,
    "invocation is no longer a place a run can be — it is something candidate_generation does",
  );
  assert.deepEqual(
    [...LIFECYCLE_STAGES],
    ["preflight", "model_resolution", "context", "candidate_strategy", "candidate_generation", "verification", "criticism", "disposition", "promotion"],
  );
});

test("lifecycle: a recorded invocation is counted, and it is a real call", () => {
  const { lifecycle, runId } = walkTo("candidate_generation");
  assert.deepEqual([...lifecycle.ledger.invocations], [INVOCATION]);
  lifecycle.terminalize(runId, { kind: "rejected", reason: "aborted" });
  const summary = summarizeEvidence(lifecycle.ledger, lifecycle.outcome!);
  assert.equal(summary.providerInvoked, true, "for the first time in v2, this IS true");
  assert.equal(summary.invocations, 1);
  assert.equal(summary.candidatesCreated, 1, "and V2-007 means candidate_generation really produces one");
});

// ── workspace precondition (V2-006) ─────────────────────────────────────────

test("lifecycle: a workspace is CANDIDATE_STRATEGY's to record and no one else's", () => {
  const { lifecycle, runId } = walkTo("context");
  assert.equal(
    violation(() => lifecycle.record(runId, { kind: "workspace", id: WORKSPACE, baseTree: "t" })),
    "stage_not_permitted_for_evidence",
    "context assembly may not allocate a workspace",
  );
});

test("lifecycle: a MUTATION may only be recorded where a candidate is produced", () => {
  const { lifecycle, runId } = walkTo("context");
  lifecycle.enter(runId, "candidate_strategy");
  lifecycle.record(runId, { kind: "workspace", id: WORKSPACE, baseTree: "t" });
  // Observations are permitted here; writes are NOT.
  lifecycle.record(runId, { kind: "observation", id: "o".repeat(64) as never, workspaceId: WORKSPACE, path: "a.ts" });
  assert.equal(
    violation(() => lifecycle.record(runId, { kind: "mutation", id: "m".repeat(64) as never, workspaceId: WORKSPACE, path: "a.ts" })),
    "stage_not_permitted_for_evidence",
    "the strategy stage observes; it does not write",
  );
});

test("lifecycle: workspace/observation/mutation counts are counted, not assumed", () => {
  const { lifecycle, runId } = walkTo("context");
  lifecycle.enter(runId, "candidate_strategy");
  lifecycle.record(runId, { kind: "workspace", id: WORKSPACE, baseTree: "t" });
  lifecycle.record(runId, { kind: "observation", id: "o".repeat(64) as never, workspaceId: WORKSPACE, path: "a.ts" });
  lifecycle.terminalize(runId, { kind: "rejected", reason: "aborted" });
  const summary = summarizeEvidence(lifecycle.ledger, lifecycle.outcome!);
  assert.equal(summary.workspacesAllocated, 1);
  assert.equal(summary.observationsTaken, 1);
  assert.equal(summary.mutationsApplied, 0, "nothing was written");
  assert.equal(summary.sourceRepositoryMutated, false, "and the source repository is untouched");
});

// ── one source snapshot per run (V2-006A) ───────────────────────────────────

test("lifecycle: CONTEXT cannot be entered without the run's source snapshot", () => {
  const { lifecycle, runId } = fresh();
  lifecycle.enter(runId, "preflight");
  lifecycle.record(runId, { kind: "configuration", policyId: POLICY });
  lifecycle.enter(runId, "model_resolution");
  lifecycle.record(runId, { kind: "resolution", decisionId: DECISION, role: "builder" });
  // A model is resolved, but nothing has said what source state this run describes.
  assert.equal(violation(() => lifecycle.enter(runId, "context")), "missing_required_evidence");
});

test("lifecycle: at most ONE source snapshot — a second is refused, not preferred", () => {
  const { lifecycle, runId } = fresh();
  lifecycle.enter(runId, "preflight");
  lifecycle.record(runId, { kind: "snapshot", id: SNAPSHOT, clean: true });
  assert.equal(
    violation(() => lifecycle.record(runId, { kind: "snapshot", id: "6".repeat(64) as V2SnapshotDigest, clean: false })),
    "duplicate_source_snapshot",
    "two answers to 'what did this run start from' is no answer at all",
  );
});

test("lifecycle: a snapshot is PREFLIGHT's to capture — no later stage may recapture", () => {
  const { lifecycle, runId } = fresh();
  lifecycle.enter(runId, "preflight");
  lifecycle.record(runId, { kind: "configuration", policyId: POLICY });
  lifecycle.record(runId, { kind: "snapshot", id: SNAPSHOT, clean: true });
  lifecycle.enter(runId, "model_resolution");
  assert.equal(
    violation(() => lifecycle.record(runId, { kind: "snapshot", id: "7".repeat(64) as V2SnapshotDigest, clean: true })),
    "stage_not_permitted_for_evidence",
  );
});

test("lifecycle: the receipt counts the source snapshot rather than assuming it", () => {
  const { lifecycle, runId } = fresh();
  lifecycle.enter(runId, "preflight");
  lifecycle.terminalize(runId, { kind: "rejected", reason: "no_work" });
  const summary = summarizeEvidence(lifecycle.ledger, lifecycle.outcome!);
  assert.equal(summary.sourceSnapshotCaptured, false);
  assert.equal(summary.sourceSnapshots, 0);
});

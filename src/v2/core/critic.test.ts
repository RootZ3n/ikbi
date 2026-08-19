/**
 * THE CRITIC AUTHORITY — strict parsing, the material-defect contract, subject binding,
 * identity, and the v1 bare-FAIL defect closed HARD.
 *
 * Pure: the parser and identity primitives, plus `judgeCandidate` over fake seams. The
 * end-to-end proof — a real diff, the real invocation authority, the real boundary — is
 * `src/v2/cli/critic-truth.test.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFECT_CATEGORIES,
  criticDigest,
  criticSubjectOf,
  defectDigest,
  isMaterialSeverity,
  judgeCandidate,
  parseCriticResponse,
  validateCriticSubject,
  V2_CRITIC_FAILURE_CODES,
} from "./critic.js";
import type { CandidateRecord } from "./candidate.js";
import type { VerificationRecord, RunVerificationSummary } from "./verification.js";
import type { CandidateDiff, CandidateDiffSource } from "./candidate-diff.js";
import type { InvocationTransport, TransportOutcome } from "./invocation.js";
import type { ModelResolutionDecision } from "./resolver.js";
import type { UntrustedBoundary } from "./builder.js";
import type { InvocationAdmission } from "./cost.js";
import type { V2CandidateId, V2InvocationId, V2RunId, V2SnapshotDigest, V2TaskId, V2VerificationId } from "./identity.js";

const RUN = "run_c" as V2RunId;
const TASK = "task_c" as V2TaskId;
const TREE = "a".repeat(40);
const SNAP = ("snap" + "0".repeat(60)) as V2SnapshotDigest;

const candidate = {
  candidateId: "cand".repeat(16) as V2CandidateId,
  runId: RUN,
  sourceSnapshotId: SNAP,
  workspaceId: "ws_1",
  builderDecisionId: "bdec",
  invocationIds: [],
  mutationIds: [],
  changedPaths: ["src/a.ts"],
  tree: { treeId: TREE, baseTreeId: "b".repeat(40), startTree: "s".repeat(40), materializedStateDigest: "m".repeat(64), changed: true },
  completion: "finished",
  claim: { summary: "changed src/a.ts", believesComplete: true },
  metadata: { turns: 3, toolCalls: 3, toolFailures: 0, startedAt: 0, endedAt: 1 },
} as unknown as CandidateRecord;

const verification = {
  verificationId: "v".repeat(64) as V2VerificationId,
  runId: RUN,
  candidateId: candidate.candidateId,
  candidateTreeId: TREE,
  planId: "p".repeat(64),
  treeBeforeChecks: TREE,
  treeAfterChecks: TREE,
  checks: [],
  verdict: "pass",
  workspaceDisposition: "retained",
  startedAt: 0,
  endedAt: 1,
} as unknown as VerificationRecord;

const verificationSummary: RunVerificationSummary = {
  verificationId: verification.verificationId,
  runId: RUN,
  candidateId: candidate.candidateId,
  candidateTreeId: TREE,
  planId: "p".repeat(64),
  verdict: "pass",
  treeBeforeChecks: TREE,
  treeAfterChecks: TREE,
  treeUnchanged: true,
  workspaceDisposition: "retained",
  checks: [{ name: "test", command: "t", status: "pass", exitCode: 0, durationMs: 5, outputSha256: "h", outputExcerpt: "ok" }],
};

const decision = { decisionId: "cdec".repeat(16), runId: RUN, role: "critic", modelId: "m", providerId: "p", providerModelId: "mw" } as unknown as ModelResolutionDecision;
const boundary: UntrustedBoundary = { wrap: ({ content }) => `<<U>>\n${content}\n<<E>>` };
const emptyDiff: CandidateDiff = { diffId: "d".repeat(64) as never, candidateId: candidate.candidateId, sourceSnapshotId: SNAP, fromTree: "s".repeat(40), toTree: TREE, files: [], empty: true, truncated: false };
const diffSource: CandidateDiffSource = { diff: async () => emptyDiff };

/** A transport that returns a fixed critic content. */
function critic(content: string, over: { fail?: boolean } = {}) {
  const sent: { messages: readonly { role: string; content: string }[]; hadTools: boolean }[] = [];
  const transport: InvocationTransport = {
    async send(input): Promise<TransportOutcome> {
      sent.push({ messages: input.messages.map((m) => ({ role: m.role, content: m.content })), hadTools: (input.tools ?? []).length > 0 });
      if (over.fail === true) return { ok: false, failure: { code: "invocation.transport_failure", message: "down", providerId: "p", attempts: 1 } };
      return { ok: true, response: { content, finishReason: "stop", servedModelId: "mw", attempts: 1 } };
    },
  };
  return { transport, sent };
}

let idSeq = 0;
function judge(content: string, over: { trees?: string[]; decisionRole?: string; fail?: boolean; admission?: InvocationAdmission } = {}) {
  const t = critic(content, { ...(over.fail !== undefined ? { fail: over.fail } : {}) });
  const trees = over.trees ?? [TREE];
  let call = 0;
  // V2-019/HIGH-02: the CALLER mints the critic's InvocationId, so a test can assert the exact
  // identity that reached the wire even when the call fails and returns no record.
  const invocationId = `inv_${(idSeq += 1)}` as V2InvocationId;
  return {
    sent: t.sent,
    invocationId,
    result: judgeCandidate({
      runId: RUN,
      taskId: TASK,
      goal: "make src/a.ts correct",
      candidate,
      verification,
      verificationSummary,
      workspacePath: "/ws",
      decision: over.decisionRole !== undefined ? ({ ...decision, role: over.decisionRole } as ModelResolutionDecision) : decision,
      transport: t.transport,
      boundary,
      diffSource,
      diffBudget: { maxFilesWithHunks: 40, maxHunkChars: 4000 },
      probeTree: async () => trees[Math.min(call++, trees.length - 1)]!,
      invocationId,
      ...(over.admission !== undefined ? { admission: over.admission } : {}),
      maxOutputTokens: 2048,
      timeoutMs: 1000,
      now: () => 100,
    }),
  };
}

const SATISFIED = JSON.stringify({ verdict: "satisfied", summary: "looks correct", defects: [] });
const DEFECT = JSON.stringify({ verdict: "defects_found", summary: "a real problem", defects: [{ category: "wrong_behavior", severity: "major", description: "add() subtracts instead of adding", paths: ["src/a.ts"] }] });

// ── the strict parser ─────────────────────────────────────────────────────────

test("parse: a well-formed SATISFIED judgment is accepted", () => {
  const r = parseCriticResponse(SATISFIED);
  assert.ok(r.ok);
  assert.equal(r.verdict, "satisfied");
  assert.equal(r.defects.length, 0);
});

test("parse: a well-formed DEFECTS_FOUND with a concrete material defect is accepted", () => {
  const r = parseCriticResponse(DEFECT);
  assert.ok(r.ok);
  assert.equal(r.verdict, "defects_found");
  assert.equal(r.defects[0]?.category, "wrong_behavior");
  assert.equal(r.defects[0]?.severity, "major");
});

// ── THE v1 DEFECT, CLOSED HARD ────────────────────────────────────────────────

test("BARE FAIL: defects_found with an EMPTY defect list is a HARD protocol failure", () => {
  const r = parseCriticResponse(JSON.stringify({ verdict: "defects_found", summary: "bad", defects: [] }));
  assert.ok(!r.ok, "not downgraded to a verdict — rejected");
  assert.equal(r.problem, "defects_found_without_material_defect");
});

test("BARE FAIL: plain text 'FAIL' is a protocol failure, not coerced", () => {
  const r = parseCriticResponse("FAIL");
  assert.ok(!r.ok);
  assert.equal(r.problem, "not_json");
});

test("BARE FAIL: defects_found with only an ADVISORY defect is rejected (no material defect)", () => {
  const r = parseCriticResponse(JSON.stringify({ verdict: "defects_found", summary: "x", defects: [{ category: "wrong_behavior", severity: "advisory", description: "a nitpick that is long enough" }] }));
  assert.ok(!r.ok);
  assert.equal(r.problem, "defects_found_without_material_defect");
});

// ── contradiction / malformed ─────────────────────────────────────────────────

test("contradiction: SATISFIED with a material defect present is rejected", () => {
  const r = parseCriticResponse(JSON.stringify({ verdict: "satisfied", summary: "ok", defects: [{ category: "wrong_behavior", severity: "blocking", description: "this is a real blocking problem" }] }));
  assert.ok(!r.ok);
  assert.equal(r.problem, "satisfied_with_material_defect");
});

test("malformed: a vague, too-short description is rejected", () => {
  const r = parseCriticResponse(JSON.stringify({ verdict: "defects_found", summary: "x", defects: [{ category: "wrong_behavior", severity: "major", description: "bad" }] }));
  assert.ok(!r.ok);
  assert.equal(r.problem, "empty_description");
});

test("malformed: an unknown category is rejected", () => {
  const r = parseCriticResponse(JSON.stringify({ verdict: "defects_found", summary: "x", defects: [{ category: "vibes", severity: "major", description: "long enough description here" }] }));
  assert.ok(!r.ok);
  assert.equal(r.problem, "unknown_category");
});

test("malformed: an unknown severity is rejected", () => {
  const r = parseCriticResponse(JSON.stringify({ verdict: "defects_found", summary: "x", defects: [{ category: "wrong_behavior", severity: "catastrophic", description: "long enough description here" }] }));
  assert.ok(!r.ok);
  assert.equal(r.problem, "unknown_severity");
});

test("malformed: an unknown verdict token is rejected", () => {
  const r = parseCriticResponse(JSON.stringify({ verdict: "pass", summary: "x", defects: [] }));
  assert.ok(!r.ok);
  assert.equal(r.problem, "unknown_verdict");
});

test("malformed: a missing summary is rejected", () => {
  const r = parseCriticResponse(JSON.stringify({ verdict: "satisfied", defects: [] }));
  assert.ok(!r.ok);
  assert.equal(r.problem, "missing_summary");
});

test("malformed: markdown-fenced JSON is NOT accepted (no fence stripping)", () => {
  const r = parseCriticResponse("```json\n" + SATISFIED + "\n```");
  assert.ok(!r.ok);
  assert.equal(r.problem, "not_json");
});

test("malformed: leading prose before the JSON is rejected", () => {
  const r = parseCriticResponse("Here is my judgment: " + SATISFIED);
  assert.ok(!r.ok);
});

// ── indeterminate ─────────────────────────────────────────────────────────────

test("indeterminate: allowed with an empty defect list, and is NOT satisfied", () => {
  const r = parseCriticResponse(JSON.stringify({ verdict: "indeterminate", summary: "not enough evidence", defects: [] }));
  assert.ok(r.ok);
  assert.equal(r.verdict, "indeterminate");
});

// ── defect identity + dedup ───────────────────────────────────────────────────

test("defect identity: the same defect content yields the same id; dedup collapses repeats", () => {
  const one = defectDigest({ category: "wrong_behavior", severity: "major", description: "the same defect", paths: ["a"] });
  const two = defectDigest({ category: "wrong_behavior", severity: "major", description: "the same defect", paths: ["a"] });
  assert.equal(one, two);
  const dupJson = JSON.stringify({
    verdict: "defects_found",
    summary: "x",
    defects: [
      { category: "wrong_behavior", severity: "major", description: "duplicated defect description", paths: ["a"] },
      { category: "wrong_behavior", severity: "major", description: "duplicated defect description", paths: ["a"] },
    ],
  });
  const r = parseCriticResponse(dupJson);
  assert.ok(r.ok);
  assert.equal(r.defects.length, 1, "identical defects are one defect");
});

test("severity: only minor/major/blocking are material", () => {
  assert.equal(isMaterialSeverity("advisory"), false);
  for (const s of ["minor", "major", "blocking"] as const) assert.equal(isMaterialSeverity(s), true);
});

test("taxonomy: the category set is small and closed", () => {
  assert.equal(DEFECT_CATEGORIES.length, 8);
});

// ── subject binding ────────────────────────────────────────────────────────────

test("subject: derived from candidate + verification, bound to run and task", () => {
  const s = criticSubjectOf(candidate, verification, TASK);
  assert.equal(s.candidateId, candidate.candidateId);
  assert.equal(s.candidateTreeId, TREE);
  assert.equal(s.verificationId, verification.verificationId);
  assert.equal(s.taskId, TASK);
});

test("subject: a verification of a DIFFERENT candidate is refused", () => {
  const foreignVerification = { ...verification, candidateId: "other".repeat(12) } as VerificationRecord;
  const fail = validateCriticSubject({ subject: criticSubjectOf(candidate, foreignVerification, TASK), candidate, verification: foreignVerification, runId: RUN, taskId: TASK });
  assert.ok(fail !== undefined);
  assert.equal(fail.code, V2_CRITIC_FAILURE_CODES.subjectMismatch);
});

// ── critic identity ────────────────────────────────────────────────────────────

test("critic identity: same evidence + verdict + defects → same id; invocation is provenance", () => {
  const base = { candidateId: candidate.candidateId, candidateTreeId: TREE, verificationId: verification.verificationId, reviewPackageId: "r".repeat(64) as never, criticDecisionId: decision.decisionId, verdict: "satisfied" as const, defects: [] };
  assert.equal(criticDigest(base), criticDigest(base));
});

test("critic identity: a different candidate tree → a different critic id", () => {
  const a = criticDigest({ candidateId: candidate.candidateId, candidateTreeId: TREE, verificationId: verification.verificationId, reviewPackageId: "r".repeat(64) as never, criticDecisionId: decision.decisionId, verdict: "satisfied", defects: [] });
  const b = criticDigest({ candidateId: candidate.candidateId, candidateTreeId: "z".repeat(40), verificationId: verification.verificationId, reviewPackageId: "r".repeat(64) as never, criticDecisionId: decision.decisionId, verdict: "satisfied", defects: [] });
  assert.notEqual(a, b);
});

// ── judgeCandidate orchestration ────────────────────────────────────────────────

test("judge: a SATISFIED response produces a bound record and one invocation", async () => {
  const { result, sent } = judge(SATISFIED);
  const r = await result;
  assert.ok(r.ok, r.ok ? "" : r.failure.message);
  assert.equal(r.generation.record.verdict, "satisfied");
  assert.equal(r.generation.record.candidateId, candidate.candidateId);
  assert.equal(r.generation.record.candidateTreeId, TREE);
  assert.equal(r.generation.record.verificationId, verification.verificationId);
  assert.equal(sent.length, 1, "exactly one critic call");
  assert.equal(sent[0]?.hadTools, false, "the critic holds NO tools");
});

test("judge: a DEFECTS_FOUND response records the concrete defect", async () => {
  const { result } = judge(DEFECT);
  const r = await result;
  assert.ok(r.ok);
  assert.equal(r.generation.record.verdict, "defects_found");
  assert.equal(r.generation.record.defects.length, 1);
  assert.equal(r.generation.record.defects[0]?.paths[0], "src/a.ts");
});

test("judge: a bare defects_found ENDS THE RUN — protocol failure, no record", async () => {
  const { result } = judge(JSON.stringify({ verdict: "defects_found", summary: "bad", defects: [] }));
  const r = await result;
  assert.ok(!r.ok);
  assert.equal(r.failure.code, V2_CRITIC_FAILURE_CODES.protocolFailure);
  assert.equal(r.attemptedInvocation, true, "the model WAS invoked; its answer was unusable");
});

test("judge: SUBJECT DRIFT — a workspace that moved after verification runs NO model call", async () => {
  const { result, sent } = judge(SATISFIED, { trees: ["deadbeef"] });
  const r = await result;
  assert.ok(!r.ok);
  assert.equal(r.failure.code, V2_CRITIC_FAILURE_CODES.subjectDrift);
  assert.equal(r.attemptedInvocation, false);
  assert.deepEqual(sent, [], "the critic was never invoked on a stale tree");
});

test("judge: a NON-CRITIC decision is refused before any call", async () => {
  const { result, sent } = judge(SATISFIED, { decisionRole: "builder" });
  const r = await result;
  assert.ok(!r.ok);
  assert.deepEqual(sent, [], "a builder route cannot be consumed by the critic");
});

test("judge: a transport failure ends the run with no record and no retry", async () => {
  const { result } = judge(SATISFIED, { fail: true });
  const r = await result;
  assert.ok(!r.ok);
  assert.equal(r.attemptedInvocation, true);
});

// ── V2-016A/M1 cross-audit: a malformed critic response still accounts the call ──

test("V2-016A/M1: a malformed critic response RETAINS the successful invocation for accounting", async () => {
  const { result } = judge("this is not a JSON judgment at all");
  const r = await result;
  assert.equal(r.ok, false, "a malformed judgment is NEVER a valid verdict");
  if (!r.ok) {
    assert.equal(r.attemptedInvocation, true);
    assert.ok(r.invocation !== undefined, "the successful wire call is retained for the invocation ledger / cost");
    assert.equal(r.invocation!.identity.requestedRole, "critic");
    assert.ok(r.invocation!.usage !== undefined || r.invocation!.responseCharacters >= 0, "the record carries the real invocation facts");
  }
});

test("V2-016A/M1: a critic WIRE failure carries no invocation record (nothing completed)", async () => {
  const { result } = judge("{}", { fail: true });
  const r = await result;
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.invocation, undefined, "a failed wire call produced no record to account");
});

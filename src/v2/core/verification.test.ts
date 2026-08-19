/**
 * THE VERIFICATION AUTHORITY — subject binding, plan/verification identity, the two tree
 * rechecks, verdict aggregation, and the failure vocabulary.
 *
 * Pure: fake `ChecksSource`, `CheckRunner` and `TreeProbe` stand in for discovery, governed
 * execution and git. The end-to-end proof — a real worktree, real `pnpm test`, real
 * governed-exec — is `src/v2/cli/verification-truth.test.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aggregateCheckVerdict,
  buildVerificationPlan,
  classifyExecution,
  isConclusive,
  summarizeVerification,
  V2_VERIFICATION_FAILURE_CODES,
  verificationPlanDigest,
  verificationSubjectOf,
  verifyCandidate,
  type CheckExecution,
  type CheckRecord,
  type CheckRunner,
  type ChecksSource,
  type ResolvedChecks,
  type TreeProbe,
} from "./verification.js";
import type { CandidateRecord } from "./candidate.js";
import type { V2CandidateId, V2RunId } from "./identity.js";

const RUN = "run_v" as V2RunId;
const TREE = "a".repeat(40);

/** A candidate whose tree is `TREE`, on run RUN. */
const candidate = {
  candidateId: "cand".repeat(16) as V2CandidateId,
  runId: RUN,
  sourceSnapshotId: "snap" + "0".repeat(60),
  workspaceId: "ws_1",
  builderDecisionId: "dec",
  invocationIds: [],
  mutationIds: [],
  changedPaths: [],
  tree: { treeId: TREE, baseTreeId: "b".repeat(40), materializedStateDigest: "m".repeat(64), changed: true },
  completion: "finished",
  claim: { summary: "did it", believesComplete: true },
  metadata: { turns: 1, toolCalls: 1, toolFailures: 0, startedAt: 0, endedAt: 1 },
} as unknown as CandidateRecord;

const oneCheck: ResolvedChecks = { ok: true, source: "default", checks: [{ name: "test", command: "faketest", args: ["run"] }] };
const passExec: CheckExecution = { launched: true, exitCode: 0, timedOut: false, durationMs: 5, outputSha256: "h", outputExcerpt: "ok" };

/** Build the verify input with overridable seams; the tree probe defaults to no drift. */
function verify(over: {
  checks?: ResolvedChecks;
  exec?: (name: string) => CheckExecution;
  trees?: string[]; // successive treeOf() answers; default: TREE, TREE
} = {}) {
  const trees = over.trees ?? [TREE, TREE];
  let treeCall = 0;
  const tree: TreeProbe = { treeOf: async () => trees[Math.min(treeCall++, trees.length - 1)]! };
  const checksSource: ChecksSource = { resolve: async () => over.checks ?? oneCheck };
  const ran: string[] = [];
  const runner: CheckRunner = {
    run: async (input) => {
      ran.push(input.name);
      return (over.exec ?? (() => passExec))(input.name);
    },
  };
  return {
    ran,
    result: verifyCandidate({
      runId: RUN,
      subject: verificationSubjectOf(candidate),
      candidate,
      workspacePath: "/ws",
      checksSource,
      runner,
      tree,
      checkTimeoutMs: 1000,
      now: () => 100,
    }),
  };
}

// ── subject binding ──────────────────────────────────────────────────────────

test("subject: it is derived from the candidate and names its exact tree", () => {
  const s = verificationSubjectOf(candidate);
  assert.equal(s.candidateId, candidate.candidateId);
  assert.equal(s.candidateTreeId, TREE);
  assert.equal(s.workspaceId, candidate.workspaceId);
  assert.equal(s.runId, RUN);
});

test("subject: a candidate from ANOTHER run is refused before any I/O", async () => {
  const foreign = { ...candidate, runId: "run_other" as V2RunId } as CandidateRecord;
  const { result, ran } = { ...verify(), result: verifyCandidate({
    runId: RUN, subject: verificationSubjectOf(foreign), candidate: foreign, workspacePath: "/ws",
    checksSource: { resolve: async () => oneCheck }, runner: { run: async () => passExec }, tree: { treeOf: async () => TREE },
    checkTimeoutMs: 1000, now: () => 1,
  }) };
  const r = await result;
  assert.ok(!r.ok);
  assert.equal(r.failure.code, V2_VERIFICATION_FAILURE_CODES.subjectMismatch);
  assert.deepEqual(ran, [], "nothing ran");
});

// ── candidate drift (the hostile guard) ──────────────────────────────────────

test("DRIFT: a workspace tree that no longer matches the candidate runs NO checks", async () => {
  const { result, ran } = verify({ trees: ["deadbeef", "deadbeef"] }); // before != TREE
  const r = await result;
  assert.ok(r.ok);
  assert.equal(r.record.verdict, "candidate_drift");
  assert.deepEqual(ran, [], "checks are never executed against a drifted workspace");
  assert.equal(r.record.checks.length, 0);
  assert.equal(r.record.treeBeforeChecks, "deadbeef");
  assert.equal(r.record.candidateTreeId, TREE, "the record still names the candidate's true tree");
});

// ── check-mutation (the other hostile guard) ─────────────────────────────────

test("MUTATION: a check that changes the tree invalidates the verification, whatever the exit codes", async () => {
  // before == TREE (no drift), checks run and PASS, but after != before.
  const { result } = verify({ trees: [TREE, "mutated!"], exec: () => passExec });
  const r = await result;
  assert.ok(r.ok);
  assert.equal(r.record.verdict, "workspace_mutated_by_checks");
  assert.equal(r.record.treeBeforeChecks, TREE);
  assert.equal(r.record.treeAfterChecks, "mutated!");
  assert.equal(r.record.checks[0]?.status, "pass", "the check itself passed — the verdict is about the tree, not the exit code");
});

// ── verdicts ─────────────────────────────────────────────────────────────────

test("PASS: all checks exit 0 and the tree is intact", async () => {
  const { result, ran } = verify();
  const r = await result;
  assert.ok(r.ok);
  assert.equal(r.record.verdict, "pass");
  assert.deepEqual(ran, ["test"]);
  assert.equal(r.record.checks[0]?.status, "pass");
  assert.equal(r.record.checks[0]?.exitCode, 0);
});

test("FAIL: a non-zero exit is a fail, and the record shows it", async () => {
  const { result } = verify({ exec: () => ({ ...passExec, exitCode: 1 }) });
  const r = await result;
  assert.ok(r.ok);
  assert.equal(r.record.verdict, "fail");
  assert.equal(r.record.checks[0]?.status, "fail");
  assert.equal(r.record.checks[0]?.exitCode, 1);
});

test("NO_CHECKS: an unresolvable check set is truthful, and is NOT a pass", async () => {
  const { result, ran } = verify({ checks: { ok: false, reason: "no manifest" } });
  const r = await result;
  assert.ok(r.ok);
  assert.equal(r.record.verdict, "no_checks");
  assert.deepEqual(ran, []);
  assert.notEqual(r.record.verdict, "pass");
});

test("TIMEOUT: a check that times out is not an ordinary fail", async () => {
  const { result } = verify({ exec: () => ({ ...passExec, exitCode: 124, timedOut: true }) });
  const r = await result;
  assert.ok(r.ok);
  assert.equal(r.record.verdict, "timeout");
  assert.equal(r.record.checks[0]?.status, "timeout");
});

test("INFRASTRUCTURE: a check that never launched is not a candidate fail", async () => {
  const { result } = verify({ exec: () => ({ launched: false, timedOut: false, durationMs: 1, outputSha256: "h", outputExcerpt: "", refusedReason: "denied: not allowlisted" }) });
  const r = await result;
  assert.ok(r.ok);
  assert.equal(r.record.verdict, "infrastructure_failure");
  assert.equal(r.record.checks[0]?.status, "infrastructure_failure");
  assert.equal(r.record.checks[0]?.exitCode, undefined);
});

// ── run-all + aggregation ─────────────────────────────────────────────────────

test("RUN-ALL: every selected check runs, and the record shows the full defect set", async () => {
  const twoChecks: ResolvedChecks = { ok: true, source: "default", checks: [{ name: "typecheck", command: "tsc", args: [] }, { name: "test", command: "t", args: [] }] };
  const { result, ran } = verify({ checks: twoChecks, exec: (name) => (name === "typecheck" ? { ...passExec, exitCode: 2 } : passExec) });
  const r = await result;
  assert.ok(r.ok);
  assert.deepEqual(ran, ["typecheck", "test"], "the second check ran even though the first failed");
  assert.equal(r.record.verdict, "fail");
  assert.equal(r.record.checks.length, 2);
});

test("aggregate: precedence is infrastructure > timeout > fail > pass", () => {
  const rec = (status: CheckRecord["status"]): CheckRecord => ({ name: "c", command: "c", status, durationMs: 1, outputSha256: "h", outputExcerpt: "" });
  assert.equal(aggregateCheckVerdict([]), "no_checks");
  assert.equal(aggregateCheckVerdict([rec("pass"), rec("pass")]), "pass");
  assert.equal(aggregateCheckVerdict([rec("pass"), rec("fail")]), "fail");
  assert.equal(aggregateCheckVerdict([rec("fail"), rec("timeout")]), "timeout");
  assert.equal(aggregateCheckVerdict([rec("timeout"), rec("infrastructure_failure")]), "infrastructure_failure");
});

test("classify: launched+exit0 pass; launched+nonzero fail; timed out; not launched infra", () => {
  assert.equal(classifyExecution({ launched: true, exitCode: 0, timedOut: false, durationMs: 1, outputSha256: "", outputExcerpt: "" }), "pass");
  assert.equal(classifyExecution({ launched: true, exitCode: 3, timedOut: false, durationMs: 1, outputSha256: "", outputExcerpt: "" }), "fail");
  assert.equal(classifyExecution({ launched: true, exitCode: 124, timedOut: true, durationMs: 1, outputSha256: "", outputExcerpt: "" }), "timeout");
  assert.equal(classifyExecution({ launched: false, timedOut: false, durationMs: 1, outputSha256: "", outputExcerpt: "" }), "infrastructure_failure");
});

test("isConclusive: only pass and fail are conclusive", () => {
  for (const v of ["pass", "fail"] as const) assert.equal(isConclusive(v), true);
  for (const v of ["no_checks", "timeout", "infrastructure_failure", "candidate_drift", "workspace_mutated_by_checks"] as const) assert.equal(isConclusive(v), false);
});

// ── identity ──────────────────────────────────────────────────────────────────

test("identity: the same candidate tree + plan + verdicts yield the same verification id", async () => {
  const a = await verify().result;
  const b = await verify().result;
  assert.ok(a.ok && b.ok);
  assert.equal(a.record.verificationId, b.record.verificationId);
});

test("identity: a DIFFERENT candidate tree yields a different verification id, same checks", async () => {
  const other = { ...candidate, tree: { ...candidate.tree, treeId: "z".repeat(40) } } as CandidateRecord;
  const a = await verify().result;
  const b = await verifyCandidate({
    runId: RUN, subject: verificationSubjectOf(other), candidate: other, workspacePath: "/ws",
    checksSource: { resolve: async () => oneCheck }, runner: { run: async () => passExec },
    tree: { treeOf: async () => "z".repeat(40) }, checkTimeoutMs: 1000, now: () => 100,
  });
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.record.verificationId, b.record.verificationId, "identity is bound to the tree, not just the checks");
});

test("identity: durations and output do NOT affect the verification id", async () => {
  const a = await verify({ exec: () => ({ ...passExec, durationMs: 5, outputSha256: "one", outputExcerpt: "A" }) }).result;
  const b = await verify({ exec: () => ({ ...passExec, durationMs: 9999, outputSha256: "two", outputExcerpt: "B" }) }).result;
  assert.ok(a.ok && b.ok);
  assert.equal(a.record.verificationId, b.record.verificationId, "identity is what was verified + how it turned out, not run noise");
});

test("plan identity: order and command matter; a relocated path does not", () => {
  const p1 = verificationPlanDigest({ checks: [{ name: "a", command: "x", args: ["1"], timeoutMs: 5 }], cwdPolicy: "candidate_workspace_root", source: "default" });
  const p2 = verificationPlanDigest({ checks: [{ name: "a", command: "x", args: ["1"], timeoutMs: 5 }], cwdPolicy: "candidate_workspace_root", source: "default" });
  const p3 = verificationPlanDigest({ checks: [{ name: "a", command: "x", args: ["2"], timeoutMs: 5 }], cwdPolicy: "candidate_workspace_root", source: "default" });
  assert.equal(p1, p2, "the plan has no path or clock in it");
  assert.notEqual(p1, p3, "a different command is a different plan");
});

test("plan: buildVerificationPlan preserves discovery order and stamps the timeout", () => {
  const plan = buildVerificationPlan({ checks: [{ name: "typecheck", command: "tsc", args: ["--noEmit"] }, { name: "test", command: "t", args: [] }], timeoutMs: 42, source: "env" });
  assert.deepEqual(plan.checks.map((c) => c.name), ["typecheck", "test"]);
  assert.equal(plan.checks[0]?.timeoutMs, 42);
  assert.equal(plan.source, "env");
});

// ── receipt ────────────────────────────────────────────────────────────────────

test("receipt: the summary carries verdict, tree ids and per-check status — no raw log dump", async () => {
  const { result } = verify({ exec: () => ({ ...passExec, outputExcerpt: "some bounded tail" }) });
  const r = await result;
  assert.ok(r.ok);
  const s = summarizeVerification(r.record);
  assert.equal(s.verdict, "pass");
  assert.equal(s.treeUnchanged, true);
  assert.equal(s.checks[0]?.status, "pass");
  assert.equal(s.checks[0]?.exitCode, 0);
  assert.equal(s.workspaceDisposition, "retained");
  assert.ok(s.checks[0]!.outputExcerpt.length <= 1500);
});

// ── V2-016A/B4 cross-audit: candidate cannot silently redefine its own exam ────

const defProbe = (files: Record<string, string | null>) => ({ capture: async () => ({ files }) });

test("V2-016A/B4: a candidate that changed a verification-DEFINITION file → verification_policy_changed", async () => {
  // A manifest-derived exam ("default"), source package.json = hashA, candidate package.json = hashB.
  const out = await verifyCandidate({
    runId: RUN,
    subject: verificationSubjectOf(candidate),
    candidate,
    workspacePath: "/ws",
    checksSource: { resolve: async () => oneCheck },
    runner: { run: async () => passExec },
    tree: { treeOf: async () => TREE },
    checkTimeoutMs: 1000,
    sourceDefinition: { files: { "package.json": "hashA" } },
    definitionProbe: defProbe({ "package.json": "hashB" }),
    now: () => 100,
  });
  assert.ok(out.ok);
  assert.equal(out.record.verdict, "verification_policy_changed", "the rewritten exam is NEVER a normal PASS");
  assert.equal(out.record.checks.length, 0, "no candidate-defined check ran");
});

test("V2-016A/B4: an UNCHANGED verification definition verifies normally (PASS)", async () => {
  const out = await verifyCandidate({
    runId: RUN,
    subject: verificationSubjectOf(candidate),
    candidate,
    workspacePath: "/ws",
    checksSource: { resolve: async () => oneCheck },
    runner: { run: async () => passExec },
    tree: { treeOf: async () => TREE },
    checkTimeoutMs: 1000,
    sourceDefinition: { files: { "package.json": "hashA" } },
    definitionProbe: defProbe({ "package.json": "hashA" }),
    now: () => 100,
  });
  assert.ok(out.ok);
  assert.equal(out.record.verdict, "pass", "an ordinary source change with the same exam verifies normally");
});

test("V2-016A/B4: OPERATOR IKBI_CHECKS (source=env) is trusted policy — the guard does not apply", async () => {
  const envChecks: ResolvedChecks = { ok: true, source: "env", checks: [{ name: "test", command: "faketest", args: ["run"] }] };
  const out = await verifyCandidate({
    runId: RUN,
    subject: verificationSubjectOf(candidate),
    candidate,
    workspacePath: "/ws",
    checksSource: { resolve: async () => envChecks },
    runner: { run: async () => passExec },
    tree: { treeOf: async () => TREE },
    checkTimeoutMs: 1000,
    // Even with a "changed" definition, operator env checks are trusted and run normally.
    sourceDefinition: { files: { "package.json": "hashA" } },
    definitionProbe: defProbe({ "package.json": "hashB" }),
    now: () => 100,
  });
  assert.ok(out.ok);
  assert.equal(out.record.verdict, "pass", "operator policy overrides manifest discovery and is not exam-tampering");
});

/**
 * runSelfHeal — the executor-driven loop. These pin the SEQUENCING and the fail-closed wiring: the
 * non-harness short-circuit never spends a build, the correctness+authority gates feed the pure
 * policy, Opus advice runs ONLY when the verdict asks for it, and every path writes exactly one receipt.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { FailureClassification } from "../self-monitor/classify.js";
import { runSelfHeal } from "./driver.js";
import type { CandidateFix, JudgeResult, SelfHealExecutors, SelfHealFailure, SelfHealResult, SuiteResult } from "./contract.js";

const harnessCls: FailureClassification = {
  category: "harness", harnessSuspect: true, selfHealable: false, signal: "checks_unresolvable",
  evidence: "no verification contract", suggestedAction: "add a manifest",
};
const modelCls: FailureClassification = {
  category: "model", harnessSuspect: false, selfHealable: false, signal: "failure", evidence: "the model wrote something wrong",
};

const failure = (cls: FailureClassification): SelfHealFailure => ({
  taskId: "t-heal-1", classification: cls, targetRepo: "/repos/ikbi", reason: "checks unresolvable",
});

/** A recording fake executor set — every call is logged so we can assert the sequence. */
function fakeExecutors(over: Partial<{
  candidate: CandidateFix; suite: SuiteResult; judge: JudgeResult; advice: string;
}> = {}): { ex: SelfHealExecutors; calls: string[]; receipts: SelfHealResult[] } {
  const calls: string[] = [];
  const receipts: SelfHealResult[] = [];
  const candidate: CandidateFix = over.candidate ?? { produced: true, changedFiles: ["src/modules/chat/session.ts"], linesChanged: 12, branch: "ikbi/self-heal/t-heal-1" };
  const suite: SuiteResult = over.suite ?? { green: true, testCount: 3032 };
  const judge: JudgeResult = over.judge ?? { pass: true };
  const ex: SelfHealExecutors = {
    generateFix: async () => { calls.push("generateFix"); return candidate; },
    runSuite: async () => { calls.push("runSuite"); return suite; },
    runJudge: async () => { calls.push("runJudge"); return judge; },
    opusAdvise: async () => { calls.push("opusAdvise"); return over.advice ?? "Opus: proceed with caution."; },
    receipt: async (r) => { calls.push("receipt"); receipts.push(r); },
  };
  return { ex, calls, receipts };
}

test("non-harness failure short-circuits: no build, one receipt, rejected", async () => {
  const { ex, calls, receipts } = fakeExecutors();
  const res = await runSelfHeal({ failure: failure(modelCls) }, ex);
  assert.equal(res.verdict.disposition, "rejected");
  assert.deepEqual(calls, ["receipt"], "generateFix must NOT run for a non-harness failure");
  assert.equal(receipts.length, 1);
  assert.equal(res.candidate, undefined);
});

test("no candidate produced: build ran but changed nothing → rejected, one receipt", async () => {
  const { ex, calls } = fakeExecutors({ candidate: { produced: false, changedFiles: [] } });
  const res = await runSelfHeal({ failure: failure(harnessCls) }, ex);
  assert.equal(res.verdict.disposition, "rejected");
  assert.deepEqual(calls, ["generateFix", "receipt"], "gates do not run when nothing was produced");
});

test("verified + low blast-radius → applied, gates run in order, no Opus advice", async () => {
  const { ex, calls, receipts } = fakeExecutors();
  const res = await runSelfHeal({ failure: failure(harnessCls), testCountBefore: 3028 }, ex);
  assert.equal(res.verdict.disposition, "applied");
  assert.deepEqual(calls, ["generateFix", "runSuite", "runJudge", "receipt"], "no opusAdvise for a low-risk verified fix");
  assert.equal(res.advice, undefined);
  assert.equal(receipts[0]?.verdict.disposition, "applied");
  assert.equal(res.blastRadius?.severity, "low");
});

test("verified + guard-path candidate (meta-rule) → awaiting-authorization AND Opus advice runs", async () => {
  const { ex, calls } = fakeExecutors({ candidate: { produced: true, changedFiles: ["src/modules/gate-wall/index.ts"], linesChanged: 8, branch: "b" } });
  const res = await runSelfHeal({ failure: failure(harnessCls) }, ex);
  assert.equal(res.verdict.disposition, "awaiting-authorization");
  assert.equal(res.blastRadius?.severity, "max");
  assert.ok(calls.includes("opusAdvise"), "Opus advises on a high/max verified fix");
  assert.equal(res.advice, "Opus: proceed with caution.");
});

test("advice is BEST-EFFORT: a failing advisory call degrades to a note, keeps the disposition", async () => {
  // The advice model may be a stub/unreachable (roster-dependent). A throw must NOT discard the
  // verified awaiting-authorization result — the human still needs to see the fix.
  const { ex } = fakeExecutors({ candidate: { produced: true, changedFiles: ["src/modules/gate-wall/index.ts"], linesChanged: 8, branch: "b" } });
  const throwing: SelfHealExecutors = { ...ex, opusAdvise: async () => { throw new Error("stub provider: opus-4.8 not backed"); } };
  const res = await runSelfHeal({ failure: failure(harnessCls) }, throwing);
  assert.equal(res.verdict.disposition, "awaiting-authorization", "the verified disposition survives a failed advisory");
  assert.match(res.advice ?? "", /advice unavailable: .*not backed/);
});

test("suite fails → diagnosed-proposal, never applied, no Opus advice", async () => {
  const { ex, calls } = fakeExecutors({ suite: { green: false, testCount: 3030, summary: "2 failing" } });
  const res = await runSelfHeal({ failure: failure(harnessCls) }, ex);
  assert.equal(res.verdict.disposition, "diagnosed-proposal");
  assert.equal(res.verdict.verified, false);
  assert.ok(!calls.includes("opusAdvise"), "no verified fix to advise merging");
});

test("no-test-drop: a candidate whose suite count fell below baseline is MAX → awaiting-authorization", async () => {
  // suite green but the count DROPPED vs testCountBefore → blast-radius MAX (suspected gaming).
  const { ex } = fakeExecutors({ suite: { green: true, testCount: 3000 } });
  const res = await runSelfHeal({ failure: failure(harnessCls), testCountBefore: 3028 }, ex);
  assert.equal(res.blastRadius?.severity, "max");
  assert.equal(res.verdict.disposition, "awaiting-authorization", "a suite-count drop can never auto-apply");
  assert.ok(res.blastRadius?.reasons.some((r) => /test count drops/.test(r)));
});

test("every path writes exactly one receipt carrying the terminal verdict", async () => {
  for (const cls of [modelCls, harnessCls]) {
    const { ex, receipts } = fakeExecutors();
    const res = await runSelfHeal({ failure: failure(cls) }, ex);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.verdict.disposition, res.verdict.disposition);
    assert.ok(res.reason.startsWith("self-heal t-heal-1:"));
  }
});

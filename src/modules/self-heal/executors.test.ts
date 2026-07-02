/**
 * self-heal executors — the pure adapter helpers + composeExecutors() wiring. These test the glue
 * (WorkerResult + suite + judge → CandidateFix/SuiteResult/JudgeResult) with fakes, and drive the
 * whole executor set through runSelfHeal end-to-end without a real build/model.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import type { JudgeResult as DetJudgeResult } from "../deterministic-judge/contract.js";
import type { WorkerResult, WorkerTask } from "../worker-model/contract.js";
import type { FailureClassification } from "../self-monitor/classify.js";
import { runSelfHeal } from "./driver.js";
import {
  buildAdviceMessages,
  buildFixTask,
  composeExecutors,
  parseDeleted,
  parseNumstat,
  toBuildCandidate,
  toCandidateFix,
  toJudgeResult,
  type SelfHealIo,
} from "./executors.js";
import type { CandidateFix, SelfHealFailure, SelfHealResult, SuiteResult } from "./contract.js";

const handle = (over: Partial<WorkspaceHandle> = {}): WorkspaceHandle => ({
  id: "ws-1", targetRepo: "/repos/ikbi", baseBranch: "main", baseRef: "abc123",
  scratchBranch: "ikbi/ws/ws-1", path: "/tmp/wt/ws-1", identity: { agentId: "self-heal", trustTier: "trusted" },
  state: "allocated", createdAt: 0, ...over,
});

const harnessCls: FailureClassification = {
  category: "harness", harnessSuspect: true, signal: "checks_unresolvable",
  evidence: "no verification contract", suggestedAction: "add a manifest",
};
const failure: SelfHealFailure = { taskId: "t1", classification: harnessCls, targetRepo: "/repos/ikbi", reason: "no manifest" };

const worker = (over: Partial<WorkerResult> = {}): WorkerResult => ({
  contractVersion: "1.1.0", taskId: "selfheal-t1", outcome: "success", roles: [], promoted: false, workspaceId: "ws-1", ...over,
});

// ── pure helpers ────────────────────────────────────────────────────────────────────────────────

test("parseNumstat sums added+removed and collects files (handles binary '-' rows)", () => {
  const out = "12\t3\tsrc/a.ts\n0\t5\tsrc/b.ts\n-\t-\tassets/logo.png\n";
  const r = parseNumstat(out);
  assert.deepEqual(r.changedFiles, ["src/a.ts", "src/b.ts", "assets/logo.png"]);
  assert.equal(r.linesChanged, 12 + 3 + 0 + 5, "binary rows contribute 0 lines");
});

test("parseDeleted extracts only D-status paths", () => {
  assert.deepEqual(parseDeleted("D\tsrc/gone.ts\nD\ttest/old.test.ts\n"), ["src/gone.ts", "test/old.test.ts"]);
  assert.deepEqual(parseDeleted(""), []);
});

test("toCandidateFix: produced iff any changed file; carries branch + workspace id", () => {
  const c = toCandidateFix({ changedFiles: ["src/a.ts"], deletedFiles: [], linesChanged: 9 }, handle(), "ok");
  assert.equal(c.produced, true);
  assert.equal(c.branch, "ikbi/ws/ws-1");
  assert.equal(c.workspaceId, "ws-1");
  assert.equal(toCandidateFix({ changedFiles: [], deletedFiles: [], linesChanged: 0 }, handle()).produced, false);
});

test("buildFixTask: skipPromote + reuseWorkspace + tier models + no-test-drop in the goal", () => {
  const task = buildFixTask(failure, handle(), { tier: "mid" });
  assert.equal(task.skipPromote, true, "never promote — the candidate stays isolated");
  assert.equal(task.reuseWorkspace?.id, "ws-1", "builds in OUR isolated workspace");
  assert.equal(task.targetRepo, "/repos/ikbi");
  assert.equal(task.builderModelOverride, "glm-5.2", "mid tier = the pro builder");
  assert.match(task.goal, /do NOT delete or weaken any test/i);
  assert.match(task.goal, /checks_unresolvable/);
});

test("toBuildCandidate maps suite + worker into the judge's shape", () => {
  const candidate: CandidateFix = { produced: true, changedFiles: ["src/a.ts", "src/b.ts"], linesChanged: 20, workspaceId: "ws-1" };
  const bc = toBuildCandidate(candidate, { green: true, testCount: 3050 }, worker());
  assert.equal(bc.workspaceId, "ws-1");
  assert.equal(bc.typecheckPass, true);
  assert.equal(bc.testsPass, true);
  assert.deepEqual(bc.testCount, { passed: 3050, total: 3050 });
  assert.equal(bc.testEvidence, "executed");
  assert.equal(bc.filesWritten, 2);
  assert.equal(bc.diffLines, 20);
});

test("toJudgeResult: pass only when OUR candidate is the non-disqualified winner", () => {
  const win: DetJudgeResult = { winner: { workspaceId: "ws-1", composite: 0.9 }, rejectedAll: false, ranking: [] };
  const lose: DetJudgeResult = { winner: null, rejectedAll: true, reason: "all disqualified", ranking: [] };
  assert.equal(toJudgeResult(win, "ws-1").pass, true);
  assert.equal(toJudgeResult(win, "other").pass, false);
  assert.equal(toJudgeResult(lose, "ws-1").pass, false);
  assert.equal(toJudgeResult(lose, "ws-1").reason, "all disqualified");
});

test("buildAdviceMessages: advisory framing (advises, does not decide) + the concrete diff facts", () => {
  const msgs = buildAdviceMessages({
    failure,
    candidate: { produced: true, changedFiles: ["src/modules/gate-wall/index.ts"], linesChanged: 8, branch: "b" },
    blastRadius: { severity: "max", reasons: ["touches a guard path"], requiresHuman: true, requiresOpusReview: true, autoApplyEligible: false },
  });
  assert.equal(msgs[0]?.role, "system");
  assert.match(msgs[0]!.content, /advise|do NOT decide/i);
  assert.match(msgs[1]!.content, /gate-wall/);
  assert.match(msgs[1]!.content, /max/);
});

// ── composeExecutors end-to-end via runSelfHeal ───────────────────────────────────────────────────

function fakeIo(over: Partial<{
  diff: { changedFiles: string[]; deletedFiles: string[]; linesChanged: number };
  suite: SuiteResult & { typecheckPass?: boolean };
  judge: DetJudgeResult;
  workerRoles: WorkerResult;
}> = {}): { io: SelfHealIo; calls: string[]; tasks: WorkerTask[]; receipts: SelfHealResult[] } {
  const calls: string[] = [];
  const tasks: WorkerTask[] = [];
  const receipts: SelfHealResult[] = [];
  const io: SelfHealIo = {
    allocate: async () => { calls.push("allocate"); return handle(); },
    build: async (t) => { calls.push("build"); tasks.push(t); return over.workerRoles ?? worker(); },
    readDiff: async () => { calls.push("readDiff"); return over.diff ?? { changedFiles: ["src/modules/chat/session.ts"], deletedFiles: [], linesChanged: 14 }; },
    runSuite: async () => { calls.push("runSuite"); return over.suite ?? { green: true, testCount: 3050, typecheckPass: true }; },
    judge: (cands) => { calls.push("judge"); return over.judge ?? { winner: { workspaceId: cands[0]!.workspaceId, composite: 0.8 }, rejectedAll: false, ranking: [] }; },
    advise: async () => { calls.push("advise"); return "Opus: merge after a spot-check."; },
    writeReceipt: async (r) => { calls.push("receipt"); receipts.push(r); },
  };
  return { io, calls, tasks, receipts };
}

test("end-to-end: verified low-risk candidate → applied, correct call order, no advice", async () => {
  const { io, calls, receipts } = fakeIo();
  const res = await runSelfHeal({ failure, testCountBefore: 3049 }, composeExecutors(io, { tier: "mid" }));
  assert.equal(res.verdict.disposition, "applied");
  assert.deepEqual(calls, ["allocate", "build", "readDiff", "runSuite", "judge", "receipt"], "no advise for low-risk");
  assert.equal(res.candidate?.branch, "ikbi/ws/ws-1");
  assert.equal(receipts.length, 1);
});

test("end-to-end: guard-path candidate (verified) → awaiting-authorization AND advice runs", async () => {
  const { io, calls } = fakeIo({ diff: { changedFiles: ["src/modules/gate-wall/index.ts"], deletedFiles: [], linesChanged: 6 } });
  const res = await runSelfHeal({ failure }, composeExecutors(io));
  assert.equal(res.verdict.disposition, "awaiting-authorization");
  assert.equal(res.blastRadius?.severity, "max");
  assert.ok(calls.includes("advise"));
  assert.equal(res.advice, "Opus: merge after a spot-check.");
});

test("end-to-end: suite fails → diagnosed-proposal, judge still consulted, no advice", async () => {
  const { io, calls } = fakeIo({ suite: { green: false, summary: "2 failing", typecheckPass: false } });
  const res = await runSelfHeal({ failure }, composeExecutors(io));
  assert.equal(res.verdict.disposition, "diagnosed-proposal");
  assert.ok(!calls.includes("advise"));
});

test("end-to-end: build produced no change → rejected, gates never run", async () => {
  const { io, calls } = fakeIo({ diff: { changedFiles: [], deletedFiles: [], linesChanged: 0 } });
  const res = await runSelfHeal({ failure }, composeExecutors(io));
  assert.equal(res.verdict.disposition, "rejected");
  assert.deepEqual(calls, ["allocate", "build", "readDiff", "receipt"], "no suite/judge on an empty candidate");
});

test("end-to-end: a deleted test file (no-test-drop) → max → awaiting-authorization even if judge passes", async () => {
  const { io } = fakeIo({ diff: { changedFiles: ["src/x.ts"], deletedFiles: ["src/x.test.ts"], linesChanged: 5 } });
  const res = await runSelfHeal({ failure }, composeExecutors(io));
  assert.equal(res.blastRadius?.severity, "max");
  assert.equal(res.verdict.disposition, "awaiting-authorization");
  assert.ok(res.blastRadius?.reasons.some((r) => /test file/.test(r)));
});

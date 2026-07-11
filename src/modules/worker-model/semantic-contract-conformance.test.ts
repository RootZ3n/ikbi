/**
 * SEMANTIC-CONTRACT CONFORMANCE (Phase 4).
 *
 * One truthful semantic-evaluation contract for every promotion-capable strategy. These tests prove
 * the strict parser (a candidate is rejected semantically ONLY for a concrete, blocking, candidate-
 * bound defect), the verdict-kind distinctions (pass / fail / incomplete / indeterminate /
 * infrastructure-failure / not-evaluated), the promotion + duel policy the kinds drive, and — at the
 * real orchestration seam — that the semantic gate withholds promotion under a non-pass verdict, that
 * an indeterminate/infrastructure critic does NOT trigger a peer duel, and that tournament/competitive
 * winners are semantically evaluated (never promote as `not-evaluated`).
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";

import {
  parseSemanticVerdict,
  infrastructureFailureVerdict,
  notEvaluatedVerdict,
  verdictBindsCandidate,
  semanticPromotionEligible,
  semanticDuelEligible,
} from "./semantic-verdict.js";
import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import type { EventBusSurface, EventInput, IkbiEvent } from "../../core/events/index.js";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import type { OperationContext } from "../../core/identity/resolver.js";
import type { DiscardResult, PromoteGovernance, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import type { RoleFn, WorkerRole } from "./contract.js";

const silent = () => pino({ level: "silent" });
const JSONV = (o: unknown): string => JSON.stringify(o);

// ───────────────────────────── Part 1: strict parser ─────────────────────────────

test("1: a valid structured PASS is a pass (semantically eligible)", () => {
  const v = parseSemanticVerdict(JSONV({ verdict: "pass", summary: "correct and complete" }));
  assert.equal(v.kind, "pass");
  assert.equal(semanticPromotionEligible(v.kind, false), true);
});

test("2: a structured FAIL with a concrete candidate-bound defect rejects the candidate", () => {
  const v = parseSemanticVerdict(JSONV({ verdict: "fail", blockingDefects: [{ claim: "subtreeBounds() returns the wrong bounds for nested nodes", evidence: "nodeBounds ignores children in geometry.ts:42", requirement: "subtreeBounds must cover descendants" }] }));
  assert.equal(v.kind, "fail");
  assert.equal(v.blockingDefects.length, 1);
  assert.equal(semanticPromotionEligible(v.kind, false), false);
  assert.equal(semanticDuelEligible(v.kind), true, "a concrete quality rejection is duel-eligible");
});

test("3: a FAIL with ZERO concrete defects becomes indeterminate (never a fabricated defect)", () => {
  assert.equal(parseSemanticVerdict(JSONV({ verdict: "fail", blockingDefects: [] })).kind, "indeterminate");
  assert.equal(parseSemanticVerdict(JSONV({ verdict: "fail" })).kind, "indeterminate");
});

test("4: a plain-text FAIL becomes indeterminate", () => {
  assert.equal(parseSemanticVerdict("FAIL").kind, "indeterminate");
  assert.equal(parseSemanticVerdict("FAIL").parseStatus, "unparsable");
});

test("5: malformed / non-JSON output becomes indeterminate", () => {
  assert.equal(parseSemanticVerdict("the change looks mostly fine to me").kind, "indeterminate");
  assert.equal(parseSemanticVerdict("").kind, "indeterminate");
});

test("6: a contradictory PASS + blocking defects becomes indeterminate", () => {
  const v = parseSemanticVerdict(JSONV({ verdict: "pass", blockingDefects: [{ claim: "off-by-one in the loop bound at foo.ts:10", evidence: "iterates n-1 times", requirement: "iterate n times" }] }));
  assert.equal(v.kind, "indeterminate");
});

test("7: a generic stylistic disagreement cannot create a blocking defect (→ indeterminate)", () => {
  assert.equal(parseSemanticVerdict(JSONV({ verdict: "fail", blockingDefects: [{ claim: "the implementation is wrong" }] })).kind, "indeterminate");
  assert.equal(parseSemanticVerdict(JSONV({ verdict: "fail", issues: ["the code is bad"] })).kind, "indeterminate");
});

test("8: an alternate correct implementation shape is accepted (PASS is a pass; issues are advisories)", () => {
  const v = parseSemanticVerdict(JSONV({ verdict: "pass", feedback: "different structure than expected but behavior is correct", issues: ["could use a Map instead of an object"] }));
  assert.equal(v.kind, "pass");
  assert.equal(v.blockingDefects.length, 0, "an advisory on a PASS is never a blocking defect");
  assert.ok(v.advisories.length >= 1, "the advisory is preserved separately");
});

test("9: a concrete missing API requirement produces incomplete", () => {
  const v = parseSemanticVerdict(JSONV({ verdict: "incomplete", incompleteRequirements: ["the requested subtreeBounds(document, nodeId) overload was not implemented"] }));
  assert.equal(v.kind, "incomplete");
  assert.equal(v.incompleteRequirements.length, 1);
  assert.equal(semanticPromotionEligible(v.kind, false), false);
  assert.equal(parseSemanticVerdict(JSONV({ verdict: "incomplete", incompleteRequirements: [] })).kind, "indeterminate", "incomplete needs a concrete missing requirement");
});

test("10: defect evidence bound to ANOTHER candidate is rejected", () => {
  const v = parseSemanticVerdict(JSONV({ verdict: "fail", blockingDefects: [{ claim: "returns wrong value in foo.ts:9", evidence: "x" }] }), { candidateId: "cand-A", verifiedTree: "T-A" });
  assert.equal(v.candidateId, "cand-A");
  assert.equal(verdictBindsCandidate(v, "cand-A", "T-A"), true, "binds its own candidate");
  assert.equal(verdictBindsCandidate(v, "cand-B", "T-A"), false, "a verdict for cand-A cannot judge cand-B");
});

test("11: defect evidence bound to a STALE tree is rejected", () => {
  const v = parseSemanticVerdict(JSONV({ verdict: "fail", blockingDefects: [{ claim: "wrong bound at bar.ts:3", evidence: "x" }] }), { candidateId: "cand-A", verifiedTree: "T-old" });
  assert.equal(verdictBindsCandidate(v, "cand-A", "T-old"), true);
  assert.equal(verdictBindsCandidate(v, "cand-A", "T-new"), false, "a verdict against the old tree cannot judge the new tree");
});

// ── verdict kinds + policy helpers ──
test("kinds: infrastructure-failure and not-evaluated are distinct, never a defect, never eligible", () => {
  const inf = infrastructureFailureVerdict("provider timeout");
  assert.equal(inf.kind, "infrastructure-failure");
  assert.equal(inf.blockingDefects.length, 0);
  assert.equal(semanticPromotionEligible(inf.kind, false), false);
  assert.equal(semanticDuelEligible(inf.kind), false, "a provider outage is not a candidate rejection — no duel");
  const ne = notEvaluatedVerdict("skipped by policy");
  assert.equal(semanticPromotionEligible(ne.kind, false), false, "not-evaluated is not autonomously promotable by default");
  assert.equal(semanticPromotionEligible(ne.kind, true), true, "…unless policy marks evaluation optional");
});

test("kinds: only pass is autonomously promotable; only fail/incomplete are duel-eligible", () => {
  for (const k of ["fail", "incomplete", "indeterminate", "infrastructure-failure", "not-evaluated"] as const) {
    assert.equal(semanticPromotionEligible(k, false), false, `${k} is not promotable`);
  }
  assert.equal(semanticPromotionEligible("pass", false), true);
  assert.deepEqual((["pass", "fail", "incomplete", "indeterminate", "infrastructure-failure", "not-evaluated"] as const).map(semanticDuelEligible), [false, true, true, false, false, false]);
});

test("23: the verdict identifies the actual evaluator model + parse status (truthful receipts)", () => {
  const v = parseSemanticVerdict(JSONV({ verdict: "pass" }), { evaluatorModel: "deepseek-v4-pro", parseStatus: "structured" });
  assert.equal(v.evaluatorModel, "deepseek-v4-pro");
  assert.equal(v.parseStatus, "structured");
});

// ───────────────────────── Part 2: real orchestration seam ─────────────────────────

function makeIdentities() {
  const agents = [
    { agentId: "parent-1", kind: "agent" as const, functionalRole: "lead", defaultTrustTier: "trusted", tokenHashes: [hashToken("parent-secret")] },
    { agentId: "worker-1", kind: "agent" as const, functionalRole: "worker", defaultTrustTier: "trusted", tokenHashes: [hashToken("worker-secret")] },
  ];
  const resolver = new IdentityResolver({ registry: new AgentRegistry({ agents }), logger: silent(), now: () => 1000 });
  const parentCtx: OperationContext = beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
  const resolveIdentity: NonNullable<OrchestratorDeps["resolveIdentity"]> = (claim, ctx) => resolver.resolve(claim, ctx);
  const roleClaim: NonNullable<OrchestratorDeps["roleClaim"]> = () => ({ token: "worker-secret" });
  return { parentCtx, resolveIdentity, roleClaim };
}
function fakeBus(): EventBusSurface {
  return {
    publish: <P>(input: EventInput<P>): IkbiEvent<P> => ({ ...input, contractVersion: "1.0.0", id: "e", seq: 1, timestamp: 0 } as IkbiEvent<P>),
    subscribe: () => ({ id: "s", unsubscribe: () => {}, stats: () => ({ delivered: 0, dropped: 0, failures: 0, queued: 0 }) }),
    flush: async () => {},
  };
}
function capturingReceipts() {
  const appended: Array<{ operation: string; metadata: Record<string, unknown> }> = [];
  const receipts = { append: async (input: unknown, _id: AgentIdentity): Promise<unknown> => { const r = input as { operation: string; metadata?: Record<string, unknown> }; appended.push({ operation: r.operation, metadata: r.metadata ?? {} }); return {}; } };
  return { receipts, appended };
}
const greenGovernedExec = { run: async () => ({ executed: true as const, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) };
const COST = 0.002;
function ok(content: string): ModelResponse {
  return { contractVersion: "1.1.0", model: "recording", provider: "recording", providerModelId: "recording", content, finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, cost: { usd: COST, promptUsd: COST, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } }, latencyMs: 1, fellBack: false, attempts: [] };
}
function toolResp(name: string, args: unknown): ModelResponse { return { ...ok(""), finishReason: "tool_calls", toolCalls: [{ id: `${name}1`, name, arguments: JSON.stringify(args) }] }; }

/** Drives the REAL builder to success and answers the critic call with `criticResponse`. */
function providerWithCritic(criticResponse: string) {
  let turn = 0;
  return async (req: ModelRequest): Promise<ModelResponse> => {
    if (typeof (req as { prompt?: unknown }).prompt === "string") return ok(JSON.stringify({ tier: "worker", rationale: "x" }));
    const hasDone = (req.tools ?? []).some((t) => t.name === "done");
    if (!hasDone) return ok(criticResponse); // scout + the REAL critic (no done tool)
    turn += 1;
    if (turn === 1) return toolResp("read_file", { path: "a.ts" });
    if (turn === 2) return toolResp("write_file", { path: "a.ts", content: "export const a = 2;\n" });
    if (turn === 3) return toolResp("run_checks", {});
    return toolResp("done", { successCondition: "do the thing", filesReadBack: ["a.ts"], selfCheck: "ran checks green; goal met", satisfied: true });
  };
}

function realOrchestrator(invokeModel: (r: ModelRequest) => Promise<ModelResponse>, roles: Partial<Record<WorkerRole, RoleFn>>) {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const rc = capturingReceipts();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-p4c-"));
  writeFileSync(join(dir, "a.ts"), "export const a = 1;");
  const handle: WorkspaceHandle = { id: "wsp4", targetRepo: dir, baseBranch: "main", baseRef: "H", scratchBranch: "s", path: dir, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  const promoteCalls: number[] = [];
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 1000, maxConcurrentRuns: 1, trustLadder: false },
    workspaces: {
      allocate: async () => handle,
      promote: async (h): Promise<PromoteResult> => { promoteCalls.push(1); return { promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }; },
      discard: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: true }),
      retain: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: false }),
      commit: async () => true,
      diff: async () => "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n-export const a = 1;\n+export const a = 2;\n",
    },
    events: fakeBus(), receipts: rc.receipts, resolveIdentity, roleClaim, roles, invokeModel,
    governedExec: greenGovernedExec, builderModel: "deepseek-v4-flash",
    gateWall: { evaluate: async (): Promise<PromoteGovernance> => ({ allow: true, reason: "ok" }) },
  });
  return { orch, parentCtx, receipts: rc.appended, promoteCalls };
}
const passIntegrator: Partial<Record<WorkerRole, RoleFn>> = {
  verifier: async () => ({ role: "verifier", outcome: "success", summary: "v", detail: { verdict: "pass", checks: [{ name: "test", command: "pnpm test", exitCode: 0, testCount: { passed: 1, total: 1 } }], testEvidence: "executed" } }),
  integrator: async () => ({ role: "integrator", outcome: "success", summary: "i", detail: { decision: "promote", rationale: "ok", evaluation: { approved: true } } }),
};
// A REALISTIC integrator that gates on the critic (mirrors production): it discards unless the critic
// passed. Used for the FAIL/indeterminate cases so the terminal duel classification runs on the verdict.
const criticAwareRoles: Partial<Record<WorkerRole, RoleFn>> = {
  verifier: async () => ({ role: "verifier", outcome: "success", summary: "v", detail: { verdict: "pass", checks: [{ name: "test", command: "pnpm test", exitCode: 0, testCount: { passed: 1, total: 1 } }], testEvidence: "executed" } }),
  integrator: async (ctx) => {
    const pass = ((ctx.priorResults.find((r) => r.role === "critic")?.detail ?? {}) as Record<string, unknown>).pass === true;
    return pass
      ? { role: "integrator", outcome: "success", summary: "i", detail: { decision: "promote", rationale: "ok", evaluation: { approved: true } } }
      : { role: "integrator", outcome: "success", summary: "i", detail: { decision: "discard", rationale: "critic did not pass", evaluation: { approved: false } } };
  },
};

// 16 + gate: a real PASS critic promotes; a contradictory PASS-with-defects is semantically WITHHELD.
test("seam: a real semantic PASS promotes through the canonical authority", async () => {
  const { orch, parentCtx, promoteCalls, receipts } = realOrchestrator(providerWithCritic(JSONV({ verdict: "PASS", scores: { goal_correctness: 5 }, feedback: "correct" })), passIntegrator);
  const r = await orch.run({ taskId: "t-pass", targetRepo: "/unused", goal: "do the thing", moeExpertRental: true, moeVendorLane: "deepseek" }, parentCtx);
  assert.equal(r.outcome, "success");
  assert.equal(promoteCalls.length, 1);
  assert.equal(receipts.find((x) => x.operation === "worker.promotion")?.metadata.semanticVerdict, "pass");
});

test("seam: an integrator-approved but CONTRADICTORY critic verdict is semantically WITHHELD (no promote)", async () => {
  // verdict=PASS (integrator approves via detail.pass) BUT with a concrete blocking defect → the
  // canonical semantic verdict is `indeterminate`, and the authority withholds the promote.
  const contradictory = JSONV({ verdict: "PASS", blockingDefects: [{ claim: "returns the wrong tree for nested nodes in a.ts:1", evidence: "ignores children" }], feedback: "looks fine" });
  const { orch, parentCtx, promoteCalls, receipts } = realOrchestrator(providerWithCritic(contradictory), passIntegrator);
  const r = await orch.run({ taskId: "t-contra", targetRepo: "/unused", goal: "do the thing", moeExpertRental: true, moeVendorLane: "deepseek" }, parentCtx);
  assert.notEqual(r.outcome, "success");
  assert.equal(promoteCalls.length, 0, "the semantic gate withheld the promote before the low-level promote");
  assert.ok(receipts.some((x) => x.operation === "worker.promotion.semantic_withheld"), "the withholding is recorded truthfully");
});

// 20 + 21: indeterminate / infrastructure critic → NOT candidate-rejected (no peer duel)
test("20: an INDETERMINATE critic (bare FAIL) does NOT make the attempt duel-eligible", async () => {
  const { orch, parentCtx } = realOrchestrator(providerWithCritic("FAIL"), criticAwareRoles);
  const r = await orch.run({ taskId: "t-indet", targetRepo: "/unused", goal: "do the thing", moeExpertRental: true, moeVendorLane: "deepseek" }, parentCtx);
  assert.notEqual(r.outcome, "success");
  assert.equal(r.nonPromotion?.class, "semantic-indeterminate");
  assert.equal(r.nonPromotion?.duelEligible, false, "a peer vendor cannot fix an indeterminate critic");
});

test("21: a critic INFRASTRUCTURE failure (unparsable) does NOT trigger a peer duel", async () => {
  const { orch, parentCtx } = realOrchestrator(providerWithCritic("<<not json at all>>"), criticAwareRoles);
  const r = await orch.run({ taskId: "t-infra", targetRepo: "/unused", goal: "do the thing", moeExpertRental: true, moeVendorLane: "deepseek" }, parentCtx);
  assert.notEqual(r.outcome, "success");
  assert.equal(r.nonPromotion?.duelEligible, false, "an unparsable critic is not a candidate rejection");
});

test("2b: a real concrete-defect FAIL DOES make the attempt duel-eligible (candidate-rejected)", async () => {
  const concreteFail = JSONV({ verdict: "FAIL", scores: { goal_correctness: 1 }, feedback: "wrong", issues: ["subtreeBounds() ignores descendants — returns the node's own bounds only (a.ts:1)"] });
  const { orch, parentCtx } = realOrchestrator(providerWithCritic(concreteFail), criticAwareRoles);
  const r = await orch.run({ taskId: "t-fail", targetRepo: "/unused", goal: "do the thing", moeExpertRental: true, moeVendorLane: "deepseek" }, parentCtx);
  assert.notEqual(r.outcome, "success");
  assert.equal(r.nonPromotion?.class, "candidate-rejected");
  assert.equal(r.nonPromotion?.duelEligible, true);
});

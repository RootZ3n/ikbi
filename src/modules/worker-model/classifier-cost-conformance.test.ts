/**
 * CLASSIFIER-COST CONFORMANCE (Phase 7, IKBI-RT-011).
 *
 * The semantic-difficulty classifier is a REAL provider invocation that runs BEFORE the costing engine.
 * Its spend was previously discarded (invisible to `runCost`/the run-summary/the budget) and never
 * receipted. These tests prove, at the real orchestration→provider seam, that the classifier call is
 * recorded (`worker.classifier`), priced by the CLASSIFIER model (not the expert it selects), folded
 * into the run total as distinct routing overhead, budget-counted, truthfully statused (measured /
 * unavailable / no-call), and never double-counted.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";

import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import type { EventBusSurface, EventInput, IkbiEvent } from "../../core/events/index.js";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import type { OperationContext } from "../../core/identity/resolver.js";
import type { DiscardResult, PromoteGovernance, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import type { RoleFn, WorkerRole, WorkerTask } from "./contract.js";

const silent = () => pino({ level: "silent" });
function makeIdentities() {
  const agents = [
    { agentId: "parent-1", kind: "agent" as const, functionalRole: "lead", defaultTrustTier: "trusted", tokenHashes: [hashToken("parent-secret")] },
    { agentId: "worker-1", kind: "agent" as const, functionalRole: "worker", defaultTrustTier: "trusted", tokenHashes: [hashToken("worker-secret")] },
  ];
  const resolver = new IdentityResolver({ registry: new AgentRegistry({ agents }), logger: silent(), now: () => 1000 });
  const parentCtx: OperationContext = beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
  return { parentCtx, resolveIdentity: ((c, x) => resolver.resolve(c, x)) as NonNullable<OrchestratorDeps["resolveIdentity"]>, roleClaim: (() => ({ token: "worker-secret" })) as NonNullable<OrchestratorDeps["roleClaim"]> };
}
function fakeBus(): EventBusSurface {
  return { publish: <P>(i: EventInput<P>): IkbiEvent<P> => ({ ...i, contractVersion: "1.0.0", id: "e", seq: 1, timestamp: 0 } as IkbiEvent<P>), subscribe: () => ({ id: "s", unsubscribe: () => {}, stats: () => ({ delivered: 0, dropped: 0, failures: 0, queued: 0 }) }), flush: async () => {} };
}
function capturingReceipts() {
  const appended: Array<{ operation: string; metadata: Record<string, unknown> }> = [];
  return { receipts: { append: async (i: unknown, _id: AgentIdentity): Promise<unknown> => { const r = i as { operation: string; metadata?: Record<string, unknown> }; appended.push({ operation: r.operation, metadata: r.metadata ?? {} }); return {}; } }, appended };
}
const greenExec = { run: async () => ({ executed: true as const, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) };
function resp(content: string, cost?: number): ModelResponse {
  return { contractVersion: "1.1.0", model: "recording", provider: "recording", providerModelId: "recording", content, finishReason: "stop", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, ...(cost !== undefined ? { cost: { usd: cost, promptUsd: cost, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } } } : {}), latencyMs: 1, fellBack: false, attempts: [] } as ModelResponse;
}
function tool(name: string, args: unknown): ModelResponse { return { ...resp("", 0.001), finishReason: "tool_calls", toolCalls: [{ id: `${name}1`, name, arguments: JSON.stringify(args) }] }; }
const stubVI: Partial<Record<WorkerRole, RoleFn>> = {
  verifier: async () => ({ role: "verifier", outcome: "success", summary: "v", detail: { verdict: "pass", checks: [{ name: "test", command: "pnpm test", exitCode: 0, testCount: { passed: 1, total: 1 } }], testEvidence: "executed" } }),
  integrator: async () => ({ role: "integrator", outcome: "success", summary: "i", detail: { decision: "promote", rationale: "ok", evaluation: { approved: true } } }),
  critic: async () => ({ role: "critic", outcome: "success", summary: "c", detail: { pass: true } }),
};

/** classifierTier forces the difficulty verdict; classifierCost is the cost the provider reports (undefined ⇒ none). */
function provider(classifierTier: "worker" | "mid", classifierCost: number | undefined) {
  const classifierCalls: string[] = [];
  let turn = 0;
  const invokeModel = async (req: ModelRequest): Promise<ModelResponse> => {
    if (typeof (req as { prompt?: unknown }).prompt === "string") { classifierCalls.push(req.model); return resp(JSON.stringify({ tier: classifierTier, rationale: "forced" }), classifierCost); }
    if (!(req.tools ?? []).some((t) => t.name === "done")) return resp(JSON.stringify({ verdict: "PASS", scores: { goal_correctness: 5 }, feedback: "ok" }), 0.0005);
    turn += 1;
    if (turn === 1) return tool("read_file", { path: "a.ts" });
    if (turn === 2) return tool("write_file", { path: "a.ts", content: "export const a = 2;\n" });
    if (turn === 3) return tool("run_checks", {});
    return tool("done", { successCondition: "g", filesReadBack: ["a.ts"], selfCheck: "green", satisfied: true });
  };
  return { invokeModel, classifierCalls };
}
function orchestratorWith(inv: (r: ModelRequest) => Promise<ModelResponse>, maxBudgetUsd?: number) {
  const ids = makeIdentities(); const rc = capturingReceipts();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-cc-")); writeFileSync(join(dir, "a.ts"), "export const a = 1;");
  const handle: WorkspaceHandle = { id: "wscc", targetRepo: dir, baseBranch: "main", baseRef: "H", scratchBranch: "s", path: dir, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 1000, maxConcurrentRuns: 1, trustLadder: false },
    resolveIdentity: ids.resolveIdentity, roleClaim: ids.roleClaim, roles: stubVI, invokeModel: inv,
    workspaces: { allocate: async () => handle, promote: async (h): Promise<PromoteResult> => ({ promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }), discard: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: true }), commit: async () => true, diff: async () => "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n-export const a = 1;\n+export const a = 2;\n" },
    events: fakeBus(), receipts: rc.receipts, governedExec: greenExec, builderModel: "deepseek-v4-flash",
    gateWall: { evaluate: async (): Promise<PromoteGovernance> => ({ allow: true }) }, readTreeHash: async () => "T",
    // Adjudication seam: this non-git fake workspace can't produce a real tree-bound WorkProduct, so the
    // authoritative core is fed a labeled GREEN product. The builder always writes a.ts, so every run here
    // has real work on disk (the classifier + build always reach a promotable candidate).
    computeWorkProduct: async () => ({ treeHash: "T", diffStat: { filesChanged: 1, insertions: 1, deletions: 0 }, nonEmpty: true }),
  });
  const task: WorkerTask = { taskId: "t", targetRepo: dir, goal: "do the thing", moeExpertRental: true, ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}) };
  return { orch, parentCtx: ids.parentCtx, receipts: rc.appended, task };
}
const classifierReceipt = (rs: Array<{ operation: string; metadata: Record<string, unknown> }>) => rs.filter((r) => r.operation === "worker.classifier");
const runSummary = (rs: Array<{ operation: string; metadata: Record<string, unknown> }>) => rs.find((r) => r.operation === "worker.run.summary");

test("1: a model-backed classifier is recorded once + its cost is folded into the run total as routing overhead", async () => {
  const { orch, parentCtx, receipts, task } = orchestratorWith(provider("worker", 0.0002).invokeModel);
  const r = await orch.run(task, parentCtx);
  assert.equal(r.outcome, "success");
  const cr = classifierReceipt(receipts);
  assert.equal(cr.length, 1, "exactly one classifier invocation receipt (no double count)");
  assert.equal(cr[0]!.metadata.costUsd, 0.0002);
  assert.equal(cr[0]!.metadata.costStatus, "measured");
  const sum = runSummary(receipts)!;
  assert.equal(sum.metadata.routingOverheadUsd, 0.0002, "routing overhead is a distinct subtotal");
  assert.ok((sum.metadata.costUsd as number) >= 0.0002, "the run total INCLUDES the classifier cost");
  assert.equal(sum.metadata.costStatus, "complete");
});

test("2: the classifier is priced by the CLASSIFIER model; the builder by the SELECTED expert (distinct)", async () => {
  const { orch, parentCtx, receipts, task } = orchestratorWith(provider("mid", 0.0002).invokeModel);
  await orch.run(task, parentCtx);
  const cr = classifierReceipt(receipts)[0]!;
  assert.equal(cr.metadata.classifierModel, "deepseek-v4-flash", "the classifier ran on the worker-tier classifier model");
  assert.ok(String(cr.metadata.selectedExpert).endsWith("-pro"), `a mid ('pro') expert was selected, recorded SEPARATELY, got ${cr.metadata.selectedExpert}`);
  assert.notEqual(cr.metadata.classifierModel, cr.metadata.selectedExpert, "classifier cost is not charged to the expert it selected");
  const builder = receipts.find((x) => x.operation === "worker.role.builder");
  assert.equal(builder?.metadata.model, cr.metadata.selectedExpert, "the builder is priced under the SELECTED expert (Phase 1), not the classifier model");
});

test("3: deterministic (moeExpertRental OFF) is a NO-CALL — no classifier receipt, zero routing overhead", async () => {
  const p = provider("worker", 0.0002);
  const { orch, parentCtx, receipts, task } = orchestratorWith(p.invokeModel);
  await orch.run({ ...task, moeExpertRental: false }, parentCtx);
  assert.equal(p.classifierCalls.length, 0, "no classifier provider call when routing is off");
  assert.equal(classifierReceipt(receipts).length, 0, "no fabricated classifier invocation");
  assert.equal(runSummary(receipts)!.metadata.routingOverheadUsd, 0, "zero routing overhead — no call occurred");
});

test("8/9: a classifier call whose provider returns NO cost is UNAVAILABLE (not zero) → the run total is PARTIAL", async () => {
  const { orch, parentCtx, receipts, task } = orchestratorWith(provider("worker", undefined).invokeModel);
  await orch.run(task, parentCtx);
  const cr = classifierReceipt(receipts)[0]!;
  assert.equal(cr.metadata.costStatus, "unavailable", "missing usage/cost is UNKNOWN, never silently zero");
  assert.equal(runSummary(receipts)!.metadata.costStatus, "partial", "the aggregate is partial when a cost is unknown");
});

test("12/19: the classifier receipt binds the concrete dispatched model == classifier model (no double count)", async () => {
  const { orch, parentCtx, receipts, task } = orchestratorWith(provider("worker", 0.0002).invokeModel);
  await orch.run(task, parentCtx);
  const cr = classifierReceipt(receipts);
  assert.equal(cr.length, 1);
  assert.equal(cr[0]!.metadata.dispatchedModel, cr[0]!.metadata.classifierModel, "dispatched == classifier model");
  assert.equal(cr[0]!.metadata.invocationId, "t:classifier", "a stable invocation id ties the record to one call");
  assert.equal(cr[0]!.metadata.modelBacked, true);
});

test("21: classifier spend counts toward the global run budget (a tiny cap aborts on the classifier)", async () => {
  // A budget smaller than the classifier cost: folding it must trip BUDGET_EXHAUSTED (the classifier IS spend).
  const { orch, parentCtx, receipts, task } = orchestratorWith(provider("worker", 0.01).invokeModel, 0.005);
  const r = await orch.run(task, parentCtx);
  assert.notEqual(r.outcome, "success", "the classifier spend is visible to the budget cap");
  assert.match(String(r.reason ?? ""), /budget/i);
  // The classifier invocation is still receipted truthfully even though the build aborted.
  assert.equal(classifierReceipt(receipts)[0]?.metadata.costUsd, 0.01);
});

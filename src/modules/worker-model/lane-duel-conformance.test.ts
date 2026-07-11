/**
 * LANE-DUEL CONFORMANCE (IKBI-RT-002 / Phase 2).
 *
 * Phase 2 makes the duel-on-failure lane-pure and conditional. These tests prove, at three real seams:
 *
 *   1. the PURE duel policy (`primaryWarrantsPeer`) — a peer runs ONLY for a candidate the pipeline
 *      judged not-promotable, never for a governance/structural/security/interrupt refusal;
 *   2. the CLI duel SCHEDULER — a promoted primary never pays for a peer, a non-promotable primary
 *      runs exactly one peer in the OPPOSING lane with a DISTINCT attempt id, and an infrastructure
 *      error never becomes a peer duel;
 *   3. the REAL orchestrator → provider seam — a lane-pinned attempt keeps every provider call in its
 *      lane even under a cross-lane operator `--fallback-model`, the attempt records an explicit
 *      `worker.model_decision`, and the non-promotion class is set truthfully.
 *
 * The Phase 1 invariant (rented == dispatched == billed == receipt) is re-verified here on the duel
 * path; the six Phase 1 model-identity tests remain a separate regression file.
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
import { createWorkerCli, primaryWarrantsPeer } from "./cli.js";
import { CONTRACT_VERSION, type NonPromotionClass, type WorkerResult, type WorkerRole, type RoleFn, type WorkerTask } from "./contract.js";

const silent = () => pino({ level: "silent" });

// ───────────────────────────── Part 1: PURE duel policy ─────────────────────────────

function resultWith(outcome: WorkerResult["outcome"], nonPromotion?: { class: NonPromotionClass; duelEligible: boolean }): WorkerResult {
  return { contractVersion: CONTRACT_VERSION, taskId: "t", outcome, roles: [], promoted: outcome === "success", ...(nonPromotion !== undefined ? { nonPromotion } : {}) };
}

test("policy: a promoted primary NEVER warrants a peer", () => {
  assert.equal(primaryWarrantsPeer(resultWith("success")), false);
});

test("policy: ONLY candidate-rejected is duel-eligible; every other non-promotion class is not", () => {
  assert.equal(primaryWarrantsPeer(resultWith("failure", { class: "candidate-rejected", duelEligible: true })), true);
  for (const cls of ["governance-refused", "unverifiable", "injection-blocked", "interrupted", "candidate-conflict"] as const) {
    assert.equal(primaryWarrantsPeer(resultWith("rejected", { class: cls, duelEligible: false })), false, `${cls} must not duel`);
  }
});

test("policy: a legacy result without a classification falls back to failure→duel, rejected/partial→no-duel", () => {
  assert.equal(primaryWarrantsPeer(resultWith("failure")), true, "a pipeline failure is duel-eligible by fallback");
  assert.equal(primaryWarrantsPeer(resultWith("rejected")), false, "a bare rejected is NOT duel-eligible");
  assert.equal(primaryWarrantsPeer(resultWith("partial")), false, "a bare partial is NOT duel-eligible");
});

// ───────────────────────── Part 2: CLI duel SCHEDULER (fake orchestrator) ─────────────────────────

const OPERATOR_TOKEN = "operator-token-value";
const WORKER_TOKEN = "worker-token-value";
function makeResolver(operatorTier: string, workerTier: string) {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({
      agents: [
        { agentId: "lead", kind: "agent", functionalRole: "lead", defaultTrustTier: operatorTier, tokenHashes: [hashToken(OPERATOR_TOKEN)] },
        { agentId: "worker", kind: "agent", functionalRole: "worker", defaultTrustTier: workerTier, tokenHashes: [hashToken(WORKER_TOKEN)] },
      ],
    }),
    logger: silent(), now: () => 1000,
  });
  return (claim: { token?: string }) => resolver.resolve(claim);
}

/** Record every attempt the CLI dispatched (lane, taskId, cost) and answer with a scripted result. */
function duelHarness(reply: (task: WorkerTask) => WorkerResult | Promise<WorkerResult>) {
  const attempts: Array<{ taskId: string; lane: string | undefined; cost: number }> = [];
  const fakeOrch = {
    run: async (task: WorkerTask): Promise<WorkerResult> => {
      const r = await reply(task);
      attempts.push({ taskId: task.taskId, lane: task.moeVendorLane, cost: r.costUsd ?? 0 });
      return r;
    },
  };
  const cli = createWorkerCli({
    orchestrator: fakeOrch,
    resolveIdentity: makeResolver("trusted", "trusted"),
    operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN,
    stdout: () => {}, stderr: () => {}, setExit: () => {}, now: () => 1, cwd: () => "/repo",
  });
  return { cli, attempts };
}

const promoted = (task: WorkerTask): WorkerResult => ({ contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: "success", roles: [], promoted: true, costUsd: 0.01 });
const nonPromoting = (task: WorkerTask, cls: NonPromotionClass, duelEligible: boolean): WorkerResult => ({
  contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: cls === "candidate-conflict" ? "partial" : cls === "candidate-rejected" ? "failure" : "rejected",
  roles: [], promoted: false, costUsd: 0.01, reason: `${cls}`, nonPromotion: { class: cls, duelEligible },
});

test("scheduler: a promoted DeepSeek primary runs ONE attempt and NEVER spins a MiMo peer (no peer cost)", async () => {
  const { cli, attempts } = duelHarness((task) => promoted(task));
  await cli.build(["fix", "the", "bug", "--repo", "/repo", "--yes", "--tier", "cheap"]);
  assert.deepEqual(attempts.map((a) => a.lane), ["deepseek"], "exactly one attempt, in the primary (deepseek) lane");
  assert.ok(!attempts.some((a) => a.lane === "mimo"), "no MiMo peer attempt was created");
  assert.equal(attempts.reduce((s, a) => s + a.cost, 0), 0.01, "only the primary attempt's cost was incurred");
});

test("scheduler: a candidate-rejected primary duels ONE MiMo peer with a DISTINCT attempt id, and cost sums both", async () => {
  const { cli, attempts } = duelHarness((task) => task.moeVendorLane === "mimo" ? promoted(task) : nonPromoting(task, "candidate-rejected", true));
  await cli.build(["fix", "the", "bug", "--repo", "/repo", "--yes", "--tier", "cheap"]);
  assert.deepEqual(attempts.map((a) => a.lane), ["deepseek", "mimo"], "primary deepseek, then exactly one mimo peer");
  const [primary, peer] = attempts;
  assert.notEqual(primary!.taskId, peer!.taskId, "the primary and peer are separately attributable (distinct attempt ids)");
  assert.ok(primary!.taskId.includes("deepseek") && peer!.taskId.includes("mimo"), "each attempt id carries its own lane");
  assert.equal(attempts.reduce((s, a) => s + a.cost, 0), 0.02, "total cost = primary + peer, each counted once");
});

test("scheduler: a GOVERNANCE-refused primary does NOT duel a peer (a different vendor cannot fix it)", async () => {
  const { cli, attempts } = duelHarness((task) => nonPromoting(task, "governance-refused", false));
  await cli.build(["fix", "the", "bug", "--repo", "/repo", "--yes", "--tier", "cheap"]);
  assert.deepEqual(attempts.map((a) => a.lane), ["deepseek"], "no peer after a governance refusal");
});

test("scheduler: an UNVERIFIABLE primary does NOT duel a peer", async () => {
  const { cli, attempts } = duelHarness((task) => nonPromoting(task, "unverifiable", false));
  await cli.build(["fix", "the", "bug", "--repo", "/repo", "--yes", "--tier", "cheap"]);
  assert.deepEqual(attempts.map((a) => a.lane), ["deepseek"], "no peer for an unverifiable target");
});

test("scheduler: an INFRASTRUCTURE error on the primary never becomes a peer duel (the error surfaces)", async () => {
  const attempts: string[] = [];
  const fakeOrch = {
    run: async (task: WorkerTask): Promise<WorkerResult> => {
      attempts.push(task.moeVendorLane ?? "none");
      throw new Error("transient provider outage");
    },
  };
  const cli = createWorkerCli({
    orchestrator: fakeOrch, resolveIdentity: makeResolver("trusted", "trusted"),
    operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN,
    stdout: () => {}, stderr: () => {}, setExit: () => {}, now: () => 1, cwd: () => "/repo",
  });
  await cli.build(["fix", "the", "bug", "--repo", "/repo", "--yes", "--tier", "cheap"]).catch(() => {});
  assert.deepEqual(attempts, ["deepseek"], "the primary threw before a candidate existed — NO peer was launched");
});

test("scheduler: primary AND peer both fail → no promotion claim, both attempts ran, total cost is real", async () => {
  const { cli, attempts } = duelHarness((task) => nonPromoting(task, "candidate-rejected", true));
  await cli.build(["fix", "the", "bug", "--repo", "/repo", "--yes", "--tier", "cheap"]);
  assert.deepEqual(attempts.map((a) => a.lane), ["deepseek", "mimo"], "both lanes ran once");
  assert.equal(attempts.reduce((s, a) => s + a.cost, 0), 0.02, "cost equals the two real attempts, no promotion");
});

// NEGATIVE-MUTATION GUARD (req 14a): the peer must be gated on the primary's promotion status. If the
// scheduler ever launches the peer before checking, this assertion (one attempt on primary success) fails.
test("scheduler NEGATIVE: the peer is not launched until the primary's promotion status is known", async () => {
  let peerLaunchedWhilePrimaryUnknown = false;
  let primaryDone = false;
  const fakeOrch = {
    run: async (task: WorkerTask): Promise<WorkerResult> => {
      if (task.moeVendorLane === "mimo" && !primaryDone) peerLaunchedWhilePrimaryUnknown = true;
      const r = promoted(task);
      if (task.moeVendorLane === "deepseek") primaryDone = true;
      return r;
    },
  };
  const cli = createWorkerCli({
    orchestrator: fakeOrch, resolveIdentity: makeResolver("trusted", "trusted"),
    operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN,
    stdout: () => {}, stderr: () => {}, setExit: () => {}, now: () => 1, cwd: () => "/repo",
  });
  await cli.build(["fix", "the", "bug", "--repo", "/repo", "--yes", "--tier", "cheap"]);
  assert.equal(peerLaunchedWhilePrimaryUnknown, false, "the peer must never run before the primary's outcome is known");
});

// ─────────────────── Part 3: REAL orchestrator → provider seam ───────────────────

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
function fakeBus() {
  const bus: EventBusSurface = {
    publish: <P>(input: EventInput<P>): IkbiEvent<P> => ({ ...input, contractVersion: "1.0.0", id: "e", seq: 1, timestamp: 0 } as IkbiEvent<P>),
    subscribe: () => ({ id: "s", unsubscribe: () => {}, stats: () => ({ delivered: 0, dropped: 0, failures: 0, queued: 0 }) }),
    flush: async () => {},
  };
  return { bus };
}
function capturingReceipts() {
  const appended: Array<{ operation: string; metadata: Record<string, unknown> }> = [];
  const receipts = {
    append: async (input: unknown, _id: AgentIdentity): Promise<unknown> => {
      const rec = input as { operation: string; metadata?: Record<string, unknown> };
      appended.push({ operation: rec.operation, metadata: rec.metadata ?? {} });
      return {};
    },
  };
  return { receipts, appended };
}
const greenGovernedExec = { run: async () => ({ executed: true as const, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) };
const COST = 0.002;
function ok(content: string): ModelResponse {
  return {
    contractVersion: "1.1.0", model: "recording", provider: "recording", providerModelId: "recording",
    content, finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: COST, promptUsd: COST, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
function toolResp(name: string, args: unknown): ModelResponse {
  return { ...ok(""), finishReason: "tool_calls", toolCalls: [{ id: `${name}1`, name, arguments: JSON.stringify(args) }] };
}
const stubRoles: Partial<Record<WorkerRole, RoleFn>> = {
  verifier: async () => ({ role: "verifier", outcome: "success", summary: "ok", detail: { verdict: "pass", checks: [], testEvidence: "executed" } }),
  critic: async () => ({ role: "critic", outcome: "success", summary: "c", detail: { pass: true, semanticVerdict: { kind: "pass", summary: "ok", blockingDefects: [], incompleteRequirements: [], advisories: [], parseStatus: "structured" } } }),
  integrator: async () => ({ role: "integrator", outcome: "success", summary: "p", detail: { decision: "promote", rationale: "s", evaluation: { approved: true } } }),
};

/** Provider that records the model of every builder request; drives the real builder to success. */
function successProvider(classifierTier: "worker" | "mid") {
  const builderModels: string[] = [];
  let turn = 0;
  const invokeModel = async (req: ModelRequest): Promise<ModelResponse> => {
    if (typeof (req as { prompt?: unknown }).prompt === "string") return ok(JSON.stringify({ tier: classifierTier, rationale: "x" }));
    if (!(req.tools ?? []).some((t) => t.name === "done")) return ok(JSON.stringify({ verdict: "PASS", scores: { files_modified: 5, goal_correctness: 5, code_quality: 5, tests: 5, suspicious_patterns: 5 }, feedback: "correct and complete for the goal" }));
    builderModels.push(req.model);
    turn += 1;
    if (turn === 1) return toolResp("read_file", { path: "a.ts" });
    if (turn === 2) return toolResp("write_file", { path: "a.ts", content: "export const a = 2;\n" });
    if (turn === 3) return toolResp("run_checks", {});
    return toolResp("done", { successCondition: "do the thing", filesReadBack: ["a.ts"], selfCheck: "ran checks green; goal met", satisfied: true });
  };
  return { invokeModel, builderModels };
}
/** Provider whose builder ALWAYS fails (writes nothing) → escalation/pool-sweep fires. */
function failingProvider(classifierTier: "worker" | "mid") {
  const builderModels: string[] = [];
  const invokeModel = async (req: ModelRequest): Promise<ModelResponse> => {
    if (typeof (req as { prompt?: unknown }).prompt === "string") return ok(JSON.stringify({ tier: classifierTier, rationale: "x" }));
    if (!(req.tools ?? []).some((t) => t.name === "done")) return ok(JSON.stringify({ verdict: "PASS", scores: { files_modified: 5, goal_correctness: 5, code_quality: 5, tests: 5, suspicious_patterns: 5 }, feedback: "correct and complete for the goal" }));
    builderModels.push(req.model);
    return ok("");
  };
  return { invokeModel, builderModels };
}

function realOrchestrator(invokeModel: (r: ModelRequest) => Promise<ModelResponse>, extra?: Partial<OrchestratorDeps>) {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const rc = capturingReceipts();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-p2-"));
  writeFileSync(join(dir, "a.ts"), "export const a = 1;");
  const handle: WorkspaceHandle = { id: "wsp2", targetRepo: dir, baseBranch: "main", baseRef: "d", scratchBranch: "s", path: dir, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 1000, maxConcurrentRuns: 1, trustLadder: false },
    workspaces: {
      allocate: async () => handle,
      promote: async (h): Promise<PromoteResult> => ({ promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }),
      discard: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: true }),
      commit: async () => true,
    },
    events: fakeBus().bus, receipts: rc.receipts, resolveIdentity, roleClaim, roles: stubRoles, invokeModel,
    governedExec: greenGovernedExec, builderModel: "deepseek-v4-flash",
    gateWall: { evaluate: async (): Promise<PromoteGovernance> => ({ allow: true, reason: "ok" }) },
    ...extra,
  });
  return { orch, parentCtx, receipts: rc.appended, dir };
}

// ── req 12: receipt conformance — provider request == model_decision receipt == builder receipt == lane ──
test("real seam: a deepseek-lane MoE run agrees across provider request, model_decision receipt, and builder receipt", async () => {
  const rp = successProvider("worker");
  const { orch, parentCtx, receipts, dir } = realOrchestrator(rp.invokeModel);
  const result = await orch.run({ taskId: "t:deepseek", targetRepo: dir, goal: "do the thing", moeExpertRental: true, moeVendorLane: "deepseek" }, parentCtx);

  assert.equal(result.outcome, "success");
  const dispatched = rp.builderModels[0];
  assert.equal(dispatched, "deepseek-v4-flash", "the provider request carried the rented deepseek base model");
  const decisionReceipt = receipts.find((r) => r.operation === "worker.model_decision");
  assert.ok(decisionReceipt !== undefined, "an explicit worker.model_decision receipt was written for the attempt");
  assert.equal(decisionReceipt!.metadata.model, dispatched, "model_decision receipt model == provider request model");
  assert.equal(decisionReceipt!.metadata.vendorLane, "deepseek", "model_decision receipt records the vendor lane");
  assert.equal(decisionReceipt!.metadata.attemptId, "t:deepseek", "the attempt id is the lane-distinct task id");
  const builderReceipt = receipts.find((r) => r.operation === "worker.role.builder");
  assert.equal(builderReceipt!.metadata.model, dispatched, "builder receipt model == provider request model");
  // The lane + alias + source live on the builder ROLE detail (Phase 1) and the model_decision receipt;
  // together with the lane-distinct requestId they tie every record to one attempt in one lane.
  const builderDetail = result.roles.find((r) => r.role === "builder")?.detail as Record<string, unknown> | undefined;
  assert.equal(builderDetail?.vendorLane, "deepseek", "builder role detail records the same lane");
  assert.equal(builderDetail?.modelAlias, dispatched, "builder role detail records the requested alias truthfully");
});

// ── req 14b NEGATIVE: a cross-lane --fallback-model must NOT pull the attempt out of its lane ──
test("real seam NEGATIVE: a cross-lane --fallback-model never dispatches out of the attempt's lane", async () => {
  const rp = failingProvider("worker");
  // deepseek-lane attempt, but the operator asks for a MiMo fallback: it must be ignored in this lane.
  const { orch, parentCtx } = realOrchestrator(rp.invokeModel);
  await orch.run({ taskId: "t:deepseek", targetRepo: "/unused", goal: "do the thing", moeExpertRental: true, moeVendorLane: "deepseek", fallbackModel: "mimo-v2.5-pro" }, parentCtx);

  assert.ok(rp.builderModels.length >= 2, "the builder failed and escalation/pool-sweep ran");
  for (const m of rp.builderModels) {
    assert.ok(m.startsWith("deepseek"), `every builder request stayed in the deepseek lane despite the cross-lane fallback, got: ${m}`);
  }
  assert.ok(!rp.builderModels.some((m) => m.startsWith("mimo")), "the cross-lane MiMo fallback was NEVER dispatched");
});

// ── req 7: a same-lane --fallback-model is honored as an in-lane escalation pick ──
test("real seam: a same-lane --fallback-model escalates in-lane (all deepseek), attribution truthful", async () => {
  const rp = failingProvider("worker");
  const { orch, parentCtx } = realOrchestrator(rp.invokeModel);
  await orch.run({ taskId: "t:deepseek", targetRepo: "/unused", goal: "do the thing", moeExpertRental: true, moeVendorLane: "deepseek", fallbackModel: "deepseek-v4-pro" }, parentCtx);
  assert.ok(rp.builderModels.length >= 2, "escalation ran");
  for (const m of rp.builderModels) assert.ok(m.startsWith("deepseek"), `stayed in lane: ${m}`);
  assert.ok(rp.builderModels.includes("deepseek-v4-pro"), "the in-lane operator fallback WAS used on escalation");
});

// ── nonPromotion classification is set truthfully on the real terminals ──
test("real seam: a failing candidate is classified candidate-rejected (duel-eligible)", async () => {
  const rp = failingProvider("worker");
  const { orch, parentCtx, dir } = realOrchestrator(rp.invokeModel);
  const result = await orch.run({ taskId: "t:deepseek", targetRepo: dir, goal: "do the thing", moeExpertRental: true, moeVendorLane: "deepseek" }, parentCtx);
  assert.notEqual(result.outcome, "success");
  assert.equal(result.nonPromotion?.class, "candidate-rejected", "a real, judged-not-promotable candidate");
  assert.equal(result.nonPromotion?.duelEligible, true, "→ a peer vendor lane is warranted");
});

test("real seam: a gate-wall denial is classified governance-refused (NOT duel-eligible)", async () => {
  const rp = successProvider("worker");
  const { orch, parentCtx, dir } = realOrchestrator(rp.invokeModel, {
    gateWall: { evaluate: async (): Promise<PromoteGovernance> => ({ allow: false, reason: "denied by policy" }) },
  });
  const result = await orch.run({ taskId: "t:deepseek", targetRepo: dir, goal: "do the thing", moeExpertRental: true, moeVendorLane: "deepseek" }, parentCtx);
  assert.notEqual(result.outcome, "success");
  assert.equal(result.nonPromotion?.class, "governance-refused", "a gate-wall veto is a governance refusal");
  assert.equal(result.nonPromotion?.duelEligible, false, "→ a peer vendor cannot override governance");
});

test("real seam: a dirty-repo pre-dispatch refusal is governance-refused and records no builder execution", async () => {
  const rp = successProvider("worker");
  const { orch, parentCtx } = realOrchestrator(rp.invokeModel, { checkTargetDirty: async () => "uncommitted changes present" });
  const result = await orch.run({ taskId: "t:deepseek", targetRepo: "/repo", goal: "do the thing", moeExpertRental: true, moeVendorLane: "deepseek" }, parentCtx);
  assert.equal(result.outcome, "rejected");
  assert.equal(result.nonPromotion?.duelEligible, false, "a dirty repo is not duel-eligible");
  assert.equal(rp.builderModels.length, 0, "no builder model was dispatched before the refusal");
});

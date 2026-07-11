/**
 * MODEL-IDENTITY CONFORMANCE (IKBI-RT-001 / IKBI-RT-002).
 *
 * These tests inspect the REAL orchestration → provider seam: they run the actual builder loop with a
 * RECORDING provider and assert that the model the semantic MoE rental chose is the model the provider
 * request carried, the model the receipt recorded, and the model cost was billed to. The invariant:
 *
 *     rented model == dispatched model == billed model == receipt model
 *
 * Before the fix, the rental populated an `effectiveBuilderModel` used only for receipts/cost while the
 * initial builder dispatched a separate `complexityModel` (usually the configured default). A hard
 * sub-task, or a MiMo-lane peer, could therefore run one model while its receipt claimed another. Unlike
 * expert-rental.test.ts (which validates the pure helper) these tests drive the orchestrator end to end,
 * so they fail if that rental decision is not carried into the provider request.
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
import type { AgentRecord } from "../../core/identity/registry.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import type { DiscardResult, PromoteGovernance, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import { escalationConfig } from "../escalation/index.js";
import { rentBuilderExpert } from "./expert-rental.js";
import type { ModelTier } from "../model-router/index.js";
import type { RoleFn, WorkerRole, WorkerTask } from "./contract.js";

const silent = () => pino({ level: "silent" });

function makeIdentities() {
  const agents: AgentRecord[] = [
    { agentId: "parent-1", kind: "agent", functionalRole: "lead", defaultTrustTier: "trusted", tokenHashes: [hashToken("parent-secret")] },
    { agentId: "worker-1", kind: "agent", functionalRole: "worker", defaultTrustTier: "trusted", tokenHashes: [hashToken("worker-secret")] },
  ];
  const resolver = new IdentityResolver({ registry: new AgentRegistry({ agents }), logger: silent(), now: () => 1000 });
  const parentCtx = beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
  const resolveIdentity: NonNullable<OrchestratorDeps["resolveIdentity"]> = (claim, ctx) => resolver.resolve(claim, ctx);
  const roleClaim: NonNullable<OrchestratorDeps["roleClaim"]> = () => ({ token: "worker-secret" });
  return { parentCtx, resolveIdentity, roleClaim };
}

function fakeBus() {
  const sent: Array<EventInput<unknown>> = [];
  const bus: EventBusSurface = {
    publish: <P>(input: EventInput<P>): IkbiEvent<P> => {
      sent.push(input as EventInput<unknown>);
      return { ...input, contractVersion: "1.0.0", id: `e${sent.length}`, seq: sent.length, timestamp: 0 } as IkbiEvent<P>;
    },
    subscribe: () => ({ id: "sub", unsubscribe: () => {}, stats: () => ({ delivered: 0, dropped: 0, failures: 0, queued: 0 }) }),
    flush: async () => {},
  };
  return { bus, sent };
}

/** Captures every role receipt's metadata so a test can read the persisted builder model + cost. */
function capturingReceipts() {
  const appended: Array<{ operation: string; metadata: Record<string, unknown> }> = [];
  const receipts = {
    append: async (input: unknown, _identity: AgentIdentity): Promise<unknown> => {
      const rec = input as { operation: string; metadata?: Record<string, unknown> };
      appended.push({ operation: rec.operation, metadata: rec.metadata ?? {} });
      return {};
    },
  };
  return { receipts, appended };
}

/** A GREEN governed exec so the builder's in-loop run_checks passes (verifier is stubbed here). */
const greenGovernedExec = { run: async () => ({ executed: true as const, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) };

const COST_PER_CALL = 0.002;
function ok(content: string): ModelResponse {
  return {
    contractVersion: "1.1.0", model: "recording", provider: "recording", providerModelId: "recording",
    content, finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: COST_PER_CALL, promptUsd: COST_PER_CALL, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
function toolResp(name: string, args: unknown): ModelResponse {
  return { ...ok(""), finishReason: "tool_calls", toolCalls: [{ id: `${name}1`, name, arguments: JSON.stringify(args) }] };
}

/**
 * A recording provider that drives the REAL builder to a clean success and records the `model` of
 * every builder provider request (the calls whose tool set includes `done`). The classifier call
 * (a `prompt`-shaped request) is answered with the requested difficulty tier so the rental is forced.
 */
function recordingProvider(classifierTier: "worker" | "mid") {
  const builderModels: string[] = [];
  let builderTurn = 0;
  const invokeModel = async (req: ModelRequest): Promise<ModelResponse> => {
    // The difficulty ROUTER classifier is the only prompt-shaped call inside orchestrator.run.
    if (typeof (req as { prompt?: unknown }).prompt === "string") {
      return ok(JSON.stringify({ tier: classifierTier, rationale: "forced by test" }));
    }
    const hasDone = (req.tools ?? []).some((t) => t.name === "done");
    if (!hasDone) return ok(JSON.stringify({ verdict: "PASS", scores: { files_modified: 5, goal_correctness: 5, code_quality: 5, tests: 5, suspicious_patterns: 5 }, feedback: "correct and complete for the goal" })); // scout / critic (no done tool)
    builderModels.push(req.model);
    builderTurn += 1;
    if (builderTurn === 1) return toolResp("read_file", { path: "a.ts" });
    if (builderTurn === 2) return toolResp("write_file", { path: "a.ts", content: "export const a = 2;\n" });
    if (builderTurn === 3) return toolResp("run_checks", {});
    return toolResp("done", { successCondition: "do the thing", filesReadBack: ["a.ts"], selfCheck: "re-read a.ts, ran checks green; goal met", satisfied: true });
  };
  return { invokeModel, builderModels };
}

/** Stubbed verifier + integrator so the real verifier does not spawn a toolchain in a unit test. */
const stubRoles: Partial<Record<WorkerRole, RoleFn>> = {
  verifier: async () => ({ role: "verifier", outcome: "success", summary: "checks ok (stubbed)", detail: { verdict: "pass", checks: [], testEvidence: "executed" } }),
  critic: async () => ({ role: "critic", outcome: "success", summary: "c", detail: { pass: true, semanticVerdict: { kind: "pass", summary: "ok", blockingDefects: [], incompleteRequirements: [], advisories: [], parseStatus: "structured" } } }),
  integrator: async () => ({ role: "integrator", outcome: "success", summary: "promote (stubbed)", detail: { decision: "promote", rationale: "stubbed", evaluation: { approved: true } } }),
};

function realBuilderOrchestrator(invokeModel: (request: ModelRequest) => Promise<ModelResponse>, builderModel: string) {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const bus = fakeBus();
  const rc = capturingReceipts();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-identity-"));
  writeFileSync(join(dir, "a.ts"), "export const a = 1;");
  const handle: WorkspaceHandle = {
    id: "wsident", targetRepo: dir, baseBranch: "main", baseRef: "deadbeef",
    scratchBranch: "ikbi/ws/wsident", path: dir, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000,
  };
  const workspaces: NonNullable<OrchestratorDeps["workspaces"]> = {
    allocate: async () => handle,
    promote: async (h): Promise<PromoteResult> => ({ promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }),
    discard: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: true }),
    commit: async () => true,
  };
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 1000, maxConcurrentRuns: 1, trustLadder: false },
    workspaces, events: bus.bus, receipts: rc.receipts, resolveIdentity, roleClaim,
    roles: stubRoles, invokeModel, governedExec: greenGovernedExec, builderModel,
    gateWall: { evaluate: async (): Promise<PromoteGovernance> => ({ allow: true, reason: "test gate allows" }) },
  });
  return { orch, parentCtx, receipts: rc.appended, dir };
}

/** The concrete model the rental resolves for a (tier, lane) — the SAME helper the orchestrator uses. */
function expectedRental(goal: string, tierOverride: ModelTier, vendorLane: string | undefined, fallback: string): string {
  return rentBuilderExpert({
    goal, tierRosters: escalationConfig.tierModels, fallback, tierOverride,
    ...(vendorLane !== undefined ? { vendorLane } : {}),
  }).modelId;
}

const DEFAULT_BUILDER = "deepseek-v4-flash";

async function runRented(classifierTier: "worker" | "mid", vendorLane: string | undefined) {
  const rp = recordingProvider(classifierTier);
  const { orch, parentCtx, receipts, dir } = realBuilderOrchestrator(rp.invokeModel, DEFAULT_BUILDER);
  const task: WorkerTask = {
    taskId: "t-ident", targetRepo: dir, goal: "do the thing", moeExpertRental: true,
    ...(vendorLane !== undefined ? { moeVendorLane: vendorLane } : {}),
  };
  const result = await orch.run(task, parentCtx);
  const builderReceipt = receipts.find((r) => r.operation === "worker.role.builder");
  const builderRole = result.roles.find((r) => r.role === "builder");
  return { result, rp, builderReceipt, builderRole };
}

// ── 1 & 3 & 4 & 5: a SIMPLE task rented to base/flash sends that model; request == receipt == cost ──
test("simple × deepseek lane: the rented base model is the model dispatched, receipted, and billed", async () => {
  const expected = expectedRental("do the thing", "worker", "deepseek", DEFAULT_BUILDER);
  assert.equal(expected, "deepseek-v4-flash", "sanity: simple deepseek rents the base flash model");
  const { result, rp, builderReceipt, builderRole } = await runRented("worker", "deepseek");

  assert.equal(result.outcome, "success");
  // 1: the model SENT to the provider on the builder's first request is the rented model.
  assert.ok(rp.builderModels.length > 0, "the real builder actually called the provider");
  assert.equal(rp.builderModels[0], expected, "provider request carried the rented model, not the default");
  for (const m of rp.builderModels) assert.equal(m, expected, "every builder request stayed on the rented model");
  // 3: the model recorded in the durable builder receipt matches the provider request.
  assert.equal(builderReceipt?.metadata.model, expected, "receipt model == dispatched model");
  // 4: cost was billed to that same executed model.
  assert.equal(typeof builderReceipt?.metadata.costUsd, "number");
  assert.ok((builderReceipt!.metadata.costUsd as number) > 0, "the executed model accrued cost");
  // 5: alias resolution is truthful — the requested alias and resolved model are both recorded.
  const detail = builderRole?.detail as Record<string, unknown> | undefined;
  assert.equal(detail?.model, expected, "result detail model == dispatched model");
  assert.equal(detail?.modelAlias, expected, "requested alias recorded truthfully");
  assert.equal(detail?.modelSource, "moe-rental", "source recorded as the semantic rental");
});

// ── 2 & 6: a DIFFICULT task rented to pro sends the PRO model directly, not a default/escalation ──
test("difficult × deepseek lane: the rented pro model is dispatched DIRECTLY, not reached via a failed flash first", async () => {
  const expected = expectedRental("do the thing", "mid", "deepseek", DEFAULT_BUILDER);
  assert.equal(expected, "deepseek-v4-pro", "sanity: difficult deepseek rents the pro model");
  assert.notEqual(expected, DEFAULT_BUILDER, "the rented pro differs from the configured default");
  const { result, rp, builderReceipt } = await runRented("mid", "deepseek");

  assert.equal(result.outcome, "success");
  // 2 + 6: the FIRST builder request is the rented pro — the semantic routing is not overwritten by
  // the default, and the pro is not reached only after a failed flash attempt.
  assert.equal(rp.builderModels[0], expected, "hard task dispatched the pro on the FIRST request");
  assert.equal(builderReceipt?.metadata.model, expected, "receipt model == dispatched pro model");
});

// ── The load-bearing regression: a MiMo-lane peer must run MiMo, not the DeepSeek default ──
test("simple × mimo lane: the peer runs the MiMo base model (not the DeepSeek default) end to end", async () => {
  const expected = expectedRental("do the thing", "worker", "mimo", DEFAULT_BUILDER);
  assert.equal(expected, "mimo-v2.5", "sanity: simple mimo rents the mimo base model");
  assert.notEqual(expected, DEFAULT_BUILDER, "the mimo rental differs from the deepseek default (the old bug's blind spot)");
  const { result, rp, builderReceipt } = await runRented("worker", "mimo");

  assert.equal(result.outcome, "success");
  assert.equal(rp.builderModels[0], expected, "the MiMo-lane peer dispatched a MiMo model, not the DeepSeek default");
  assert.equal(builderReceipt?.metadata.model, expected, "receipt truthfully attributes the MiMo model");
  for (const m of rp.builderModels) assert.ok(m.startsWith("mimo"), `every peer request stayed in the mimo lane (${m})`);
});

test("difficult × mimo lane: the peer runs the MiMo PRO model directly", async () => {
  const expected = expectedRental("do the thing", "mid", "mimo", DEFAULT_BUILDER);
  assert.equal(expected, "mimo-v2.5-pro", "sanity: difficult mimo rents the mimo pro model");
  const { result, rp, builderReceipt } = await runRented("mid", "mimo");
  assert.equal(result.outcome, "success");
  assert.equal(rp.builderModels[0], expected, "hard mimo task dispatched the mimo pro on the first request");
  assert.equal(builderReceipt?.metadata.model, expected, "receipt model == dispatched mimo pro");
});

// ── 7: a RETRY does not silently cross vendor lanes ─────────────────────────────────
/** A recording provider whose builder ALWAYS fails (writes nothing, protocol-stops) → escalation fires. */
function failingRecordingProvider(classifierTier: "worker" | "mid") {
  const builderModels: string[] = [];
  const invokeModel = async (req: ModelRequest): Promise<ModelResponse> => {
    if (typeof (req as { prompt?: unknown }).prompt === "string") {
      return ok(JSON.stringify({ tier: classifierTier, rationale: "forced" }));
    }
    const hasDone = (req.tools ?? []).some((t) => t.name === "done");
    if (!hasDone) return ok(JSON.stringify({ verdict: "PASS", scores: { files_modified: 5, goal_correctness: 5, code_quality: 5, tests: 5, suspicious_patterns: 5 }, feedback: "correct and complete for the goal" }));
    builderModels.push(req.model);
    // Never write a file, never call a tool — the builder loop stalls out and fails, forcing the
    // cheap same-model retry and then the lane-scoped pool sweep.
    return ok("");
  };
  return { invokeModel, builderModels };
}

test("retry stays in lane: a failing MiMo-lane attempt escalates only within the MiMo lane (no cross-lane retry)", async () => {
  const rp = failingRecordingProvider("worker");
  const { orch, parentCtx } = realBuilderOrchestrator(rp.invokeModel, DEFAULT_BUILDER);
  const task: WorkerTask = { taskId: "t-lane-retry", targetRepo: "/unused", goal: "do the thing", moeExpertRental: true, moeVendorLane: "mimo" };
  await orch.run(task, parentCtx);

  assert.ok(rp.builderModels.length >= 2, "the builder failed and at least one retry/escalation ran");
  for (const m of rp.builderModels) {
    assert.ok(m.startsWith("mimo"), `every builder request (initial + retries) stayed in the mimo lane, got: ${m}`);
  }
});

// ── 8: a PRE-DISPATCH failure does not claim the model executed ─────────────────────
test("pre-dispatch failure (dirty repo) writes NO builder role receipt — nothing claims the model ran", async () => {
  const rp = recordingProvider("mid");
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const bus = fakeBus();
  const rc = capturingReceipts();
  const handle: WorkspaceHandle = {
    id: "wsdirty", targetRepo: "/repo", baseBranch: "main", baseRef: "d", scratchBranch: "s", path: "/tmp/x", identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000,
  };
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 1000, maxConcurrentRuns: 1, trustLadder: false },
    workspaces: { allocate: async () => handle, promote: async () => ({ promoted: false }) as PromoteResult, discard: async () => ({ workspaceId: handle.id, removed: true }) },
    events: bus.bus, receipts: rc.receipts, resolveIdentity, roleClaim, invokeModel: rp.invokeModel,
    // Force a pre-dispatch rejection: the repo is dirty, so run() returns BEFORE any role dispatch.
    checkTargetDirty: async () => "uncommitted changes present",
  });
  const task: WorkerTask = { taskId: "t-predispatch", targetRepo: "/repo", goal: "do the thing", moeExpertRental: true, moeVendorLane: "mimo" };
  const result = await orch.run(task, parentCtx);

  assert.equal(result.outcome, "rejected", "the run was rejected before any model dispatch");
  assert.deepEqual(result.roles, [], "no roles ran");
  assert.equal(rp.builderModels.length, 0, "the provider was never asked to run a builder model");
  const builderReceipt = rc.appended.find((r) => r.operation === "worker.role.builder");
  assert.equal(builderReceipt, undefined, "NO builder role receipt exists — nothing falsely claims the model executed");
});

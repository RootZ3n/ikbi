/**
 * FIXER-LANE CONFORMANCE (Phase 6, IKBI-RT-012).
 *
 * A same-lane fixer runs a LANE-VALID model inside the current attempt; a cross-lane `config.fixerModel`
 * is never silently executed inside a lane-pinned attempt (it is replaced by the in-lane model — the
 * cross-lane repair is owned by the Phase 2 peer attempt). The fixer is truthfully receipted (selected ==
 * dispatched == billed == receipt), carries source→repair candidate provenance, is bounded, and fires
 * only from a concrete deterministic/semantic defect (never a bare/indeterminate/infrastructure critic).
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";

import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import { autonomyForTier, asTier, TRUST_FLOOR, type TrustDecision } from "../../core/trust/index.js";
import type { DiscardResult, PromoteGovernance, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import { isRetryableCriticFail } from "./critic-fix-loop.js";
import { WORKER_ROLES, type RoleFn, type RoleResult, type WorkerRole } from "./contract.js";

const silent = () => pino({ level: "silent" });
function makeIdentities() {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [
      { agentId: "parent-1", kind: "agent", functionalRole: "lead", defaultTrustTier: "trusted", tokenHashes: [hashToken("parent-secret")] },
      { agentId: "worker-1", kind: "agent", functionalRole: "worker", defaultTrustTier: "trusted", tokenHashes: [hashToken("worker-secret")] },
    ] }), logger: silent(), now: () => 1000,
  });
  const parentCtx = beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
  return { parentCtx, resolveIdentity: ((c, x) => resolver.resolve(c, x)) as NonNullable<OrchestratorDeps["resolveIdentity"]>, roleClaim: (() => ({ token: "worker-secret" })) as NonNullable<OrchestratorDeps["roleClaim"]> };
}
const fakeTrust = () => ({ recordOutcome: async (i: { agentId: string; defaultTrustTier: string }): Promise<TrustDecision> => { const t = asTier(i.defaultTrustTier, TRUST_FLOOR); return { agentId: i.agentId, tier: t, previousTier: t, autonomy: autonomyForTier(t) }; } });
const noopBus = () => ({ publish: <P>(i: P) => ({ ...(i as object), contractVersion: "1.0.0", id: "e", seq: 1, timestamp: 0 }) as unknown, subscribe: () => ({ id: "s", unsubscribe: () => {}, stats: () => ({ delivered: 0, dropped: 0, failures: 0, queued: 0 }) }), flush: async () => {} });
const allowGate: NonNullable<OrchestratorDeps["gateWall"]> = { evaluate: async (): Promise<PromoteGovernance> => ({ allow: true }) };
function capturingReceipts() {
  const appended: Array<{ operation: string; metadata: Record<string, unknown> }> = [];
  return { receipts: { append: async (i: unknown, _id: AgentIdentity): Promise<unknown> => { const r = i as { operation: string; metadata?: Record<string, unknown> }; appended.push({ operation: r.operation, metadata: r.metadata ?? {} }); return {}; } }, appended };
}
function fakeWorkspaces() {
  const handle: WorkspaceHandle = { id: "wsabcd", targetRepo: "/repo", baseBranch: "main", baseRef: "deadbeef", scratchBranch: "s", path: "/tmp/wsabcd", identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  const calls = { promote: 0 };
  const workspaces: NonNullable<OrchestratorDeps["workspaces"]> = {
    allocate: async () => handle,
    promote: async (h): Promise<PromoteResult> => { calls.promote += 1; return { promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }; },
    discard: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: true }),
  };
  return { workspaces, calls };
}
/** A verifier-fail shape: builder succeeds; verifier RED until the fixer's 2nd builder pass, then GREEN. */
function verifierFailRoles(criticPass = true) {
  const calls = { builder: 0 };
  const roles: Partial<Record<WorkerRole, RoleFn>> = {};
  for (const r of WORKER_ROLES) {
    roles[r] = async () => {
      if (r === "builder") { calls.builder += 1; return { role: r, outcome: "success", summary: "built", detail: { filesWritten: ["src/a.ts"], policyViolations: [] } }; }
      if (r === "verifier") return calls.builder >= 2 ? { role: r, outcome: "success", summary: "GREEN", detail: { verdict: "pass", checks: [{ name: "typecheck", passed: true }], testEvidence: "executed" } } : { role: r, outcome: "failure", summary: "RED", detail: { checks: [{ name: "typecheck", passed: false }] } };
      if (r === "critic") return { role: r, outcome: "success", summary: "c", detail: { pass: criticPass } };
      if (r === "integrator") return { role: r, outcome: "success", summary: r, detail: { decision: "promote", evaluation: { approved: true } } };
      return { role: r, outcome: "success", summary: r };
    };
  }
  return { roles, calls };
}
function orchestratorWith(fixerModel: string, roles: Partial<Record<WorkerRole, RoleFn>>, ids: ReturnType<typeof makeIdentities>, rc: ReturnType<typeof capturingReceipts>, ws: ReturnType<typeof fakeWorkspaces>) {
  return createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 5000, maxConcurrentRuns: 1, totalBudgetMs: 0, fixerModel },
    resolveIdentity: ids.resolveIdentity, roleClaim: ids.roleClaim, roles,
    workspaces: ws.workspaces, trust: fakeTrust(), receipts: rc.receipts,
    events: noopBus() as unknown as NonNullable<OrchestratorDeps["events"]>, gateWall: allowGate,
    invokeModel: async () => { throw new Error("unused"); }, killCheck: async () => ({ killed: false }),
  });
}
const fixerReceipt = (rc: ReturnType<typeof capturingReceipts>) => rc.appended.find((x) => x.operation === "worker.fixer");

// ── same-lane / cross-lane / unpinned model selection (receipt = selected model) ──
test("cross-lane: a MiMo config.fixerModel in a DEEPSEEK-lane attempt is REPLACED by the in-lane model (peer owns cross-lane)", async () => {
  const ids = makeIdentities(); const rc = capturingReceipts(); const ws = fakeWorkspaces();
  const orch = orchestratorWith("mimo-v2.5-pro", verifierFailRoles().roles, ids, rc, ws);
  await orch.run({ taskId: "t", targetRepo: "/repo", goal: "g", escalationDisabled: true, moeVendorLane: "deepseek" }, ids.parentCtx);
  const rec = fixerReceipt(rc);
  assert.ok(rec !== undefined, "a worker.fixer receipt was written");
  assert.ok(String(rec!.metadata.fixerModel).startsWith("deepseek"), `the dispatched fixer model stayed in the deepseek lane, got ${rec!.metadata.fixerModel}`);
  assert.equal(rec!.metadata.dispatchedModel, rec!.metadata.fixerModel, "selected == dispatched");
  assert.equal(rec!.metadata.crossLaneAvoided, true, "the cross-lane config.fixerModel was avoided");
  assert.equal(rec!.metadata.vendorLane, "deepseek");
});

test("same-lane: an in-lane config.fixerModel is honored verbatim (crossLaneAvoided false)", async () => {
  const ids = makeIdentities(); const rc = capturingReceipts(); const ws = fakeWorkspaces();
  const orch = orchestratorWith("deepseek-v4-pro", verifierFailRoles().roles, ids, rc, ws);
  await orch.run({ taskId: "t", targetRepo: "/repo", goal: "g", escalationDisabled: true, moeVendorLane: "deepseek" }, ids.parentCtx);
  const rec = fixerReceipt(rc)!;
  assert.equal(rec.metadata.fixerModel, "deepseek-v4-pro");
  assert.equal(rec.metadata.crossLaneAvoided, false);
});

test("unpinned: with NO vendor lane, config.fixerModel is used verbatim (no lane to violate)", async () => {
  const ids = makeIdentities(); const rc = capturingReceipts(); const ws = fakeWorkspaces();
  const orch = orchestratorWith("mimo-v2.5-pro", verifierFailRoles().roles, ids, rc, ws);
  await orch.run({ taskId: "t", targetRepo: "/repo", goal: "g", escalationDisabled: true }, ids.parentCtx);
  const rec = fixerReceipt(rc)!;
  assert.equal(rec.metadata.fixerModel, "mimo-v2.5-pro", "an unpinned attempt honors the operator's fixer model");
  assert.equal(rec.metadata.crossLaneAvoided, false);
});

test("provenance + cost: the fixer receipt records source→repair candidate provenance, round, checks, strategy", async () => {
  const ids = makeIdentities(); const rc = capturingReceipts(); const ws = fakeWorkspaces();
  const orch = orchestratorWith("deepseek-v4-pro", verifierFailRoles().roles, ids, rc, ws);
  await orch.run({ taskId: "t-prov", targetRepo: "/repo", goal: "g", escalationDisabled: true, moeVendorLane: "deepseek" }, ids.parentCtx);
  const m = fixerReceipt(rc)!.metadata;
  assert.equal(m.sourceTaskId, "t-prov");
  assert.equal(m.repairStrategy, "same-lane");
  assert.equal(m.repairRound, 1);
  assert.deepEqual(m.failingChecks, ["typecheck"], "the concrete failing checks are recorded");
  assert.equal(m.fixerTrigger, "verifier_fail");
  assert.equal(typeof m.costUsd, "number");
  assert.equal(m.promoted, false, "the fixer receipt never claims promotion itself");
});

// ── trigger discipline (pure) — a repair fires only from a concrete semantic verdict ──
const critic = (detail: Record<string, unknown>, outcome: RoleResult["outcome"] = "success"): RoleResult => ({ role: "critic", outcome, summary: "c", detail });
test("trigger: a concrete semantic FAIL or INCOMPLETE is retryable; indeterminate / infrastructure / bare-FAIL is NOT", () => {
  assert.equal(isRetryableCriticFail(critic({ pass: false, semanticVerdict: { kind: "fail" } })), true);
  assert.equal(isRetryableCriticFail(critic({ pass: false, semanticVerdict: { kind: "incomplete" } })), true);
  assert.equal(isRetryableCriticFail(critic({ pass: false, semanticVerdict: { kind: "indeterminate" } })), false, "an indeterminate critic must not trigger the fixer");
  assert.equal(isRetryableCriticFail(critic({ pass: false, semanticVerdict: { kind: "infrastructure-failure" } })), false, "a critic infra failure must not trigger the fixer");
  assert.equal(isRetryableCriticFail(critic({ pass: false, objectiveFailure: true })), false, "an objective fail-closed gate is not retryable");
  assert.equal(isRetryableCriticFail(critic({ pass: true, semanticVerdict: { kind: "pass" } })), false);
  // Legacy/injected critic without a stamped verdict — preserve prior pass-based behavior.
  assert.equal(isRetryableCriticFail(critic({ pass: false })), true);
});

// ── real dispatch: the fixer's PROVIDER REQUEST model equals the receipt model (selected==dispatched) ──
function greenExec() { return { run: async () => ({ executed: true as const, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) }; }
function okr(content: string): ModelResponse { return { contractVersion: "1.1.0", model: "recording", provider: "recording", providerModelId: "recording", content, finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, cost: { usd: 0.001, promptUsd: 0.001, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } }, latencyMs: 1, fellBack: false, attempts: [] }; }
function tr(name: string, args: unknown): ModelResponse { return { ...okr(""), finishReason: "tool_calls", toolCalls: [{ id: `${name}1`, name, arguments: JSON.stringify(args) }] }; }

test("real dispatch: the fixer's provider request carries the lane-valid model == the receipt model", async () => {
  const ids = makeIdentities(); const rc = capturingReceipts();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-fx-")); writeFileSync(join(dir, "a.ts"), "export const a = 1;");
  const handle: WorkspaceHandle = { id: "wsfx", targetRepo: dir, baseBranch: "main", baseRef: "H", scratchBranch: "s", path: dir, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  const ws = { workspaces: { allocate: async () => handle, promote: async (h: WorkspaceHandle): Promise<PromoteResult> => ({ promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }), discard: async (h: WorkspaceHandle): Promise<DiscardResult> => ({ workspaceId: h.id, removed: true }), commit: async () => true } };
  const builderModelsSeen: string[] = [];
  let builderTurn = 0;
  const invokeModel = async (req: ModelRequest): Promise<ModelResponse> => {
    if (typeof (req as { prompt?: unknown }).prompt === "string") return okr(JSON.stringify({ tier: "worker", rationale: "x" }));
    if (!(req.tools ?? []).some((t) => t.name === "done")) return okr(JSON.stringify({ verdict: "PASS", scores: { goal_correctness: 5 }, feedback: "ok" }));
    builderModelsSeen.push(req.model); builderTurn += 1;
    const t = ((builderTurn - 1) % 4) + 1; // each builder pass (initial + fixer) reads→writes→checks→done
    if (t === 1) return tr("read_file", { path: "a.ts" });
    if (t === 2) return tr("write_file", { path: "a.ts", content: `export const a = ${builderTurn};\n` });
    if (t === 3) return tr("run_checks", {});
    return tr("done", { successCondition: "g", filesReadBack: ["a.ts"], selfCheck: "green", satisfied: true });
  };
  let verifierCalls = 0;
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 2000, maxConcurrentRuns: 1, totalBudgetMs: 0, fixerModel: "mimo-v2.5-pro", trustLadder: false },
    resolveIdentity: ids.resolveIdentity, roleClaim: ids.roleClaim,
    // Inject the verifier RED on its FIRST call (so the fixer fires) then GREEN; builder + critic are REAL.
    roles: { verifier: async () => { verifierCalls += 1; return verifierCalls >= 2 ? { role: "verifier", outcome: "success", summary: "G", detail: { verdict: "pass", checks: [{ name: "typecheck", passed: true }], testEvidence: "executed" } } : { role: "verifier", outcome: "failure", summary: "R", detail: { checks: [{ name: "typecheck", passed: false }] } }; }, integrator: async () => ({ role: "integrator", outcome: "success", summary: "i", detail: { decision: "promote", evaluation: { approved: true } } }) },
    workspaces: ws.workspaces as unknown as NonNullable<OrchestratorDeps["workspaces"]>, trust: fakeTrust(), receipts: rc.receipts,
    events: noopBus() as unknown as NonNullable<OrchestratorDeps["events"]>, gateWall: allowGate, invokeModel, governedExec: greenExec(), builderModel: "deepseek-v4-flash",
    killCheck: async () => ({ killed: false }),
  });
  await orch.run({ taskId: "t-real", targetRepo: dir, goal: "do the thing", escalationDisabled: true, moeVendorLane: "deepseek" }, ids.parentCtx);
  const rec = fixerReceipt(rc);
  assert.ok(rec !== undefined, "the fixer ran + receipted");
  const dispatched = rec!.metadata.fixerModel as string;
  assert.ok(dispatched.startsWith("deepseek"), `the fixer dispatched an in-lane model, got ${dispatched}`);
  assert.ok(builderModelsSeen.includes(dispatched), "the fixer's PROVIDER REQUEST carried exactly the receipt's fixer model");
  assert.ok(!builderModelsSeen.some((m) => m.startsWith("mimo")), "no MiMo model was ever dispatched inside the deepseek attempt");
});

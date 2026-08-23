/**
 * PHASE 11B — LEDGER AS EXECUTION AUTHORITY (IKBI-REAUDIT-002 completion).
 *
 * Closes the Phase 11 boundaries: the candidate critic is ATTEMPT-BOUND and lane-enforced (not task-level
 * lane-neutral); an attempt-bound out-of-lane dispatch is BLOCKED before the provider runs (not merely
 * observed via `laneViolation`); a lane with no valid critic fails the attempt CLOSED before dispatch; and
 * execution role receipts REFERENCE their authoritative ledger invocation record + derive their model from it.
 *
 * The pure pre/post lane-enforcement guards live in invocation-ledger-conformance.test.ts (B6/B6b); these are
 * the real orchestrator seam. Retained mutation guards — see HANDOFF-PHASE-11B-LEDGER-AUTHORITY.md.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { labTempDir as tmpdir } from "../../core/temp-root.js";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";
import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { OperationContext, ValidatedIdentity } from "../../core/identity/resolver.js";
import type { EventBusSurface, EventInput, IkbiEvent } from "../../core/events/index.js";
import { autonomyForTier, asTier, TRUST_FLOOR, type TrustDecision } from "../../core/trust/index.js";
import type { DiscardResult, PromoteGovernance, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import type { RoleFn } from "./contract.js";

const silent = () => pino({ level: "silent" });
function makeIdentities() {
  const agents = [
    { agentId: "parent-1", kind: "agent" as const, functionalRole: "lead", defaultTrustTier: "trusted", tokenHashes: [hashToken("parent-secret")] },
    { agentId: "worker-1", kind: "agent" as const, functionalRole: "worker", defaultTrustTier: "trusted", tokenHashes: [hashToken("worker-secret")] },
  ];
  const resolver = new IdentityResolver({ registry: new AgentRegistry({ agents }), logger: silent(), now: () => 1000 });
  const parentCtx: OperationContext = beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
  const resolveIdentity: NonNullable<OrchestratorDeps["resolveIdentity"]> = (claim, c) => resolver.resolve(claim, c);
  const roleClaim: NonNullable<OrchestratorDeps["roleClaim"]> = () => ({ token: "worker-secret" });
  return { parentCtx, resolveIdentity, roleClaim };
}
const fakeBus: EventBusSurface = {
  publish: <P>(input: EventInput<P>): IkbiEvent<P> => ({ ...input, contractVersion: "1.0.0", id: "e", seq: 1, timestamp: 0 } as IkbiEvent<P>),
  subscribe: () => ({ id: "s", unsubscribe: () => {}, stats: () => ({ delivered: 0, dropped: 0, failures: 0, queued: 0 }) }),
  flush: async () => {},
};
function capturingReceipts() {
  const appended: Array<{ operation: string; metadata: Record<string, unknown> }> = [];
  const receipts = { append: async (input: unknown): Promise<unknown> => { const r = input as { operation: string; metadata?: Record<string, unknown> }; appended.push({ operation: r.operation, metadata: r.metadata ?? {} }); return {}; } };
  return { receipts, appended };
}
const stubTrust = { recordOutcome: async (i: { agentId: string; defaultTrustTier: string }, _s: ValidatedIdentity): Promise<TrustDecision> => { const tier = asTier(i.defaultTrustTier, TRUST_FLOOR); return { agentId: i.agentId, tier, previousTier: tier, autonomy: autonomyForTier(tier) }; } };
function modelResp(content: string, model: string, cost = 0.001): ModelResponse {
  return { contractVersion: "1.1.0", model, provider: model.split("-")[0]!, providerModelId: model, content, finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, cost: { usd: cost, promptUsd: cost, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } }, latencyMs: 1, fellBack: false, attempts: [] };
}
function toolResp(name: string, args: unknown, model: string): ModelResponse { return { ...modelResp("", model), finishReason: "tool_calls", toolCalls: [{ id: `${name}1`, name, arguments: JSON.stringify(args) }] }; }
const CRITIC_PASS = JSON.stringify({ schemaVersion: 1, verdict: "pass", summary: "correct and complete", blockingDefects: [], missingRequirements: [], advisories: [] });
/** A provider that ECHOES the requested model (a faithful provider serves what was asked). Handles the
 *  builder tool loop, the scout (a general findings call), and the real critic (a pass verdict). */
function echoProvider(): (r: ModelRequest) => Promise<ModelResponse> {
  let builderTurn = 0;
  return async (req: ModelRequest): Promise<ModelResponse> => {
    const model = req.model ?? "unknown";
    if (typeof (req as { prompt?: unknown }).prompt === "string") return modelResp(JSON.stringify({ tier: "worker", rationale: "x" }), model);
    const tools = req.tools ?? [];
    if (tools.some((t) => t.name === "done")) {
      builderTurn += 1;
      if (builderTurn === 1) return toolResp("read_file", { path: "a.ts" }, model);
      if (builderTurn === 2) return toolResp("write_file", { path: "a.ts", content: "export const a = 2;\n" }, model);
      if (builderTurn === 3) return toolResp("run_checks", {}, model);
      return toolResp("done", { successCondition: "do it", filesReadBack: ["a.ts"], selfCheck: "green", satisfied: true }, model);
    }
    // A messages request with no `done` tool = the critic (returns a pass verdict) or scout (findings text).
    return modelResp(CRITIC_PASS, model);
  };
}
const execVerifier: RoleFn = async () => ({ role: "verifier", outcome: "success", summary: "green", detail: { verdict: "pass", checks: [{ name: "test", command: "pnpm test", exitCode: 0, testCount: { passed: 1, total: 1 } }] } });
const promoteIntegrator: RoleFn = async () => ({ role: "integrator", outcome: "success", summary: "p", detail: { decision: "promote", rationale: "s", evaluation: { approved: true } } });
function gitInit(dir: string): void {
  const g = (...a: string[]): string => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g("init", "-q"); writeFileSync(join(dir, "a.ts"), "export const a = 1;"); g("add", "-A"); g("commit", "-q", "-m", "base");
}
/** A REAL-critic run (critic not injected → the orchestrator's lane-valid critic + ledger enforcement apply). */
function realCriticRun(opts: { mid: readonly string[]; vendorLane: string; builderModelOverride: string; criticOverride?: string }) {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const rc = capturingReceipts();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-p11b-"));
  gitInit(dir);
  const handle: WorkspaceHandle = { id: "wsp11b", targetRepo: dir, baseBranch: "main", baseRef: "HEAD", scratchBranch: "s", path: dir, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 2000, maxConcurrentRuns: 1, trustLadder: true },
    workspaces: {
      allocate: async () => handle,
      diff: async () => "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n-export const a = 1;\n+export const a = 2;\n",
      promote: async (h): Promise<PromoteResult> => ({ promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }),
      discard: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: true }),
      retain: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: false }),
      commit: async () => true,
    },
    events: fakeBus, receipts: rc.receipts, trust: stubTrust, resolveIdentity, roleClaim,
    roles: { verifier: execVerifier, integrator: promoteIntegrator }, // critic is REAL (not injected)
    invokeModel: echoProvider(), governedExec: { run: async () => ({ executed: true as const, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) },
    builderModel: opts.builderModelOverride,
    escalationTierModels: { worker: [opts.builderModelOverride], mid: opts.mid, frontier: opts.mid },
    gateWall: { evaluate: async (): Promise<PromoteGovernance> => ({ allow: true, reason: "ok" }) },
  });
  const task = { taskId: `build:${opts.vendorLane}`, targetRepo: "/unused", goal: "do the thing", moeExpertRental: true, moeVendorLane: opts.vendorLane, builderModelOverride: opts.builderModelOverride, ...(opts.criticOverride !== undefined ? { criticModelOverride: opts.criticOverride } : {}) };
  return { run: () => orch.run(task, parentCtx), receipts: rc.appended };
}

test("P1 [MUTATION: critic lane-neutral] (req 1,2,11,16,21): the candidate critic is ATTEMPT-BOUND, runs a LANE-VALID model, and its receipt references its ledger invocation", async () => {
  // deepseek-lane attempt: the mid roster has a deepseek critic; the critic must run it (in-lane).
  const h = realCriticRun({ vendorLane: "deepseek", builderModelOverride: "deepseek-v4-flash", mid: ["deepseek-v4-pro", "mimo-v2.5-pro"], criticOverride: "mimo-v2.5-pro" /* an out-of-lane operator preset must NOT be used */ });
  const result = await h.run();
  assert.equal(result.promoted, true, "the run promotes (the critic ran in-lane, no violation/block)");
  const criticReceipt = h.receipts.find((r) => r.operation === "worker.role.critic");
  assert.ok(criticReceipt !== undefined, "a critic role receipt was written");
  assert.ok(String(criticReceipt!.metadata.model).startsWith("deepseek"), `the critic ran a deepseek-lane model, not the cross-lane operator preset (got ${criticReceipt!.metadata.model})`);
  assert.ok(typeof criticReceipt!.metadata.invocationId === "string", "the critic receipt references its ledger invocation id");
});

test("P2 (req 19,21): the builder role receipt references its ledger invocation + names the DISPATCHED lane model", async () => {
  const h = realCriticRun({ vendorLane: "deepseek", builderModelOverride: "deepseek-v4-flash", mid: ["deepseek-v4-pro"] });
  await h.run();
  const builderReceipt = h.receipts.find((r) => r.operation === "worker.role.builder");
  assert.ok(builderReceipt !== undefined);
  assert.equal(builderReceipt!.metadata.model, "deepseek-v4-flash", "the receipt names the dispatched lane model (from the ledger)");
  assert.ok(typeof builderReceipt!.metadata.invocationId === "string", "the builder receipt references its ledger invocation id");
});

test("P3 [MUTATION: no critic-lane guard] (req 6,14): a lane with NO valid critic model fails the attempt CLOSED before dispatch (lane-config error, no promotion)", async () => {
  // mimo-lane attempt but the mid roster has ONLY deepseek → no in-lane critic → config error before dispatch.
  // The operator critic preset is pinned OUT of the lane explicitly: without it this fixture inherits
  // the ambient `criticModel()` default, and once 043d667 made that default `mimo-v2.5-pro` the mimo
  // lane silently HAD an in-lane critic — so the guard correctly did not fire and the test, not the
  // code, was wrong. Pinning it keeps the case hermetic and keeps pinning the real invariant.
  const h = realCriticRun({ vendorLane: "mimo", builderModelOverride: "mimo-v2.5", mid: ["deepseek-v4-pro"], criticOverride: "deepseek-v4-pro" });
  const result = await h.run();
  assert.equal(result.promoted, false, "no lane-valid critic → never promotes");
  assert.equal(result.outcome, "rejected");
  assert.match(result.reason ?? "", /lane-config/);
  const err = h.receipts.find((r) => r.operation === "worker.lane_config_error");
  assert.ok(err !== undefined && err.metadata.missing === "critic", "the config error names the missing critic model");
  // Fail-closed BEFORE dispatch: not a candidate defect, no promotion receipt.
  assert.ok(!h.receipts.some((r) => r.operation === "worker.promotion"), "no promotion is attempted");
});

test("P4 (req 10): a lane-pinned run still COMPLETES — the general SCOUT is task-level lane-neutral (not blocked by lane enforcement)", async () => {
  // The scout runs the configured driver model (which may be cross-lane); classifying it lane-neutral means it
  // is NOT blocked. If the scout were lane-enforced with an out-of-lane driver, the run would fail instead.
  const h = realCriticRun({ vendorLane: "deepseek", builderModelOverride: "deepseek-v4-flash", mid: ["deepseek-v4-pro"] });
  const result = await h.run();
  assert.equal(result.promoted, true, "the run completes — the general scout is lane-neutral (task-level analysis)");
});

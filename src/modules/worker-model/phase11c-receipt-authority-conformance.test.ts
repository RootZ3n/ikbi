/**
 * PHASE 11C — RECEIPT AUTHORITY: EXECUTION RECEIPTS DERIVE FROM THE INVOCATION LEDGER.
 *
 * The Phase 11C invariant: every receipt that CLAIMS a provider/model executed must reference the
 * authoritative invocation record describing that execution, and must DERIVE its execution identity
 * (invocation id, served model, provider, vendor lane, lifecycle, usage, cost, cost status) from that
 * ledger record — it may never independently invent or restamp any of them, nor fall back to a
 * configured/selected model when the ledger says something else (or nothing) ran.
 *
 * This closes the seams Phase 11/11B left: the critic-recovery receipt, the fixer receipt, and the
 * tournament/competitive per-role + aggregate receipts. A missing invocation is FAIL-CLOSED (an explicit
 * integrity-error receipt, never a fabricated id or a config fallback). Several tests double as MUTATION
 * GUARDS — see HANDOFF-PHASE-11C-RECEIPT-AUTHORITY.md for the 6 enumerated reverts.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { labTempDir as tmpdir } from "../../core/temp-root.js";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";
import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { OperationContext, ValidatedIdentity } from "../../core/identity/resolver.js";
import type { EventBusSurface, EventInput, IkbiEvent } from "../../core/events/index.js";
import { autonomyForTier, asTier, TRUST_FLOOR, type TrustDecision } from "../../core/trust/index.js";
import type { DiscardResult, PromoteGovernance, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import { InvocationLedger } from "./invocation-ledger.js";
import { neutralizeUntrusted as coreNeutralize } from "../../core/injection/index.js";
import { parseSemanticVerdict } from "./semantic-verdict.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import type { RoleFn, WorkerRole } from "./contract.js";

// ── shared doubles ──────────────────────────────────────────────────────────────────────────────
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
  const receipts = { append: async (input: unknown, _id: AgentIdentity): Promise<unknown> => { const r = input as { operation: string; metadata?: Record<string, unknown> }; appended.push({ operation: r.operation, metadata: r.metadata ?? {} }); return {}; } };
  return { receipts, appended };
}
const stubTrust = { recordOutcome: async (i: { agentId: string; defaultTrustTier: string }, _s: ValidatedIdentity): Promise<TrustDecision> => { const tier = asTier(i.defaultTrustTier, TRUST_FLOOR); return { agentId: i.agentId, tier, previousTier: tier, autonomy: autonomyForTier(tier) }; } };
const allowGate: NonNullable<OrchestratorDeps["gateWall"]> = { evaluate: async (): Promise<PromoteGovernance> => ({ allow: true, reason: "ok" }) };
const greenExec = { run: async () => ({ executed: true as const, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) };

/** An echoing provider response — a faithful provider serves the model it was asked for. */
function resp(content: string, model: string, costUsd = 0.001, finishReason: ModelResponse["finishReason"] = "stop"): ModelResponse {
  return { contractVersion: "1.1.0", model, provider: model.split("-")[0]!, providerModelId: model, content, finishReason, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, cost: { usd: costUsd, promptUsd: costUsd, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } }, latencyMs: 1, fellBack: false, attempts: [] };
}
function toolResp(name: string, args: unknown, model: string): ModelResponse { return { ...resp("", model), finishReason: "tool_calls", toolCalls: [{ id: `${name}1`, name, arguments: JSON.stringify(args) }] }; }
const CRITIC_PASS = JSON.stringify({ schemaVersion: 1, verdict: "pass", summary: "correct and complete", blockingDefects: [], missingRequirements: [], advisories: [] });
function gitInit(dir: string): string {
  const g = (...a: string[]): string => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g("init", "-q"); writeFileSync(join(dir, "a.ts"), "export const a = 1;"); g("add", "-A"); g("commit", "-q", "-m", "base");
  return g("rev-parse", "HEAD").trim();
}
const execVerifier: RoleFn = async () => ({ role: "verifier", outcome: "success", summary: "green", detail: { verdict: "pass", checks: [{ name: "test", command: "pnpm test", exitCode: 0, testCount: { passed: 1, total: 1 } }], testEvidence: "executed" } });
const promoteIntegrator: RoleFn = async () => ({ role: "integrator", outcome: "success", summary: "p", detail: { decision: "promote", rationale: "s", evaluation: { approved: true } } });
const find = (rs: Array<{ operation: string; metadata: Record<string, unknown> }>, op: string) => rs.find((r) => r.operation === op);
const all = (rs: Array<{ operation: string; metadata: Record<string, unknown> }>, op: string) => rs.filter((r) => r.operation === op);

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Part A — CRITIC-RECOVERY receipt derives from the structured-recovery invocation record
// ══════════════════════════════════════════════════════════════════════════════════════════════

/** A single-path (normal) run with a REAL critic. `criticScript` supplies the critic's model outputs. */
function recoveryRun(criticScript: string[], opts: { cost?: number } = {}) {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const rc = capturingReceipts();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-p11c-rec-"));
  const baseRef = gitInit(dir);
  const handle: WorkspaceHandle = { id: "wsrec", targetRepo: dir, baseBranch: "main", baseRef, scratchBranch: "s", path: dir, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  let criticCall = 0;
  const builderTurns = new Map<string, number>();
  const invokeModel = async (req: ModelRequest): Promise<ModelResponse> => {
    const model = req.model ?? "unknown";
    if (typeof (req as { prompt?: unknown }).prompt === "string") return resp(JSON.stringify({ tier: "worker", rationale: "x" }), model);
    const tools = req.tools ?? [];
    if (tools.some((t) => t.name === "done")) {
      const n = (builderTurns.get(model) ?? 0) + 1; builderTurns.set(model, n);
      if (n === 1) return toolResp("read_file", { path: "a.ts" }, model);
      if (n === 2) return toolResp("write_file", { path: "a.ts", content: "export const a = 2;\n" }, model);
      if (n === 3) return toolResp("run_checks", {}, model);
      return toolResp("done", { successCondition: "do it", filesReadBack: ["a.ts"], selfCheck: "green", satisfied: true }, model);
    }
    // A messages request with no `done` tool = the REAL critic (scout is injected below).
    const out = criticScript[Math.min(criticCall, criticScript.length - 1)]!; criticCall += 1;
    return resp(out, model, opts.cost ?? 0.002);
  };
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 2000, maxConcurrentRuns: 1, trustLadder: false },
    workspaces: {
      allocate: async () => handle,
      diff: async () => "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n-export const a = 1;\n+export const a = 2;\n",
      promote: async (h): Promise<PromoteResult> => ({ promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }),
      discard: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: true }),
      retain: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: false }),
      commit: async () => true,
    },
    events: fakeBus, receipts: rc.receipts, trust: stubTrust, resolveIdentity, roleClaim,
    roles: { scout: async () => ({ role: "scout", outcome: "success", summary: "s" }), verifier: execVerifier, integrator: promoteIntegrator }, // critic + builder are REAL
    invokeModel, governedExec: greenExec, builderModel: "deepseek-v4-flash",
    escalationTierModels: { worker: ["deepseek-v4-flash"], mid: ["deepseek-v4-pro"], frontier: ["deepseek-v4-pro"] },
    gateWall: allowGate,
  });
  const task = { taskId: "build:deepseek", targetRepo: "/unused", goal: "do the thing", moeExpertRental: true, moeVendorLane: "deepseek", builderModelOverride: "deepseek-v4-flash", criticModelOverride: "deepseek-v4-pro" };
  return { run: () => orch.run(task, parentCtx), receipts: rc.appended };
}
const rawMalformed = JSON.stringify({ verdict: "REJECT", blockingDefects: [{ claim: "server.ts references `db` but never imports it — ReferenceError", requirement: "return users", evidence: "db used without import" }] });

test("A1 (recovery references its ACTUAL invocation): a dispatched structured-recovery emits worker.critic_recovery bound to the ledger's recovery invocation id", async () => {
  // Malformed-recoverable critic → one in-lane recovery call (dispatched, recorded) → rejected recovery.
  const h = recoveryRun([rawMalformed, "still nonsense, no verdict"]);
  await h.run();
  const rec = find(h.receipts, "worker.critic_recovery");
  assert.ok(rec !== undefined, "a worker.critic_recovery receipt was written for the dispatched recovery");
  assert.equal(typeof rec!.metadata.invocationId, "string", "the receipt references a ledger invocation id");
  assert.match(String(rec!.metadata.invocationId), /:critic:structured-recovery:/, "the id is the authoritative structured-recovery ledger record (not fabricated)");
  assert.ok(find(h.receipts, "worker.critic_recovery.integrity_error") === undefined, "a real invocation is NOT an integrity error");
});

test("A2 (recovery model/provider/lane/lifecycle/cost DERIVE from the invocation): every execution field matches what the provider served in-lane", async () => {
  const h = recoveryRun([rawMalformed, "still nonsense"], { cost: 0.003 });
  await h.run();
  const m = find(h.receipts, "worker.critic_recovery")!.metadata;
  assert.equal(m.servedModel, "deepseek-v4-pro", "servedModel == the model the provider actually served (resolvedModel)");
  assert.equal(m.recoveryModel, "deepseek-v4-pro", "recoveryModel derives from the invocation, not config");
  assert.equal(m.provider, "deepseek", "provider derives from the invocation");
  assert.equal(m.vendorLane, "deepseek", "the recovery stayed in the attempt lane (from the invocation context)");
  assert.equal(m.costUsd, 0.003, "cost derives from the invocation record");
  assert.equal(m.costStatus, "measured", "cost status derives from the invocation record");
  assert.equal(typeof m.lifecycle, "string", "the invocation lifecycle status is carried");
});

test("A3 [MUTATION 1] (recovery NOT dispatched ⇒ NO execution claim): a clean critic pass emits no worker.critic_recovery at all", async () => {
  // No malformed output → recovery never runs → there must be NO recovery execution receipt to link.
  const h = recoveryRun([CRITIC_PASS]);
  const result = await h.run();
  assert.equal(result.promoted, true, "a clean pass promotes");
  assert.ok(find(h.receipts, "worker.critic_recovery") === undefined, "no recovery ran → no recovery receipt is invented");
  assert.ok(find(h.receipts, "worker.critic_recovery.integrity_error") === undefined, "and no integrity error either — recovery simply did not happen");
});

test("A4 [MUTATION 5] (missing invocation is FAIL-CLOSED): a critic that CLAIMS recovery with no ledger record yields an integrity-error receipt, never a fabricated id or config fallback", async () => {
  // Inject a critic that reports recoveryInvoked=true but makes NO engine call (no ledger record). The
  // indeterminate verdict is not fixer-eligible, so this isolates the missing-linkage path cleanly.
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const rc = capturingReceipts();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-p11c-integ-"));
  const baseRef = gitInit(dir);
  const handle: WorkspaceHandle = { id: "wsintg", targetRepo: dir, baseBranch: "main", baseRef, scratchBranch: "s", path: dir, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  const claimedRecoveryCritic: RoleFn = async () => ({ role: "critic", outcome: "success", summary: "FAIL", detail: { pass: false, semanticVerdict: { kind: "indeterminate", summary: "unparseable", blockingDefects: [], incompleteRequirements: [], advisories: [], candidateId: "build:deepseek" }, recoveryInvoked: true, recoveryOutcome: "repaired", rawOutputHash: "h" } });
  let builderTurn = 0;
  const invokeModel = async (req: ModelRequest): Promise<ModelResponse> => {
    const model = req.model ?? "m";
    if (typeof (req as { prompt?: unknown }).prompt === "string") return resp(JSON.stringify({ tier: "worker", rationale: "x" }), model);
    builderTurn += 1;
    if (builderTurn === 1) return toolResp("read_file", { path: "a.ts" }, model);
    if (builderTurn === 2) return toolResp("write_file", { path: "a.ts", content: "export const a = 2;\n" }, model);
    if (builderTurn === 3) return toolResp("run_checks", {}, model);
    return toolResp("done", { successCondition: "x", filesReadBack: ["a.ts"], selfCheck: "green", satisfied: true }, model);
  };
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 2000, maxConcurrentRuns: 1, trustLadder: false },
    workspaces: { allocate: async () => handle, diff: async () => "d", promote: async (hh): Promise<PromoteResult> => ({ promoted: true, workspaceId: hh.id, targetBranch: hh.baseBranch, beforeRef: "a", afterRef: "b" }), discard: async (hh): Promise<DiscardResult> => ({ workspaceId: hh.id, removed: true }), retain: async (hh): Promise<DiscardResult> => ({ workspaceId: hh.id, removed: false }), commit: async () => true },
    events: fakeBus, receipts: rc.receipts, trust: stubTrust, resolveIdentity, roleClaim,
    roles: { scout: async () => ({ role: "scout", outcome: "success", summary: "s" }), verifier: execVerifier, critic: claimedRecoveryCritic, integrator: promoteIntegrator },
    invokeModel, governedExec: greenExec, builderModel: "deepseek-v4-flash", gateWall: allowGate,
  });
  await orch.run({ taskId: "build:deepseek", targetRepo: "/unused", goal: "g", moeExpertRental: true, moeVendorLane: "deepseek" }, parentCtx);
  const integ = find(rc.appended, "worker.critic_recovery.integrity_error");
  assert.ok(integ !== undefined, "a claimed-but-unbacked recovery emits an explicit integrity-error receipt");
  assert.equal(integ!.metadata.integrityError, "recovery-invocation-not-found");
  const good = find(rc.appended, "worker.critic_recovery");
  assert.ok(good === undefined, "NO ordinary recovery receipt is fabricated with a config-derived model/id");
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Part B — FIXER receipt derives from the fixer-staged invocation record(s)
// ══════════════════════════════════════════════════════════════════════════════════════════════

/** A run where the injected verifier is RED then GREEN (so the last-mile fixer fires), builder is REAL. */
function fixerRun(fixerModel: string, vendorLane?: string) {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const rc = capturingReceipts();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-p11c-fx-"));
  const baseRef = gitInit(dir);
  const handle: WorkspaceHandle = { id: "wsfx", targetRepo: dir, baseBranch: "main", baseRef, scratchBranch: "s", path: dir, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  const builderModelsSeen: string[] = [];
  let builderTurn = 0;
  const invokeModel = async (req: ModelRequest): Promise<ModelResponse> => {
    const model = req.model ?? "m";
    if (typeof (req as { prompt?: unknown }).prompt === "string") return resp(JSON.stringify({ tier: "worker", rationale: "x" }), model);
    if (!(req.tools ?? []).some((t) => t.name === "done")) return resp(CRITIC_PASS, model);
    builderModelsSeen.push(model); builderTurn += 1;
    const t = ((builderTurn - 1) % 4) + 1; // each builder pass: read→write→checks→done
    if (t === 1) return toolResp("read_file", { path: "a.ts" }, model);
    if (t === 2) return toolResp("write_file", { path: "a.ts", content: `export const a = ${builderTurn};\n` }, model);
    if (t === 3) return toolResp("run_checks", {}, model);
    return toolResp("done", { successCondition: "g", filesReadBack: ["a.ts"], selfCheck: "green", satisfied: true }, model);
  };
  let verifierCalls = 0;
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 2000, maxConcurrentRuns: 1, fixerModel, trustLadder: false },
    workspaces: { allocate: async () => handle, diff: async () => "d", promote: async (h): Promise<PromoteResult> => ({ promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }), discard: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: true }), commit: async () => true },
    events: fakeBus, receipts: rc.receipts, trust: stubTrust, resolveIdentity, roleClaim,
    roles: { verifier: async () => { verifierCalls += 1; return verifierCalls >= 2 ? { role: "verifier", outcome: "success", summary: "G", detail: { verdict: "pass", checks: [{ name: "typecheck", passed: true }], testEvidence: "executed" } } : { role: "verifier", outcome: "failure", summary: "R", detail: { checks: [{ name: "typecheck", passed: false }] } }; }, integrator: promoteIntegrator },
    invokeModel, governedExec: greenExec, builderModel: "deepseek-v4-flash", gateWall: allowGate,
  });
  return { run: () => orch.run({ taskId: "t-fx", targetRepo: dir, goal: "do the thing", escalationDisabled: true, ...(vendorLane !== undefined ? { moeVendorLane: vendorLane } : {}) }, parentCtx), receipts: rc.appended, builderModelsSeen };
}

test("B1 (fixer references its ACTUAL invocation): the worker.fixer receipt links the fixer-staged ledger invocation id(s)", async () => {
  const h = fixerRun("deepseek-v4-pro", "deepseek");
  await h.run();
  const rec = find(h.receipts, "worker.fixer");
  assert.ok(rec !== undefined, "a worker.fixer receipt was written");
  assert.equal(rec!.metadata.executionLinked, true, "the fixer dispatched a provider call and the receipt links it");
  assert.match(String(rec!.metadata.invocationId), /:builder:fixer:/, "the primary invocation id is the authoritative fixer-staged ledger record");
  assert.ok(Array.isArray(rec!.metadata.invocationIds) && (rec!.metadata.invocationIds as string[]).length >= 1, "all fixer invocations are referenced in order");
});

test("B2 (fixer execution identity DERIVES from the invocation): served model + cost status come from the ledger, model/dispatched stay the SELECTED lane model", async () => {
  const h = fixerRun("deepseek-v4-pro", "deepseek");
  await h.run();
  const m = find(h.receipts, "worker.fixer")!.metadata;
  assert.ok(String(m.servedModel).startsWith("deepseek"), "servedModel is the model the provider served (from the ledger)");
  assert.ok(h.builderModelsSeen.includes(String(m.servedModel)), "the served model was ACTUALLY dispatched to the provider");
  assert.equal(m.dispatchedModel, m.fixerModel, "the dispatched field stays the selected lane model (Phase 1/6 dispatched==receipt)");
  assert.ok(m.ledgerCostStatus === "complete" || m.ledgerCostStatus === "partial", "the cost status is derived from the ledger records");
});

test("B3 [MUTATION 2] (fixer cannot stamp config.fixerModel when another model executed): a cross-lane config.fixerModel never becomes the served/executed model", async () => {
  // config.fixerModel is MiMo but the attempt is deepseek-lane → the in-lane model is dispatched + served.
  const h = fixerRun("mimo-v2.5-pro", "deepseek");
  await h.run();
  const m = find(h.receipts, "worker.fixer")!.metadata;
  assert.notEqual(m.fixerModel, "mimo-v2.5-pro", "the cross-lane config model is NOT stamped as the fixer model");
  assert.ok(String(m.servedModel).startsWith("deepseek"), "the SERVED model (ledger truth) is in-lane, never the config MiMo model");
  assert.ok(!h.builderModelsSeen.some((x) => x.startsWith("mimo")), "no MiMo model was ever dispatched inside the deepseek attempt");
  assert.equal(m.crossLaneAvoided, true, "the receipt records that the cross-lane config model was avoided");
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Part C — TOURNAMENT: per-role receipts reference their own invocation; the aggregate references all
// ══════════════════════════════════════════════════════════════════════════════════════════════

function realWorkspaces() {
  const allocated: string[] = []; const promoted: string[] = []; const discarded: string[] = [];
  let i = 0;
  const workspaces: NonNullable<OrchestratorDeps["workspaces"]> = {
    allocate: async () => { const id = `ws${i++}`; const path = mkdtempSync(join(tmpdir(), `ikbi-p11c-${id}-`)); allocated.push(id); return { id, targetRepo: "/repo", baseBranch: "main", baseRef: "deadbeef", scratchBranch: `ikbi/ws/${id}`, path, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 }; },
    promote: async (h): Promise<PromoteResult> => { promoted.push(h.id); return { promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }; },
    discard: async (h): Promise<DiscardResult> => { discarded.push(h.id); return { workspaceId: h.id, removed: true }; },
    retain: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: false }),
    diff: async (h) => `diff for ${h.id}\nline2`,
    commit: async () => true,
  };
  return { workspaces, allocated, promoted, discarded };
}
/** A per-candidate builder driver: each model runs its own write→run_checks→done sequence. */
function candidateBuilderDriver() {
  const captured: string[] = [];
  const turnByModel = new Map<string, number>();
  const invokeModel: NonNullable<OrchestratorDeps["invokeModel"]> = async (req) => {
    const m = req.model; captured.push(m);
    const t = (turnByModel.get(m) ?? 0) + 1; turnByModel.set(m, t);
    if (t === 1) return toolResp("write_file", { path: "a.ts", content: "export const x = 1;\n" }, m);
    if (t === 2) return toolResp("run_checks", {}, m);
    return toolResp("done", { successCondition: "x", filesReadBack: ["a.ts"], selfCheck: "ran checks green", satisfied: true }, m);
  };
  return { invokeModel, captured };
}
const nonBuilderRoles: Partial<Record<WorkerRole, RoleFn>> = {
  scout: async () => ({ role: "scout", outcome: "success", summary: "s" }),
  critic: async () => ({ role: "critic", outcome: "success", summary: "c", detail: { pass: true } }),
  verifier: async () => ({ role: "verifier", outcome: "success", summary: "v", detail: { verdict: "pass", checks: [{ name: "test", command: "pnpm test", exitCode: 0, testCount: { passed: 1, total: 1 } }], testEvidence: "executed" } }),
  integrator: promoteIntegrator,
};
function tournamentRun(candidateModels: readonly string[]) {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const rc = capturingReceipts();
  const ws = realWorkspaces();
  const drv = candidateBuilderDriver();
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 2000, maxConcurrentRuns: 1, trustLadder: false },
    workspaces: ws.workspaces, events: fakeBus, receipts: rc.receipts, trust: stubTrust, resolveIdentity, roleClaim,
    roles: nonBuilderRoles, invokeModel: drv.invokeModel, governedExec: greenExec, builderModel: "base-model",
    candidateModels, applyDiff: async () => ({ applied: true }), gateWall: allowGate,
  });
  return { run: () => orch.run({ taskId: "t-tour", targetRepo: "/repo", goal: "do the thing" }, parentCtx), receipts: rc.appended, captured: drv.captured };
}

test("C1 (every tournament candidate builder references its OWN invocation with its OWN model): no single model is stamped on all", async () => {
  const h = tournamentRun(["model-a", "model-b"]);
  const result = await h.run();
  assert.equal(result.promoted, true);
  const builders = all(h.receipts, "worker.role.builder");
  assert.ok(builders.length >= 2, "each candidate wrote a builder role receipt");
  const models = new Set(builders.map((b) => String(b.metadata.model)));
  assert.ok(models.has("model-a") && models.has("model-b"), `each builder receipt names ITS candidate model (got ${[...models].join(",")})`);
  for (const b of builders) assert.match(String(b.metadata.invocationId), /:builder:candidate-role:/, "the receipt references its authoritative candidate ledger invocation");
});

test("C2 (the aggregate worker.tournament receipt references EVERY executed invocation once): ordered ids, no double-count, derived cost status", async () => {
  const h = tournamentRun(["model-a", "model-b"]);
  await h.run();
  const agg = find(h.receipts, "worker.tournament");
  assert.ok(agg !== undefined, "an aggregate worker.tournament receipt was written");
  const ids = agg!.metadata.invocationIds as string[];
  assert.ok(Array.isArray(ids) && ids.length > 0, "the aggregate references the executed invocations");
  assert.equal(new Set(ids).size, ids.length, "each invocation appears exactly once (no double-count)");
  assert.equal(ids.length, agg!.metadata.invocationCount, "the id set size equals the executed invocation count");
  assert.ok(agg!.metadata.costStatus === "complete" || agg!.metadata.costStatus === "partial", "aggregate cost status derives from the unique records");
});

test("C3 [MUTATION 3] (tournament does NOT stamp one model for all): the per-candidate models are distinct across the receipts", async () => {
  const h = tournamentRun(["model-a", "model-b"]);
  await h.run();
  const builders = all(h.receipts, "worker.role.builder");
  const models = builders.map((b) => String(b.metadata.model));
  assert.equal(new Set(models).size, 2, "the two candidates recorded DISTINCT executed models, not one winner/default stamped on both");
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Part D — COMPETITIVE: each candidate role receipt references its own invocation
// ══════════════════════════════════════════════════════════════════════════════════════════════

function competitiveRun(competitiveModels: readonly string[]) {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const rc = capturingReceipts();
  const ws = realWorkspaces();
  const drv = candidateBuilderDriver();
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 2000, maxConcurrentRuns: 1, competitive: true, competitiveN: competitiveModels.length, trustLadder: false },
    workspaces: ws.workspaces, events: fakeBus, receipts: rc.receipts, trust: stubTrust, resolveIdentity, roleClaim,
    roles: nonBuilderRoles, invokeModel: drv.invokeModel, governedExec: greenExec, builderModel: "base-model",
    competitiveModels, gateWall: allowGate,
  });
  return { run: () => orch.run({ taskId: "t-comp", targetRepo: "/repo", goal: "do the thing" }, parentCtx), receipts: rc.appended, discarded: ws.discarded };
}

test("D1 (every competitive candidate builder references its OWN invocation with its OWN model)", async () => {
  const h = competitiveRun(["model-a", "model-b"]);
  const result = await h.run();
  assert.equal(result.promoted, true);
  const builders = all(h.receipts, "worker.role.builder");
  assert.ok(builders.length >= 2);
  const models = new Set(builders.map((b) => String(b.metadata.model)));
  assert.ok(models.has("model-a") && models.has("model-b"), `each competitive builder receipt names ITS model (got ${[...models].join(",")})`);
  for (const b of builders) assert.match(String(b.metadata.invocationId), /:builder:candidate-role:/, "references its authoritative candidate ledger invocation");
});

test("D2 [MUTATION 4] (the winner's identity does NOT overwrite the loser's role receipt): the losing candidate keeps its own executed model", async () => {
  const h = competitiveRun(["model-a", "model-b"]);
  await h.run();
  const builders = all(h.receipts, "worker.role.builder");
  const models = builders.map((b) => String(b.metadata.model)).sort();
  assert.deepEqual(models, ["model-a", "model-b"], "both candidates' OWN models are receipted — the winner is not stamped on both");
  const ids = builders.map((b) => String(b.metadata.invocationId));
  assert.equal(new Set(ids).size, ids.length, "the candidate builder invocation ids are distinct");
});

test("D3 (competitive per-role invocation ids are distinct across candidates and roles)", async () => {
  const h = competitiveRun(["model-a", "model-b"]);
  await h.run();
  const linked = h.receipts.filter((r) => r.operation.startsWith("worker.role.") && typeof r.metadata.invocationId === "string");
  const ids = linked.map((r) => String(r.metadata.invocationId));
  assert.equal(new Set(ids).size, ids.length, "no two role receipts share an invocation id");
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Part E — the aggregate run.summary references every executed invocation once
// ══════════════════════════════════════════════════════════════════════════════════════════════

function normalRun() {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const rc = capturingReceipts();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-p11c-sum-"));
  const baseRef = gitInit(dir);
  const handle: WorkspaceHandle = { id: "wssum", targetRepo: dir, baseBranch: "main", baseRef, scratchBranch: "s", path: dir, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  let builderTurn = 0;
  const invokeModel = async (req: ModelRequest): Promise<ModelResponse> => {
    const model = req.model ?? "m";
    if (typeof (req as { prompt?: unknown }).prompt === "string") return resp(JSON.stringify({ tier: "worker", rationale: "x" }), model);
    if (!(req.tools ?? []).some((t) => t.name === "done")) return resp(CRITIC_PASS, model);
    builderTurn += 1;
    if (builderTurn === 1) return toolResp("read_file", { path: "a.ts" }, model);
    if (builderTurn === 2) return toolResp("write_file", { path: "a.ts", content: "export const a = 2;\n" }, model);
    if (builderTurn === 3) return toolResp("run_checks", {}, model);
    return toolResp("done", { successCondition: "x", filesReadBack: ["a.ts"], selfCheck: "green", satisfied: true }, model);
  };
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 2000, maxConcurrentRuns: 1, trustLadder: false },
    workspaces: { allocate: async () => handle, diff: async () => "d", promote: async (h): Promise<PromoteResult> => ({ promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }), discard: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: true }), commit: async () => true },
    events: fakeBus, receipts: rc.receipts, trust: stubTrust, resolveIdentity, roleClaim,
    roles: { scout: async () => ({ role: "scout", outcome: "success", summary: "s" }), verifier: execVerifier, integrator: promoteIntegrator }, // builder + critic real
    invokeModel, governedExec: greenExec, builderModel: "deepseek-v4-flash", gateWall: allowGate,
  });
  return { run: () => orch.run({ taskId: "t-sum", targetRepo: dir, goal: "do the thing" }, parentCtx), receipts: rc.appended };
}

test("E1 (run.summary aggregates every executed invocation once + names a primary): ordered ids, unique, count-consistent", async () => {
  const h = normalRun();
  const result = await h.run();
  assert.equal(result.promoted, true);
  const sum = find(h.receipts, "worker.run.summary")!;
  const ids = sum.metadata.invocationIds as string[];
  assert.ok(Array.isArray(ids) && ids.length > 0, "the summary references the executed invocations");
  assert.equal(new Set(ids).size, ids.length, "each invocation is referenced exactly once (no double-count)");
  assert.equal(ids.length, sum.metadata.invocationCount, "the id set size equals the executed invocation count");
  assert.equal(typeof sum.metadata.primaryInvocationId, "string", "the primary (code-producing builder) invocation is named");
  assert.ok(ids.includes(String(sum.metadata.primaryInvocationId)), "the primary invocation is one of the referenced ids");
});

test("E2 [MUTATION 6] (a role receipt's linked id is a member of the run's aggregate id set): no receipt references an id the ledger did not record", async () => {
  const h = normalRun();
  await h.run();
  const sum = find(h.receipts, "worker.run.summary")!;
  const aggregate = new Set(sum.metadata.invocationIds as string[]);
  const builder = find(h.receipts, "worker.role.builder")!;
  assert.ok(aggregate.has(String(builder.metadata.invocationId)), "the builder role receipt's id is a genuine member of the ledger's aggregate set");
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Part F — ledger-level guards: executedIds() is the authoritative de-duplicated aggregate
// ══════════════════════════════════════════════════════════════════════════════════════════════

function tinyLedger(responses: Record<string, ModelResponse>) {
  return new InvocationLedger({
    invokeModel: async (req: ModelRequest) => responses[req.model] ?? resp("", req.model, 0.001),
    neutralizeUntrusted: (content, context) => coreNeutralize(content, context),
    runId: "r", taskId: "t",
  });
}

test("F1 (executedIds references each executed invocation exactly once, in dispatch order): retries/recovery do not double-count", async () => {
  const led = tinyLedger({});
  await led.withContext({ role: "builder", stage: "candidate-role" }, () => led.engine.invokeModel({ model: "m-a", messages: [] } as unknown as ModelRequest));
  await led.withContext({ role: "critic", stage: "role" }, () => led.engine.invokeModel({ model: "m-b", messages: [] } as unknown as ModelRequest));
  // A nested structured-recovery under the critic — a DISTINCT invocation, referenced once, not merged.
  await led.withContext({ role: "critic", stage: "role" }, () => led.engine.invokeModel({ model: "m-b", messages: [] } as unknown as ModelRequest, { stage: "structured-recovery", retryKind: "structured-recovery" }));
  const ids = led.executedIds();
  assert.equal(ids.length, 3, "three distinct executed invocations");
  assert.equal(new Set(ids).size, 3, "no id is double-counted");
  assert.match(ids[2]!, /:critic:structured-recovery:/, "the recovery is its own referenced record");
  assert.equal(ids.length, led.invocationCount(), "executedIds and invocationCount agree");
});

test("F2 (a pre-dispatch lane-blocked record is NOT an executed invocation): it is excluded from executedIds()", async () => {
  const led = new InvocationLedger({
    invokeModel: async (req: ModelRequest) => resp("", req.model, 0.001),
    neutralizeUntrusted: (content, context) => coreNeutralize(content, context),
    runId: "r", taskId: "t",
    laneMember: (model, lane) => model.startsWith(lane),
  });
  await led.withContext({ role: "builder", stage: "candidate-role", vendorLane: "deepseek" }, () => led.engine.invokeModel({ model: "deepseek-x", messages: [] } as unknown as ModelRequest));
  // An out-of-lane requested model is blocked BEFORE dispatch — recorded as lane-blocked, never executed.
  await assert.rejects(() => led.withContext({ role: "builder", stage: "candidate-role", vendorLane: "deepseek" }, () => led.engine.invokeModel({ model: "mimo-y", messages: [] } as unknown as ModelRequest)));
  const ids = led.executedIds();
  assert.equal(ids.length, 1, "only the executed (in-lane) invocation is referenced; the blocked one is not");
  assert.match(ids[0]!, /:builder:candidate-role:/);
});

test("F3 (semantic-verdict parse sanity for the recovery fixtures): the raw-malformed fixture is genuinely unparseable", () => {
  // Guards the recovery tests above: the fixture must be a STRUCTURAL failure (so recovery is dispatched),
  // not a clean verdict that would skip recovery entirely and make A1/A2 vacuous.
  const v = parseSemanticVerdict(rawMalformed, { candidateId: "build:deepseek" });
  assert.notEqual(v.kind, "pass", "the malformed fixture is not a clean pass");
});

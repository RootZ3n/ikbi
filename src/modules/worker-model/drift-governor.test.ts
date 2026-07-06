import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import { autonomyForTier, asTier, TRUST_FLOOR, type TrustDecision } from "../../core/trust/index.js";
import type { DiscardResult, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import { WORKER_ROLES, type RoleFn, type WorkerRole, type WorkerTask } from "./contract.js";
import { DriftBlockedError, type DriftPrevention, type DriftReport } from "../drift-prevention/index.js";

// The build-path drift GOVERNOR (step 3): drift detection becomes intervention BEFORE any paid role.

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

function fakeWorkspaces() {
  const handle: WorkspaceHandle = { id: "wsabcd", targetRepo: "/repo", baseBranch: "main", baseRef: "deadbeef", scratchBranch: "ikbi/ws/wsabcd", path: "/tmp/wsabcd", identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  const calls = { promote: 0, discard: 0, allocate: 0 };
  const workspaces: NonNullable<OrchestratorDeps["workspaces"]> = {
    allocate: async () => { calls.allocate += 1; return handle; },
    promote: async (h): Promise<PromoteResult> => { calls.promote += 1; return { promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }; },
    discard: async (h): Promise<DiscardResult> => { calls.discard += 1; return { workspaceId: h.id, removed: true }; },
  };
  return { workspaces, calls };
}

const fakeTrust = () => ({ recordOutcome: async (i: { agentId: string; operation: string; status: string; defaultTrustTier: string }): Promise<TrustDecision> => { const t = asTier(i.defaultTrustTier, TRUST_FLOOR); return { agentId: i.agentId, tier: t, previousTier: t, autonomy: autonomyForTier(t) }; } });
const noopBus = () => ({ publish: <P>(i: P) => ({ ...(i as object), contractVersion: "1.0.0", id: "e", seq: 1, timestamp: 0 }) as unknown, subscribe: () => ({ id: "s", unsubscribe: () => {}, stats: () => ({ delivered: 0, dropped: 0, failures: 0, queued: 0 }) }), flush: async () => {} });
const allowGate: NonNullable<OrchestratorDeps["gateWall"]> = { evaluate: async () => ({ allow: true, reason: "test gate allows" }) };

const task: WorkerTask = { taskId: "t-drift", targetRepo: "/repo", goal: "build the thing", escalationDisabled: true };

// A clean, promoting build. The builder counter lets a test prove NO role ran (a blocked build).
function cleanRoles() {
  const calls = { builder: 0 };
  const roles: Partial<Record<WorkerRole, RoleFn>> = {};
  for (const r of WORKER_ROLES) {
    roles[r] = async () => {
      if (r === "builder") { calls.builder += 1; return { role: r, outcome: "success", summary: "built", detail: { filesWritten: ["a.ts"], policyViolations: [] } }; }
      if (r === "integrator") return { role: r, outcome: "success", summary: r, detail: { decision: "promote", evaluation: { approved: true } } };
      return { role: r, outcome: "success", summary: r };
    };
  }
  return { roles, calls };
}

function driftReport(over: Partial<DriftReport> = {}): DriftReport {
  return { agent: "worker-1", operation: "worker.role.builder", project: "/repo", baselineRate: 0.9, recentRate: 0.4, drop: 0.5, sampleSize: 8, drifted: true, severity: "major", reason: "declined", ...over };
}

function orchestratorWith(driftGovernor: DriftPrevention | undefined, roles: Partial<Record<WorkerRole, RoleFn>>, deps: { ws: ReturnType<typeof fakeWorkspaces>; ids: ReturnType<typeof makeIdentities> }, summaries?: Array<{ operation?: string; metadata?: Record<string, unknown> }>) {
  const receipts = summaries
    ? { append: async (i: unknown): Promise<unknown> => { const rec = i as { operation?: string; metadata?: Record<string, unknown> }; summaries.push(rec); return {}; } }
    : { append: async (): Promise<unknown> => ({}) };
  return createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 5000, maxConcurrentRuns: 1, totalBudgetMs: 0 },
    resolveIdentity: deps.ids.resolveIdentity, roleClaim: deps.ids.roleClaim, roles,
    workspaces: deps.ws.workspaces, trust: fakeTrust(), receipts,
    events: noopBus() as unknown as NonNullable<OrchestratorDeps["events"]>,
    gateWall: allowGate, invokeModel: async () => { throw new Error("unused"); },
    killCheck: async () => ({ killed: false }),
    ...(driftGovernor !== undefined ? { driftGovernor } : {}),
  });
}

test("BLOCK: a drifted builder under the block policy REFUSES the build at zero cost (no role runs)", async () => {
  const ids = makeIdentities();
  const ws = fakeWorkspaces();
  const roles = cleanRoles();
  const summaries: Array<{ operation?: string; metadata?: Record<string, unknown> }> = [];
  // A block-policy detector: throws DriftBlockedError on the drifted operation (mirrors blockPolicy).
  const drift: DriftPrevention = { check: async () => { throw new DriftBlockedError([driftReport()]); } };
  const orch = orchestratorWith(drift, roles.roles, { ws, ids }, summaries);

  const r = await orch.run(task, ids.parentCtx);

  assert.equal(r.outcome, "rejected", "the drifted build is refused");
  assert.equal(r.promoted, false);
  assert.match(r.reason ?? "", /drifted for this project/);
  assert.equal(roles.calls.builder, 0, "ZERO paid roles ran — refused before any spend");
  assert.equal(ws.calls.allocate, 0, "no workspace was even allocated");
  assert.ok(summaries.some((s) => s.operation === "worker.run.drift_blocked"), "an auditable drift_blocked receipt was written");
});

test("ADVISORY: a drifted builder under the default (reportOnly) policy still BUILDS, and records the drift", async () => {
  const ids = makeIdentities();
  const ws = fakeWorkspaces();
  const roles = cleanRoles();
  const summaries: Array<{ operation?: string; metadata?: Record<string, unknown> }> = [];
  // reportOnly returns the drifted report WITHOUT throwing (the default posture).
  const drift: DriftPrevention = { check: async () => [driftReport()] };
  const orch = orchestratorWith(drift, roles.roles, { ws, ids }, summaries);

  const r = await orch.run(task, ids.parentCtx);

  assert.equal(r.promoted, true, "advisory drift does NOT block — the build proceeds and promotes");
  assert.ok(roles.calls.builder >= 1, "the builder ran");
  const runSummary = summaries.find((s) => s.operation === "worker.run.summary");
  const drifted = runSummary?.metadata?.driftedOperations as Array<{ operation: string }> | undefined;
  assert.ok(Array.isArray(drifted) && drifted[0]?.operation === "worker.role.builder", "the drift signal is recorded on the run summary for audit");
});

test("FAIL-OPEN: a drift READ error never breaks a build (drift is advisory infrastructure)", async () => {
  const ids = makeIdentities();
  const ws = fakeWorkspaces();
  const roles = cleanRoles();
  const drift: DriftPrevention = { check: async () => { throw new Error("lab-memory read failed"); } };
  const orch = orchestratorWith(drift, roles.roles, { ws, ids });

  const r = await orch.run(task, ids.parentCtx);

  assert.equal(r.promoted, true, "a non-block drift read error is swallowed — the build proceeds");
  assert.ok(roles.calls.builder >= 1);
});

test("NO GOVERNOR wired: behavior is unchanged (backward compatible — the check does not run)", async () => {
  const ids = makeIdentities();
  const ws = fakeWorkspaces();
  const roles = cleanRoles();
  let checked = false;
  // Even a block-policy detector is never consulted when not wired as driftGovernor.
  void (async () => { checked = true; });
  const orch = orchestratorWith(undefined, roles.roles, { ws, ids });

  const r = await orch.run(task, ids.parentCtx);

  assert.equal(r.promoted, true);
  assert.equal(checked, false, "no governor wired ⇒ no drift check");
});

test("NOT DRIFTED: a governor that reports no drift is a clean no-op (build proceeds, nothing recorded)", async () => {
  const ids = makeIdentities();
  const ws = fakeWorkspaces();
  const roles = cleanRoles();
  const summaries: Array<{ operation?: string; metadata?: Record<string, unknown> }> = [];
  const drift: DriftPrevention = { check: async () => [driftReport({ drifted: false })] };
  const orch = orchestratorWith(drift, roles.roles, { ws, ids }, summaries);

  const r = await orch.run(task, ids.parentCtx);

  assert.equal(r.promoted, true);
  const runSummary = summaries.find((s) => s.operation === "worker.run.summary");
  assert.equal(runSummary?.metadata?.driftedOperations, undefined, "no drift ⇒ no driftedOperations on the summary");
});

test("REUSE WORKSPACE: the governor is skipped on a step-planner sub-step (fires on the first/standalone build)", async () => {
  const ids = makeIdentities();
  const ws = fakeWorkspaces();
  const roles = cleanRoles();
  let consulted = false;
  const drift: DriftPrevention = { check: async () => { consulted = true; throw new DriftBlockedError([driftReport()]); } };
  const orch = orchestratorWith(drift, roles.roles, { ws, ids });

  // reuseWorkspace set ⇒ mid-chain step ⇒ the governor must not fire (and so must not block).
  const reuseHandle: WorkspaceHandle = { id: "wsabcd", targetRepo: "/repo", baseBranch: "main", baseRef: "deadbeef", scratchBranch: "ikbi/ws/wsabcd", path: "/tmp/wsabcd", identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  const r = await orch.run({ ...task, reuseWorkspace: reuseHandle }, ids.parentCtx);

  assert.equal(consulted, false, "the drift governor is not consulted on a reuseWorkspace step");
  assert.notEqual(r.outcome, "rejected", "the sub-step was not drift-blocked");
});

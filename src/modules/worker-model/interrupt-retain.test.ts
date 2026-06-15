/**
 * Phase 6 (audit): when a kill-switch halts a run mid-loop, the interrupted workspace is
 * RETAINED (not discarded) so its partial work survives for inspection. The existing
 * kill-checkpoint tests verify the discard-fallback path (no retain method); these tests
 * verify the retain path (manager has a retain method) and the --retain-off path.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import { autonomyForTier, asTier, type TrustDecision } from "../../core/trust/index.js";
import { TRUST_FLOOR } from "../../core/trust/index.js";
import type { DiscardResult, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import type { RoleContext, RoleFn, WorkerRole, WorkerTask } from "./contract.js";
import { WORKER_ROLES } from "./contract.js";

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

function capturingRoles() {
  const roles: Partial<Record<WorkerRole, RoleFn>> = {};
  for (const r of WORKER_ROLES) {
    roles[r] = async (_ctx: RoleContext) => {
      if (r === "integrator") return { role: r, outcome: "success" as const, summary: r, detail: { decision: "promote", evaluation: { approved: true } } };
      return { role: r, outcome: "success" as const, summary: r };
    };
  }
  return { roles };
}

const handle: WorkspaceHandle = { id: "wsabcd", targetRepo: "/repo", baseBranch: "main", baseRef: "deadbeef", scratchBranch: "ikbi/ws/wsabcd", path: "/tmp/wsabcd", identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };

function fakeWorkspacesWithRetain() {
  const calls = { allocate: 0, discard: 0, retain: [] as string[] };
  const workspaces: NonNullable<OrchestratorDeps["workspaces"]> = {
    allocate: async () => { calls.allocate += 1; return handle; },
    promote: async (h): Promise<PromoteResult> => ({ promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }),
    discard: async (h): Promise<DiscardResult> => { calls.discard += 1; return { workspaceId: h.id, removed: true }; },
    retain: async (h, reason): Promise<DiscardResult> => { calls.retain.push(reason); return { workspaceId: h.id, removed: false }; },
  };
  return { workspaces, calls };
}

function fakeWorkspacesNoRetain() {
  const calls = { discard: 0 };
  const workspaces: NonNullable<OrchestratorDeps["workspaces"]> = {
    allocate: async () => handle,
    promote: async (h): Promise<PromoteResult> => ({ promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }),
    discard: async (h): Promise<DiscardResult> => { calls.discard += 1; return { workspaceId: h.id, removed: true }; },
  };
  return { workspaces, calls };
}

const fakeTrust = () => ({ recordOutcome: async (i: { agentId: string; operation: string; status: string; defaultTrustTier: string }): Promise<TrustDecision> => { const t = asTier(i.defaultTrustTier, TRUST_FLOOR); return { agentId: i.agentId, tier: t, previousTier: t, autonomy: autonomyForTier(t) }; } });
const fakeReceipts = () => ({ append: async (_i: unknown, _id: AgentIdentity): Promise<unknown> => ({}) });
const noopBus = () => ({ publish: <P>(i: P) => ({ ...(i as object), contractVersion: "1.0.0", id: "e", seq: 1, timestamp: 0 }) as unknown, subscribe: () => ({ id: "s", unsubscribe: () => {}, stats: () => ({ delivered: 0, dropped: 0, failures: 0, queued: 0 }) }), flush: async () => {} });
const allowGate: NonNullable<OrchestratorDeps["gateWall"]> = { evaluate: async () => ({ allow: true, reason: "test gate allows" }) };

const ENABLED = { enabled: true, roleTimeoutMs: 1000, maxConcurrentRuns: 1 };
const task: WorkerTask = { taskId: "t-1", targetRepo: "/repo", goal: "do the thing" };

test("kill MID-run ⇒ workspace is RETAINED (not discarded) when the manager supports retain", async () => {
  const ids = makeIdentities();
  const ws = fakeWorkspacesWithRetain();
  const cap = capturingRoles();
  // killed after the builder role (3rd kill check)
  let calls = 0;
  const killCheck = async () => { calls += 1; return { killed: calls >= 3, signal: { mode: "soft" as const } }; };

  const orch = createOrchestrator({
    config: ENABLED,
    resolveIdentity: ids.resolveIdentity,
    roleClaim: ids.roleClaim,
    roles: cap.roles,
    workspaces: ws.workspaces,
    trust: fakeTrust(),
    receipts: fakeReceipts(),
    events: noopBus() as unknown as NonNullable<OrchestratorDeps["events"]>,
    gateWall: allowGate,
    invokeModel: async () => { throw new Error("unused"); },
    killCheck,
  });

  const r = await orch.run(task, ids.parentCtx);
  assert.equal(r.outcome, "rejected", "kill gives rejected outcome");
  assert.equal(r.promoted, false, "not promoted on kill");
  assert.equal(ws.calls.discard, 0, "workspace NOT discarded — partial work is preserved");
  assert.equal(ws.calls.retain.length, 1, "workspace was RETAINED");
  assert.match(ws.calls.retain[0] ?? "", /interrupted/, "retain reason mentions interrupted");
  assert.match(ws.calls.retain[0] ?? "", /kill-switch/, "retain reason mentions kill-switch");
});

test("kill MID-run ⇒ workspace is discarded when retainFailedWorkspaces is off", async () => {
  const ids = makeIdentities();
  const ws = fakeWorkspacesWithRetain();
  const cap = capturingRoles();
  let calls = 0;
  const killCheck = async () => { calls += 1; return { killed: calls >= 3, signal: { mode: "soft" as const } }; };

  const orch = createOrchestrator({
    config: { ...ENABLED, retainFailedWorkspaces: false },
    resolveIdentity: ids.resolveIdentity,
    roleClaim: ids.roleClaim,
    roles: cap.roles,
    workspaces: ws.workspaces,
    trust: fakeTrust(),
    receipts: fakeReceipts(),
    events: noopBus() as unknown as NonNullable<OrchestratorDeps["events"]>,
    gateWall: allowGate,
    invokeModel: async () => { throw new Error("unused"); },
    killCheck,
  });

  const r = await orch.run(task, ids.parentCtx);
  assert.equal(r.outcome, "rejected");
  assert.equal(ws.calls.retain.length, 0, "retain NOT called when retainFailedWorkspaces is off");
  assert.equal(ws.calls.discard, 1, "workspace discarded when retention is off");
});

test("kill MID-run ⇒ falls back to discard when manager has no retain method", async () => {
  const ids = makeIdentities();
  const ws = fakeWorkspacesNoRetain(); // no retain method
  const cap = capturingRoles();
  let calls = 0;
  const killCheck = async () => { calls += 1; return { killed: calls >= 3, signal: { mode: "soft" as const } }; };

  const orch = createOrchestrator({
    config: ENABLED, // retainFailedWorkspaces defaults to true
    resolveIdentity: ids.resolveIdentity,
    roleClaim: ids.roleClaim,
    roles: cap.roles,
    workspaces: ws.workspaces,
    trust: fakeTrust(),
    receipts: fakeReceipts(),
    events: noopBus() as unknown as NonNullable<OrchestratorDeps["events"]>,
    gateWall: allowGate,
    invokeModel: async () => { throw new Error("unused"); },
    killCheck,
  });

  const r = await orch.run(task, ids.parentCtx);
  assert.equal(r.outcome, "rejected");
  assert.equal(ws.calls.discard, 1, "falls back to discard when no retain method (backward compat)");
});

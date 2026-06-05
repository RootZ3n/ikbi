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
import { WORKER_ROLES, type RoleContext, type RoleFn, type WorkerRole, type WorkerTask } from "./contract.js";

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
  const seen: RoleContext[] = [];
  const roles: Partial<Record<WorkerRole, RoleFn>> = {};
  for (const r of WORKER_ROLES) {
    roles[r] = async (ctx) => {
      seen.push(ctx);
      if (r === "integrator") return { role: r, outcome: "success", summary: r, detail: { decision: "promote", evaluation: { approved: true } } };
      return { role: r, outcome: "success", summary: r };
    };
  }
  return { seen, roles };
}

function fakeWorkspaces() {
  const calls = { allocate: 0, promote: 0, discard: 0 };
  const handle: WorkspaceHandle = { id: "wsabcd", targetRepo: "/repo", baseBranch: "main", baseRef: "deadbeef", scratchBranch: "ikbi/ws/wsabcd", path: "/tmp/wsabcd", identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  const workspaces: NonNullable<OrchestratorDeps["workspaces"]> = {
    allocate: async () => { calls.allocate += 1; return handle; },
    promote: async (h): Promise<PromoteResult> => { calls.promote += 1; return { promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }; },
    discard: async (h): Promise<DiscardResult> => { calls.discard += 1; return { workspaceId: h.id, removed: true }; },
  };
  return { workspaces, calls };
}

const fakeTrust = () => ({ recordOutcome: async (i: { agentId: string; operation: string; status: string; defaultTrustTier: string }): Promise<TrustDecision> => { const t = asTier(i.defaultTrustTier, TRUST_FLOOR); return { agentId: i.agentId, tier: t, previousTier: t, autonomy: autonomyForTier(t) }; } });
const fakeReceipts = () => ({ append: async (_i: unknown, _id: AgentIdentity): Promise<unknown> => ({}) });
const noopBus = () => ({ publish: <P>(i: P) => ({ ...(i as object), contractVersion: "1.0.0", id: "e", seq: 1, timestamp: 0 }) as unknown, subscribe: () => ({ id: "s", unsubscribe: () => {}, stats: () => ({ delivered: 0, dropped: 0, failures: 0, queued: 0 }) }), flush: async () => {} });

const ENABLED = { enabled: true, roleTimeoutMs: 1000, maxConcurrentRuns: 1 };
const task: WorkerTask = { taskId: "t-1", targetRepo: "/repo", goal: "do the thing" };

function deps(killCheck: NonNullable<OrchestratorDeps["killCheck"]>, ws: ReturnType<typeof fakeWorkspaces>, cap: ReturnType<typeof capturingRoles>, ids: ReturnType<typeof makeIdentities>): OrchestratorDeps {
  return { config: ENABLED, resolveIdentity: ids.resolveIdentity, roleClaim: ids.roleClaim, roles: cap.roles, workspaces: ws.workspaces, trust: fakeTrust(), receipts: fakeReceipts(), events: noopBus() as unknown as NonNullable<OrchestratorDeps["events"]>, invokeModel: async () => { throw new Error("unused"); }, killCheck };
}

// ── PREVENT NEW WORK ─────────────────────────────────────────────────────────

test("kill BEFORE start ⇒ no allocate, no roles, a kill-outcome result (prevent new work)", async () => {
  const ids = makeIdentities();
  const ws = fakeWorkspaces();
  const cap = capturingRoles();
  const orch = createOrchestrator(deps(async () => ({ killed: true, signal: { mode: "hard" } }), ws, cap, ids));

  const r = await orch.run(task, ids.parentCtx);
  assert.equal(ws.calls.allocate, 0, "no workspace allocated when killed before start");
  assert.equal(cap.seen.length, 0, "no roles ran");
  assert.equal(r.outcome, "rejected");
  assert.equal(r.promoted, false);
  assert.match(r.reason ?? "", /kill-switch/);
});

// ── ROLE-BOUNDARY STOP + RECLAIM (no half-promote) ───────────────────────────

test("kill MID-run ⇒ stops at the next role boundary, workspace discarded, NOT promoted", async () => {
  const ids = makeIdentities();
  const ws = fakeWorkspaces();
  const cap = capturingRoles();
  // killHalt calls: pre-start(1, not killed), after-scout(2, not killed), after-builder(3, KILLED).
  let calls = 0;
  const killCheck = async () => { calls += 1; return { killed: calls >= 3, signal: { mode: "soft" } }; };
  const orch = createOrchestrator(deps(killCheck, ws, cap, ids));

  const r = await orch.run(task, ids.parentCtx);
  assert.deepEqual(cap.seen.map((c) => c.role), ["scout", "builder"], "stopped after the builder role boundary");
  assert.equal(ws.calls.promote, 0, "a half-run is NEVER promoted");
  assert.equal(ws.calls.discard, 1, "the workspace was reclaimed (discarded)");
  assert.equal(r.outcome, "rejected");
  assert.equal(r.promoted, false);
  assert.match(r.reason ?? "", /kill-switch/);
});

// ── NOT KILLED ⇒ normal run (checkpoint is transparent) ──────────────────────

test("not killed ⇒ the run proceeds normally and promotes (checkpoint transparent)", async () => {
  const ids = makeIdentities();
  const ws = fakeWorkspaces();
  const cap = capturingRoles();
  const orch = createOrchestrator(deps(async () => ({ killed: false }), ws, cap, ids));

  const r = await orch.run(task, ids.parentCtx);
  assert.equal(cap.seen.length, 5, "all five roles ran");
  assert.equal(ws.calls.allocate, 1);
  assert.equal(ws.calls.promote, 1, "promoted normally");
  assert.equal(r.promoted, true);
  assert.equal(r.outcome, "success");
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import { autonomyForTier, asTier, TRUST_FLOOR, type TrustDecision } from "../../core/trust/index.js";
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
const allowGate: NonNullable<OrchestratorDeps["gateWall"]> = { evaluate: async () => ({ allow: true, reason: "test gate allows" }) };

const task: WorkerTask = { taskId: "t-budget", targetRepo: "/repo", goal: "do the thing" };

test("total budget: a run that overruns its wall-clock ceiling halts at a role boundary (discard, no promote)", async () => {
  const ids = makeIdentities();
  const ws = fakeWorkspaces();
  const cap = capturingRoles();
  // Auto-advancing clock: arm() reads 0 (deadline 5000); pre-start check reads 3000 (ok);
  // the next boundary check reads 6000 (> 5000) and trips the budget.
  let t = 0;
  const now = () => { const v = t; t += 3000; return v; };
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 1000, maxConcurrentRuns: 1, totalBudgetMs: 5000 },
    resolveIdentity: ids.resolveIdentity, roleClaim: ids.roleClaim, roles: cap.roles,
    workspaces: ws.workspaces, trust: fakeTrust(), receipts: fakeReceipts(),
    events: noopBus() as unknown as NonNullable<OrchestratorDeps["events"]>,
    gateWall: allowGate, invokeModel: async () => { throw new Error("unused"); },
    killCheck: async () => ({ killed: false }),
    now,
  });

  const r = await orch.run(task, ids.parentCtx);
  assert.ok(cap.seen.length >= 1 && cap.seen.length < 5, "stopped partway, not a full 5-role run");
  assert.equal(ws.calls.promote, 0, "a budget-halted run is NEVER promoted");
  assert.equal(r.promoted, false);
  assert.equal(r.outcome, "rejected");
  assert.match(r.reason ?? "", /budget/);
});

test("total budget disabled (0) ⇒ the run proceeds normally", async () => {
  const ids = makeIdentities();
  const ws = fakeWorkspaces();
  const cap = capturingRoles();
  // Even with a clock that jumps wildly, totalBudgetMs:0 means no deadline is armed.
  let t = 0;
  const now = () => { const v = t; t += 1_000_000; return v; };
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 1000, maxConcurrentRuns: 1, totalBudgetMs: 0 },
    resolveIdentity: ids.resolveIdentity, roleClaim: ids.roleClaim, roles: cap.roles,
    workspaces: ws.workspaces, trust: fakeTrust(), receipts: fakeReceipts(),
    events: noopBus() as unknown as NonNullable<OrchestratorDeps["events"]>,
    gateWall: allowGate, invokeModel: async () => { throw new Error("unused"); },
    killCheck: async () => ({ killed: false }),
    now,
  });

  const r = await orch.run(task, ids.parentCtx);
  assert.equal(cap.seen.length, 5, "all five roles ran (budget disabled)");
  assert.equal(r.promoted, true);
  assert.equal(r.outcome, "success");
});

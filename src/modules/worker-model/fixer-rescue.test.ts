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
          : { role: r, outcome: "success", summary: "run_checks GREEN" };
      }
      if (r === "integrator") return { role: r, outcome: "success", summary: r, detail: { decision: "promote", evaluation: { approved: true } } };
      return { role: r, outcome: "success", summary: r };
    };
  }
  return { roles, calls };
}

function fakeWorkspaces() {
  const handle: WorkspaceHandle = { id: "wsabcd", targetRepo: "/repo", baseBranch: "main", baseRef: "deadbeef", scratchBranch: "ikbi/ws/wsabcd", path: "/tmp/wsabcd", identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
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

// escalationDisabled keeps the no-fixer failure path deterministic (no cheap-retry/escalation fan-out).
const task: WorkerTask = { taskId: "t-fixer", targetRepo: "/repo", goal: "build the thing", escalationDisabled: true };

function orchestratorWith(fixerModel: string | undefined, roles: Partial<Record<WorkerRole, RoleFn>>, deps: { ws: ReturnType<typeof fakeWorkspaces>; ids: ReturnType<typeof makeIdentities> }) {
  return createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 5000, maxConcurrentRuns: 1, totalBudgetMs: 0, ...(fixerModel !== undefined ? { fixerModel } : {}) },
    resolveIdentity: deps.ids.resolveIdentity, roleClaim: deps.ids.roleClaim, roles,
    workspaces: deps.ws.workspaces, trust: fakeTrust(), receipts: fakeReceipts(),
    events: noopBus() as unknown as NonNullable<OrchestratorDeps["events"]>,
    gateWall: allowGate, invokeModel: async () => { throw new Error("unused"); },
    killCheck: async () => ({ killed: false }),
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

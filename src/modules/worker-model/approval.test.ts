/**
 * SG-10 (audit): the human-approval gate. With `requestApproval` wired, a VERIFIED build pauses
 * before promote; approve ⇒ promote, reject ⇒ discard (rejected). Absent ⇒ no gate (unchanged).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import type { EventBusSurface, EventInput, IkbiEvent } from "../../core/events/index.js";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import { asTier, autonomyForTier, TRUST_FLOOR, type TrustDecision } from "../../core/trust/index.js";
import type { DiscardResult, PromoteGovernance, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import { isAffirmative } from "./cli.js";
import { WORKER_ROLES, type RoleFn, type WorkerRole, type WorkerTask } from "./contract.js";

const silent = () => pino({ level: "silent" });
const ENABLED = { enabled: true, roleTimeoutMs: 1000, maxConcurrentRuns: 1 };
const task: WorkerTask = { taskId: "t-1", targetRepo: "/repo", goal: "add the thing" };

function ids() {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [
      { agentId: "parent-1", kind: "agent", functionalRole: "lead", defaultTrustTier: "trusted", tokenHashes: [hashToken("p")] },
      { agentId: "worker-1", kind: "agent", functionalRole: "worker", defaultTrustTier: "trusted", tokenHashes: [hashToken("w")] },
    ] }),
    logger: silent(), now: () => 1000,
  });
  return { parentCtx: beginOperation(resolver.resolve({ token: "p" }), { requestId: "req-1" }), resolveIdentity: ((c: { token?: string }, x?: unknown) => resolver.resolve(c, x as never)) as NonNullable<OrchestratorDeps["resolveIdentity"]>, roleClaim: (() => ({ token: "w" })) as NonNullable<OrchestratorDeps["roleClaim"]> };
}

function bus() {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const surface: EventBusSurface = {
    publish: <P>(input: EventInput<P>): IkbiEvent<P> => { events.push({ type: (input as { type: string }).type, payload: ((input as { payload?: unknown }).payload ?? {}) as Record<string, unknown> }); return { ...input, contractVersion: "1.0.0", id: "e", seq: events.length, timestamp: 0 } as IkbiEvent<P>; },
    subscribe: () => ({ id: "s", unsubscribe: () => {}, stats: () => ({ delivered: 0, dropped: 0, failures: 0, queued: 0 }) }),
    flush: async () => {},
  };
  return { surface, events };
}

const roles = (): Partial<Record<WorkerRole, RoleFn>> => {
  const r: Partial<Record<WorkerRole, RoleFn>> = {};
  for (const role of WORKER_ROLES) {
    r[role] = async () =>
      role === "integrator"
        ? { role, outcome: "success", summary: role, detail: { decision: "promote", rationale: "ok", evaluation: { approved: true } } }
        : { role, outcome: "success", summary: role };
  }
  return r;
};

function ws() {
  const calls = { promote: 0, discard: 0 };
  const handle: WorkspaceHandle = { id: "wsabcd", targetRepo: "/repo", baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/wsabcd", path: "/tmp/wsabcd", identity: { agentId: "parent-1" }, state: "allocated", createdAt: 0 };
  return {
    calls,
    workspaces: {
      allocate: async () => handle,
      promote: async (h: WorkspaceHandle): Promise<PromoteResult> => { calls.promote += 1; return { promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }; },
      discard: async (h: WorkspaceHandle): Promise<DiscardResult> => { calls.discard += 1; return { workspaceId: h.id, removed: true }; },
      commit: async () => true,
    } satisfies NonNullable<OrchestratorDeps["workspaces"]>,
  };
}

const fakeTrust = { recordOutcome: async (i: { agentId: string; defaultTrustTier: string }): Promise<TrustDecision> => { const t = asTier(i.defaultTrustTier, TRUST_FLOOR); return { agentId: i.agentId, tier: t, previousTier: t, autonomy: autonomyForTier(t) }; } };
const fakeReceipts = { append: async (): Promise<unknown> => ({}) };
const allowGate: NonNullable<OrchestratorDeps["gateWall"]> = { evaluate: async (): Promise<PromoteGovernance> => ({ allow: true }) };

function orch(extra: Partial<OrchestratorDeps>, w = ws(), b = bus()) {
  const { parentCtx, resolveIdentity, roleClaim } = ids();
  const o = createOrchestrator({ config: ENABLED, resolveIdentity, roleClaim, roles: roles(), workspaces: w.workspaces, trust: fakeTrust, receipts: fakeReceipts, events: b.surface, gateWall: allowGate, invokeModel: async () => { throw new Error("unused"); }, ...extra });
  return { run: () => o.run(task, parentCtx), w, b };
}

test("isAffirmative: only an explicit yes approves (default No)", () => {
  for (const y of ["y", "Y", "yes", "YES", " yes "]) assert.equal(isAffirmative(y), true, y);
  for (const n of ["", "n", "no", "nope", "later", "1", "promote"]) assert.equal(isAffirmative(n), false, n);
});

test("approval APPROVED ⇒ the build promotes; approval events fire", async () => {
  let asked: { taskId: string; workspaceId: string; goal: string } | undefined;
  const t = orch({ requestApproval: async (req) => { asked = req; return true; } });
  const r = await t.run();
  assert.equal(asked?.workspaceId, "wsabcd", "the gate was asked, with the run's workspace");
  assert.equal(r.promoted, true, "approved ⇒ promoted");
  assert.equal(t.w.calls.promote, 1);
  assert.equal(t.w.calls.discard, 0);
  const types = t.b.events.map((e) => e.type);
  assert.ok(types.includes("worker.approval.requested"));
  const resolved = t.b.events.find((e) => e.type === "worker.approval.resolved");
  assert.equal(resolved?.payload.approved, true);
});

test("approval REJECTED ⇒ the build does NOT promote; it is discarded + rejected", async () => {
  const t = orch({ requestApproval: async () => false });
  const r = await t.run();
  assert.equal(r.promoted, false, "rejected ⇒ never promoted");
  assert.equal(r.outcome, "rejected");
  assert.match(r.reason ?? "", /rejected by operator|approval gate/);
  assert.equal(t.w.calls.promote, 0, "promote was never called");
  assert.equal(t.w.calls.discard, 1, "the workspace was discarded exactly once");
  const resolved = t.b.events.find((e) => e.type === "worker.approval.resolved");
  assert.equal(resolved?.payload.approved, false);
});

test("no approval gate wired ⇒ the build promotes normally (backward compatible)", async () => {
  const t = orch({}); // no requestApproval
  const r = await t.run();
  assert.equal(r.promoted, true);
  assert.equal(t.w.calls.promote, 1);
  assert.ok(!t.b.events.some((e) => e.type.startsWith("worker.approval.")), "no approval events without the gate");
});

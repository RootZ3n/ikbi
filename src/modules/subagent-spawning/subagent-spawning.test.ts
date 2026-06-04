import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import type { EventBusSurface, EventInput, IkbiEvent } from "../../core/events/index.js";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { AgentRecord } from "../../core/identity/registry.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import type { OperationContext } from "../../core/identity/resolver.js";
import { autonomyForTier, asTier, type TrustDecision } from "../../core/trust/index.js";
import { TRUST_FLOOR } from "../../core/trust/index.js";
import type { DiscardResult, PromoteGovernance, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import { createOrchestrator, type OrchestratorDeps } from "../worker-model/index.js";
import {
  WORKER_ROLES,
  type RoleContext,
  type RoleFn,
  type WorkerResult,
  type WorkerRole,
  type WorkerTask,
} from "../worker-model/index.js";
import { createGateWall } from "../gate-wall/index.js";
import { createSubagentSpawner, type SubagentSpawnerDeps } from "./spawn.js";
import { SpawnError } from "./contract.js";
import type { SpawnEventPayload } from "./events.js";

const silent = () => pino({ level: "silent" });

/** A resolver over a fresh registry (mints REAL ValidatedIdentities). */
function makeResolver(agents: AgentRecord[]) {
  return new IdentityResolver({ registry: new AgentRegistry({ agents }), logger: silent(), now: () => 1000 });
}

/**
 * Standard cast: a spawning PARENT, a CHILD subagent credential, and a WORKER role
 * credential, all backed by one registry. Tiers are parameterised so a test can set
 * up clamp / escalation / governance scenarios.
 */
function makeCast(opts: { parentTier: string; childTier: string; workerTier?: string }) {
  const resolver = makeResolver([
    { agentId: "parent-1", kind: "agent", functionalRole: "lead", defaultTrustTier: opts.parentTier, tokenHashes: [hashToken("parent-secret")] },
    { agentId: "child-1", kind: "agent", functionalRole: "subagent", defaultTrustTier: opts.childTier, tokenHashes: [hashToken("child-secret")] },
    { agentId: "worker-1", kind: "agent", functionalRole: "worker", defaultTrustTier: opts.workerTier ?? opts.childTier, tokenHashes: [hashToken("worker-secret")] },
  ]);
  const parent = resolver.resolve({ token: "parent-secret" });
  const parentCtx = beginOperation(parent, { requestId: "req-1" });
  const resolveIdentity: NonNullable<SubagentSpawnerDeps["resolveIdentity"]> = (claim, ctx) => resolver.resolve(claim, ctx);
  const childClaim: NonNullable<SubagentSpawnerDeps["childClaim"]> = () => ({ token: "child-secret" });
  const roleClaim: NonNullable<OrchestratorDeps["roleClaim"]> = () => ({ token: "worker-secret" });
  return { parentCtx, resolveIdentity, childClaim, roleClaim };
}

/** A fake orchestrator that captures the childCtx it is run with and returns a chosen result. */
function fakeOrchestrator(overrides: Partial<WorkerResult> = {}) {
  const calls: OperationContext[] = [];
  const orchestrator = {
    run: async (task: WorkerTask, ctx: OperationContext): Promise<WorkerResult> => {
      calls.push(ctx);
      return { contractVersion: "1.0.0", taskId: task.taskId, outcome: "success", roles: [], workspaceId: "ws1", promoted: true, ...overrides };
    },
  };
  return { orchestrator, calls };
}

/** Capture published spawn events. */
function captureEvents() {
  const sent: Array<EventInput<SpawnEventPayload>> = [];
  const publish = (input: EventInput<SpawnEventPayload>) => void sent.push(input);
  return { publish, sent, types: () => sent.map((e) => e.type) };
}

const task: WorkerTask = { taskId: "t-1", targetRepo: "/repo", goal: "do the thing" };

// ── #10 OUTER BOUNDARY: a parent can NEVER spawn a child above its own tier ──

test("#10 outer boundary: requestedTier=operator under a trusted parent ⇒ child clamped to trusted", async () => {
  const { parentCtx, resolveIdentity, childClaim } = makeCast({ parentTier: "trusted", childTier: "trusted" });
  const orch = fakeOrchestrator();
  const ev = captureEvents();
  const spawner = createSubagentSpawner({ resolveIdentity, childClaim, orchestrator: orch.orchestrator, publish: ev.publish, now: () => 1000 });

  const result = await spawner.spawn({ parentCtx, task, requestedTier: "operator" });

  assert.equal(result.spawned, true);
  assert.equal(result.childIdentitySummary?.trustTier, "trusted", "child clamped to the parent tier, NOT operator");
  assert.equal(result.childIdentitySummary?.clamped, true, "the operator request was clamped down");
  assert.equal(result.childIdentitySummary?.requestedTier, "operator");
  assert.ok(ev.types().includes("subagent.spawn.clamped"), "a clamp event was emitted");
  // The identity actually handed to the orchestrator carries the clamped tier + spawnedFrom.
  const childCtx = orch.calls[0];
  assert.equal(childCtx?.identity.identity.trustTier, "trusted");
  assert.equal(childCtx?.identity.identity.spawnedFrom, "parent-1");
});

test("#10: a lower requested tier is honored (request DOWN), no clamp event", async () => {
  // Parent trusted; the subagent voluntarily asks for the less-trusted probation.
  const { parentCtx, resolveIdentity, childClaim } = makeCast({ parentTier: "trusted", childTier: "probation" });
  const orch = fakeOrchestrator();
  const ev = captureEvents();
  const spawner = createSubagentSpawner({ resolveIdentity, childClaim, orchestrator: orch.orchestrator, publish: ev.publish });

  const result = await spawner.spawn({ parentCtx, task, requestedTier: "probation" });
  assert.equal(result.spawned, true);
  assert.equal(result.childIdentitySummary?.clamped, false, "requesting DOWN is not a clamp");
  assert.ok(!ev.types().includes("subagent.spawn.clamped"));
});

// ── ENFORCEMENT LIVE: a probation parent is DENIED at promote end-to-end ─────

/** Workspaces fake that HONORS governance (promote lands iff governance allows) + captures it. */
function governanceHonoringWorkspaces() {
  let captured: PromoteGovernance | undefined;
  const calls = { promote: 0, discard: 0 };
  const handle: WorkspaceHandle = {
    id: "wsabcd", targetRepo: "/repo", baseBranch: "main", baseRef: "deadbeef",
    scratchBranch: "ikbi/ws/wsabcd", path: "/tmp/wsabcd", identity: { agentId: "child-1" }, state: "allocated", createdAt: 1000,
  };
  const workspaces: NonNullable<OrchestratorDeps["workspaces"]> = {
    allocate: async () => handle,
    promote: async (h, a): Promise<PromoteResult> => {
      calls.promote += 1;
      captured = a.governance;
      return a.governance?.allow
        ? { promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }
        : { promoted: false, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", reason: "governance denied" };
    },
    discard: async (h): Promise<DiscardResult> => {
      calls.discard += 1;
      return { workspaceId: h.id, removed: true };
    },
  };
  return { workspaces, governance: () => captured, calls };
}

function fakeTrust() {
  const trust = {
    recordOutcome: async (input: { agentId: string; operation: string; status: string; defaultTrustTier: string }): Promise<TrustDecision> => {
      const tier = asTier(input.defaultTrustTier, TRUST_FLOOR);
      return { agentId: input.agentId, tier, previousTier: tier, autonomy: autonomyForTier(tier) };
    },
  };
  return { trust };
}

function fakeReceipts() {
  return { append: async (_input: unknown, _identity: AgentIdentity): Promise<unknown> => ({}) };
}

function noopBus(): EventBusSurface {
  return {
    publish: <P>(input: EventInput<P>): IkbiEvent<P> =>
      ({ ...input, contractVersion: "1.0.0", id: "e", seq: 1, timestamp: 0 }) as IkbiEvent<P>,
    subscribe: () => ({ id: "sub", unsubscribe: () => {}, stats: () => ({ delivered: 0, dropped: 0, failures: 0, queued: 0 }) }),
    flush: async () => {},
  };
}

/** All five roles succeed; the integrator returns a well-formed PROMOTE decision. */
function promotingRoles(): Partial<Record<WorkerRole, RoleFn>> {
  const seen: RoleContext[] = [];
  const roles: Partial<Record<WorkerRole, RoleFn>> = {};
  for (const r of WORKER_ROLES) {
    roles[r] = async (ctx) => {
      seen.push(ctx);
      if (r === "integrator") {
        return { role: r, outcome: "success", summary: r, detail: { decision: "promote", rationale: "test", evaluation: { approved: true } } };
      }
      return { role: r, outcome: "success", summary: r };
    };
  }
  return roles;
}

test("ENFORCEMENT LIVE: a probation parent ⇒ child probation ⇒ gate-wall DENIES at promote", async () => {
  // The loaded-gun-becomes-fired test. A probation parent spawns; the run reaches a
  // PROMOTE decision; the gate-wall-wired orchestrator evaluates the probation grant
  // (requiresApproval) and DENIES — so the run does not promote.
  const { parentCtx, resolveIdentity, childClaim, roleClaim } = makeCast({ parentTier: "probation", childTier: "probation", workerTier: "probation" });
  const ws = governanceHonoringWorkspaces();
  // Real gate-wall (enabled by default), with fake receipts/publish so the test does no I/O.
  const gateWall = createGateWall({ receipts: fakeReceipts(), publish: () => {} });

  const orchestrator = createOrchestrator({
    gateWall,
    resolveIdentity,
    roleClaim,
    workspaces: ws.workspaces,
    roles: promotingRoles(),
    trust: fakeTrust().trust,
    receipts: fakeReceipts(),
    events: noopBus(),
    config: { enabled: true, roleTimeoutMs: 1000, maxConcurrentRuns: 1 },
    invokeModel: async () => {
      throw new Error("invokeModel not used");
    },
  });

  const spawner = createSubagentSpawner({ resolveIdentity, childClaim, gateWall, orchestrator, publish: () => {} });
  const result = await spawner.spawn({ parentCtx, task });

  // Governance reached promote and DENIED — enforcement is live (not advisory-allow).
  assert.equal(ws.calls.promote, 1, "the run reached the promote/governance path");
  assert.equal(ws.governance()?.allow, false, "gate-wall DENIED the probation parent's promote");
  // ...and the run did not promote end-to-end.
  assert.equal(result.spawned, true);
  assert.equal(result.workerResult?.promoted, false, "a probation spawn does not promote");
});

// ── child identity carries spawnedFrom = parent ─────────────────────────────

test("child identity carries spawnedFrom = the spawning parent's agentId", async () => {
  const { parentCtx, resolveIdentity, childClaim } = makeCast({ parentTier: "trusted", childTier: "trusted" });
  const orch = fakeOrchestrator();
  const spawner = createSubagentSpawner({ resolveIdentity, childClaim, orchestrator: orch.orchestrator, publish: () => {} });

  const result = await spawner.spawn({ parentCtx, task });
  assert.equal(result.childIdentitySummary?.spawnedFrom, "parent-1");
  assert.equal(orch.calls[0]?.identity.identity.spawnedFrom, "parent-1", "the run's parent identity is spawned under parent-1");
});

// ── defense-in-depth: invariant fires if a child out-ranks the ceiling ───────

test("defense-in-depth: a resolved child that out-ranks the parent ceiling fails closed (throws), no run", async () => {
  // Parent probation, but the child credential is registered TRUSTED (more trusted).
  // The clamp ceiling is probation; the resolved child out-ranks it ⇒ escalation throw.
  const { parentCtx, resolveIdentity, childClaim } = makeCast({ parentTier: "probation", childTier: "trusted" });
  const orch = fakeOrchestrator();
  const spawner = createSubagentSpawner({ resolveIdentity, childClaim, orchestrator: orch.orchestrator, publish: () => {} });

  await assert.rejects(
    () => spawner.spawn({ parentCtx, task }),
    (e: unknown) => e instanceof SpawnError && e.kind === "escalation",
  );
  assert.equal(orch.calls.length, 0, "the over-privileged subagent never ran");
});

// ── fail-closed refusals ─────────────────────────────────────────────────────

test("a disabled spawner refuses (fail-closed) and never calls the orchestrator", async () => {
  const { parentCtx, resolveIdentity, childClaim } = makeCast({ parentTier: "trusted", childTier: "trusted" });
  const orch = fakeOrchestrator();
  const ev = captureEvents();
  const spawner = createSubagentSpawner({
    config: { enabled: false },
    resolveIdentity,
    childClaim,
    orchestrator: orch.orchestrator,
    publish: ev.publish,
  });

  const result = await spawner.spawn({ parentCtx, task });
  assert.equal(result.spawned, false);
  assert.match(result.reason ?? "", /disabled/);
  assert.equal(orch.calls.length, 0, "a disabled spawner spawns nothing");
  assert.ok(ev.types().includes("subagent.spawn.denied"));
});

test("a non-validated parent identity is refused (fail-closed), no run", async () => {
  const { resolveIdentity, childClaim } = makeCast({ parentTier: "trusted", childTier: "trusted" });
  const orch = fakeOrchestrator();
  // A structurally-plausible but NON-minted (forged) identity → isValidatedIdentity false.
  const fakeCtx = {
    contractVersion: "1.1.0",
    identity: { kind: "agent", identity: { agentId: "spoof", trustTier: "operator" }, authMethod: "agent_token", resolvedAt: 0 },
    startedAt: 0,
  } as unknown as OperationContext;
  const spawner = createSubagentSpawner({ resolveIdentity, childClaim, orchestrator: orch.orchestrator, publish: () => {} });

  const result = await spawner.spawn({ parentCtx: fakeCtx, task });
  assert.equal(result.spawned, false);
  assert.match(result.reason ?? "", /validated identity/);
  assert.equal(orch.calls.length, 0);
});

// ── lifecycle events ─────────────────────────────────────────────────────────

test("a successful spawn emits requested + completed with source subagent-spawning", async () => {
  const { parentCtx, resolveIdentity, childClaim } = makeCast({ parentTier: "trusted", childTier: "trusted" });
  const orch = fakeOrchestrator();
  const ev = captureEvents();
  const spawner = createSubagentSpawner({ resolveIdentity, childClaim, orchestrator: orch.orchestrator, publish: ev.publish });

  await spawner.spawn({ parentCtx, task });
  assert.ok(ev.types().includes("subagent.spawn.requested"));
  assert.ok(ev.types().includes("subagent.spawn.completed"));
  for (const e of ev.sent) assert.equal(e.source, "subagent-spawning");
  const completed = ev.sent.find((e) => e.type === "subagent.spawn.completed");
  assert.equal(completed?.attribution?.identity?.agentId, "child-1", "completion attributed to the child");
  assert.equal(completed?.payload.spawnedFrom, "parent-1");
});

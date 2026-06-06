import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";

import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";

import type { EventBusSurface, EventInput, IkbiEvent } from "../../core/events/index.js";
import { beginOperation, IdentityResolver, isValidatedIdentity } from "../../core/identity/resolver.js";
import type { ValidatedIdentity } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { AgentRecord } from "../../core/identity/registry.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import type { OperationContext } from "../../core/identity/resolver.js";
import { autonomyForTier, asTier, type TrustDecision } from "../../core/trust/index.js";
import { tierRank, TRUST_FLOOR } from "../../core/trust/index.js";
import type { DiscardResult, PromoteGovernance, PromoteResult, WorkspaceEvaluation, WorkspaceHandle } from "../../core/workspace/contract.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import { integrator as realIntegrator } from "./integrator.js";
import {
  WORKER_ROLES,
  WorkerError,
  type RoleContext,
  type RoleFn,
  type WorkerOutcome,
  type WorkerRole,
  type WorkerTask,
} from "./contract.js";

const silent = () => pino({ level: "silent" });

/** Build a resolver over a fresh registry (mints REAL ValidatedIdentities). */
function makeResolver(agents: AgentRecord[]) {
  const registry = new AgentRegistry({ agents });
  return new IdentityResolver({ registry, logger: silent(), now: () => 1000 });
}

/** A parent context + a role-resolving function, both backed by one registry. */
function makeIdentities(parentTier: string, workerTier: string) {
  const resolver = makeResolver([
    { agentId: "parent-1", kind: "agent", functionalRole: "lead", defaultTrustTier: parentTier, tokenHashes: [hashToken("parent-secret")] },
    { agentId: "worker-1", kind: "agent", functionalRole: "worker", defaultTrustTier: workerTier, tokenHashes: [hashToken("worker-secret")] },
  ]);
  const parent = resolver.resolve({ token: "parent-secret" });
  const parentCtx = beginOperation(parent, { requestId: "req-1" });
  const resolveIdentity: NonNullable<OrchestratorDeps["resolveIdentity"]> = (claim, ctx) => resolver.resolve(claim, ctx);
  const roleClaim: NonNullable<OrchestratorDeps["roleClaim"]> = () => ({ token: "worker-secret" });
  return { parentCtx, resolveIdentity, roleClaim };
}

function fakeWorkspaceHandle(): WorkspaceHandle {
  return {
    id: "wsabcd",
    targetRepo: "/repo",
    baseBranch: "main",
    baseRef: "deadbeef",
    scratchBranch: "ikbi/ws/wsabcd",
    path: "/tmp/wsabcd",
    identity: { agentId: "parent-1" },
    state: "allocated",
    createdAt: 1000,
  };
}

function fakeWorkspaces(promoteOk = true) {
  const calls = { allocate: [] as unknown[], promote: 0, discard: 0 };
  const handle = fakeWorkspaceHandle();
  const workspaces: NonNullable<OrchestratorDeps["workspaces"]> = {
    allocate: async (opts) => {
      calls.allocate.push(opts);
      return handle;
    },
    promote: async (h): Promise<PromoteResult> => {
      calls.promote += 1;
      return promoteOk
        ? { promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }
        : { promoted: false, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", conflicts: ["x.ts"], reason: "conflict" };
    },
    discard: async (h): Promise<DiscardResult> => {
      calls.discard += 1;
      return { workspaceId: h.id, removed: true };
    },
  };
  return { workspaces, calls, handle };
}

function fakeTrust() {
  const calls: Array<{ agentId: string; operation: string; status: string; subject: ValidatedIdentity }> = [];
  const trust = {
    recordOutcome: async (
      input: { agentId: string; operation: string; status: string; defaultTrustTier: string },
      subject: ValidatedIdentity,
    ): Promise<TrustDecision> => {
      calls.push({ agentId: input.agentId, operation: input.operation, status: input.status, subject });
      const tier = asTier(input.defaultTrustTier, TRUST_FLOOR);
      return { agentId: input.agentId, tier, previousTier: tier, autonomy: autonomyForTier(tier) };
    },
  };
  return { trust, calls };
}

function fakeReceipts() {
  const calls: Array<{ operation: string; agentId: string; spawnedFrom?: string }> = [];
  const receipts = {
    append: async (input: unknown, identity: AgentIdentity): Promise<unknown> => {
      const op = (input as { operation: string }).operation;
      calls.push({ operation: op, agentId: identity.agentId, ...(identity.spawnedFrom !== undefined ? { spawnedFrom: identity.spawnedFrom } : {}) });
      return {};
    },
  };
  return { receipts, calls };
}

function fakeBus() {
  const sent: Array<EventInput<unknown>> = [];
  const bus: EventBusSurface = {
    publish: <P>(input: EventInput<P>): IkbiEvent<P> => {
      sent.push(input as EventInput<unknown>);
      return { ...input, contractVersion: "1.0.0", id: `e${sent.length}`, seq: sent.length, timestamp: 0 } as IkbiEvent<P>;
    },
    subscribe: () => ({ id: "sub", unsubscribe: () => {}, stats: () => ({ delivered: 0, dropped: 0, failures: 0, queued: 0 }) }),
    flush: async () => {},
  };
  return { bus, sent };
}

/** Capturing role set that records each RoleContext and returns a chosen outcome. */
function capturingRoles(outcomeFor: (role: WorkerRole) => WorkerOutcome = () => "success") {
  const seen: RoleContext[] = [];
  const roles: Partial<Record<WorkerRole, RoleFn>> = {};
  for (const r of WORKER_ROLES) {
    roles[r] = async (ctx) => {
      seen.push(ctx);
      const outcome = outcomeFor(r);
      // The integrator returns a well-formed PROMOTE decision by default so the
      // orchestrator's decision wiring promotes on the happy path.
      if (r === "integrator" && outcome === "success") {
        return { role: r, outcome, summary: r, detail: { decision: "promote", rationale: "test: promote", evaluation: { approved: true } } };
      }
      return { role: r, outcome, summary: r };
    };
  }
  return { seen, roles };
}

const ENABLED = { enabled: true, roleTimeoutMs: 1000, maxConcurrentRuns: 1 };
const task: WorkerTask = { taskId: "t-1", targetRepo: "/repo", goal: "do the thing" };

/** An ALLOWING gate-wall — the wired/governed path (production wires the real gate-wall). */
const allowGate: NonNullable<OrchestratorDeps["gateWall"]> = { evaluate: async (): Promise<PromoteGovernance> => ({ allow: true, reason: "test gate allows" }) };

/** Strip the wired gate-wall entirely — simulates the unwired/misconfig path (H5). */
function omitGate(d: OrchestratorDeps): OrchestratorDeps {
  const copy = { ...d };
  delete (copy as { gateWall?: unknown }).gateWall;
  return copy;
}

function baseDeps(extra: Partial<OrchestratorDeps>): OrchestratorDeps {
  const ws = fakeWorkspaces();
  const tr = fakeTrust();
  const rc = fakeReceipts();
  const bus = fakeBus();
  return {
    config: ENABLED,
    workspaces: ws.workspaces,
    trust: tr.trust,
    receipts: rc.receipts,
    events: bus.bus,
    // A promote REQUIRES gate-wall authorization (H5). Default to a wired ALLOWING gate so
    // the happy-path promote tests exercise the GOVERNED path; H5 tests pass `gateWall: undefined`.
    gateWall: allowGate,
    invokeModel: async () => {
      throw new Error("invokeModel not used in these tests");
    },
    ...extra,
  };
}

// ── disabled-config behavior (explicit error) ──────────────────────────────

test("a disabled worker-model throws WorkerError(disabled) — no silent no-op", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const orch = createOrchestrator(baseDeps({ config: { ...ENABLED, enabled: false }, resolveIdentity, roleClaim }));
  await assert.rejects(() => orch.run(task, parentCtx), (e: unknown) => e instanceof WorkerError && e.kind === "disabled");
});

// ── identity validation ────────────────────────────────────────────────────

test("run rejects a context that does not carry a validated identity", async () => {
  const { resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const fakeCtx = {
    contractVersion: "1.1.0",
    identity: { kind: "agent", identity: { agentId: "spoof", trustTier: "operator" }, authMethod: "agent_token", resolvedAt: 0 },
    startedAt: 0,
  } as unknown as OperationContext;
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim }));
  await assert.rejects(() => orch.run(task, fakeCtx), (e: unknown) => e instanceof WorkerError && e.kind === "identity");
});

// ── #10 ANTI-ESCALATION (the load-bearing test) ────────────────────────────

test("#10: a spawned role can NEVER exceed the parent's tier (clamped down)", async () => {
  // Parent at "probation"; the worker role agent is registered "trusted".
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("probation", "trusted");
  const cap = capturingRoles();
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles: cap.roles }));
  await orch.run(task, parentCtx);

  assert.equal(cap.seen.length, 5, "all roles dispatched");
  for (const ctx of cap.seen) {
    assert.equal(ctx.identity.trustTier, "probation", `role ${ctx.role} clamped to parent tier, not "trusted"`);
    assert.ok(
      tierRank(asTier(ctx.identity.trustTier ?? TRUST_FLOOR, TRUST_FLOOR)) >= tierRank("probation"),
      "role tier never out-ranks the parent",
    );
    // The autonomy follows the clamped tier (probation ⇒ sandboxed).
    assert.equal(ctx.autonomy.sandboxed, true);
  }
});

test("#10: clamping holds across parent tiers; a lower role tier is left unchanged", async () => {
  // Parent "verified", worker registered "trusted" ⇒ role clamped to "verified".
  {
    const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("verified", "trusted");
    const cap = capturingRoles();
    const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles: cap.roles }));
    await orch.run(task, parentCtx);
    for (const ctx of cap.seen) assert.equal(ctx.identity.trustTier, "verified");
  }
  // Parent "trusted", worker registered "probation" ⇒ role stays "probation" (below parent, not raised).
  {
    const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "probation");
    const cap = capturingRoles();
    const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles: cap.roles }));
    await orch.run(task, parentCtx);
    for (const ctx of cap.seen) assert.equal(ctx.identity.trustTier, "probation");
  }
});

// ── dispatch order + spawnedFrom propagation ───────────────────────────────

test("roles dispatch in canonical order, each carrying spawnedFrom = parent", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const cap = capturingRoles();
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles: cap.roles }));
  await orch.run(task, parentCtx);

  assert.deepEqual(cap.seen.map((c) => c.role), ["scout", "builder", "critic", "verifier", "integrator"]);
  for (const ctx of cap.seen) {
    assert.equal(ctx.identity.spawnedFrom, "parent-1", "spawned under the parent");
    assert.equal(ctx.identity.functionalRole, ctx.role, "functionalRole set to the role");
  }
});

// ── workspace lifecycle: promote on success / discard on failure ───────────

test("success path: workspace allocated then PROMOTED (not discarded)", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = fakeWorkspaces(true);
  const cap = capturingRoles();
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles: cap.roles, workspaces: ws.workspaces }));
  const result = await orch.run(task, parentCtx);

  assert.equal(ws.calls.allocate.length, 1, "allocated once");
  assert.equal(ws.calls.promote, 1, "promoted");
  assert.equal(ws.calls.discard, 0, "not discarded");
  assert.equal(result.outcome, "success");
  assert.equal(result.promoted, true);
  assert.equal(result.workspaceId, "wsabcd");
});

test("failure path: a role failure short-circuits, workspace DISCARDED (not promoted)", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = fakeWorkspaces(true);
  const cap = capturingRoles((r) => (r === "builder" ? "failure" : "success"));
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles: cap.roles, workspaces: ws.workspaces }));
  const result = await orch.run(task, parentCtx);

  assert.deepEqual(cap.seen.map((c) => c.role), ["scout", "builder"], "short-circuited after builder");
  assert.equal(ws.calls.promote, 0, "not promoted");
  assert.equal(ws.calls.discard, 1, "discarded");
  assert.equal(result.outcome, "failure");
  assert.equal(result.promoted, false);
});

test("promote conflict downgrades the run to partial (not promoted)", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = fakeWorkspaces(false); // promote returns promoted:false (conflict)
  const cap = capturingRoles();
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles: cap.roles, workspaces: ws.workspaces }));
  const result = await orch.run(task, parentCtx);
  assert.equal(result.outcome, "partial");
  assert.equal(result.promoted, false);
  assert.equal(ws.calls.discard, 0, "a conflict is reconcilable — the workspace is NOT discarded");
});

// ── receipts + trust attributed to the ROLE identity ───────────────────────

test("each role's outcome is recorded to receipts + trust under the ROLE identity", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const tr = fakeTrust();
  const rc = fakeReceipts();
  const cap = capturingRoles();
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles: cap.roles, trust: tr.trust, receipts: rc.receipts }));
  await orch.run(task, parentCtx);

  assert.equal(rc.calls.length, 5, "one receipt per role");
  assert.equal(tr.calls.length, 5, "one trust outcome per role");
  for (const c of rc.calls) {
    assert.equal(c.agentId, "worker-1", "receipt attributed to the role identity");
    assert.equal(c.spawnedFrom, "parent-1", "role identity carries spawnedFrom");
  }
  assert.deepEqual(tr.calls.map((c) => c.operation), WORKER_ROLES.map((r) => `worker.role.${r}`));
  for (const c of tr.calls) assert.equal(c.status, "success");
  // The orchestrator THREADS the genuine ValidatedIdentity as the recordOutcome subject
  // (provenance): every call carries a real minted identity matching the recorded agent.
  for (const c of tr.calls) {
    assert.ok(isValidatedIdentity(c.subject), "a genuine ValidatedIdentity subject is threaded to recordOutcome");
    assert.equal(c.subject.identity.agentId, c.agentId, "the subject identity matches the recorded agentId");
  }
});

// ── events: source + identity attribution ──────────────────────────────────

test("worker.* events emit with source worker-model and identity attribution", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const bus = fakeBus();
  const cap = capturingRoles();
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles: cap.roles, events: bus.bus }));
  await orch.run(task, parentCtx);

  const types = bus.sent.map((e) => e.type);
  assert.ok(types.includes("worker.started"));
  assert.equal(types.filter((t) => t === "worker.role.dispatched").length, 5);
  assert.equal(types.filter((t) => t === "worker.role.completed").length, 5);
  assert.ok(types.includes("worker.completed"));

  for (const e of bus.sent) assert.equal(e.source, "worker-model");

  const started = bus.sent.find((e) => e.type === "worker.started");
  assert.equal(started?.attribution?.identity?.agentId, "parent-1", "run events attributed to parent");
  const dispatched = bus.sent.find((e) => e.type === "worker.role.dispatched");
  assert.equal(dispatched?.attribution?.identity?.agentId, "worker-1", "role events attributed to the role identity");
  assert.equal(dispatched?.attribution?.identity?.spawnedFrom, "parent-1");
});

test("a failed run emits worker.failed", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const bus = fakeBus();
  const cap = capturingRoles((r) => (r === "scout" ? "failure" : "success"));
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles: cap.roles, events: bus.bus }));
  await orch.run(task, parentCtx);
  assert.ok(bus.sent.some((e) => e.type === "worker.failed"));
  assert.ok(!bus.sent.some((e) => e.type === "worker.completed"));
});

// ── integration: real Pass-A roles + still-stubbed builder/integrator ───────

function okModelResponse(): ModelResponse {
  return {
    contractVersion: "1.1.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
    content: "PASS\n- a finding", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}

/** The real builder now REQUIRES a green run_checks then a `done` self-check to finish. */
function doneModelResponse(): ModelResponse {
  return {
    ...okModelResponse(),
    content: "",
    finishReason: "tool_calls",
    toolCalls: [{ id: "done1", name: "done", arguments: JSON.stringify({ successCondition: "do the thing", filesReadBack: ["a.ts"], selfCheck: "re-read a.ts and ran checks green; the goal is met", satisfied: true }) }],
  };
}
function runChecksModelResponse(): ModelResponse {
  return { ...okModelResponse(), content: "", finishReason: "tool_calls", toolCalls: [{ id: "rc1", name: "run_checks", arguments: "{}" }] };
}

/**
 * Builder offers a `done` tool; scout/critic offer no tools → plain stop. The builder
 * must run_checks (green) BEFORE done, so its first turn is run_checks, its second is done.
 */
function makeBuilderAwareModel(): (req: ModelRequest) => Promise<ModelResponse> {
  let builderTurn = 0;
  return async (req) => {
    if (!(req.tools ?? []).some((t) => t.name === "done")) return okModelResponse(); // scout/critic
    builderTurn += 1;
    return builderTurn === 1 ? runChecksModelResponse() : doneModelResponse();
  };
}
/** A GREEN governed exec so the builder's in-loop run_checks passes (the verifier is stubbed here). */
const greenGovernedExec = { run: async () => ({ executed: true as const, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) };

test("real scout/builder/critic + stubbed verifier/integrator → coherent success → promote", async () => {
  // scout, builder, critic are now REAL roles. Give them a real workspace dir + a
  // working model. verifier/integrator are overridden here ONLY so the real verifier
  // does not spawn `pnpm` in a unit test (verifier is exercised in verifier.test.ts);
  // they are not the subject of this pass.
  const dir = mkdtempSync(join(tmpdir(), "ikbi-orch-"));
  writeFileSync(join(dir, "a.ts"), "export const a = 1;");
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");

  const handle: WorkspaceHandle = { ...fakeWorkspaceHandle(), id: "wsabcd", path: dir, targetRepo: dir };
  const calls = { promote: 0, discard: 0 };
  const workspaces: NonNullable<OrchestratorDeps["workspaces"]> = {
    allocate: async () => handle,
    promote: async (h): Promise<PromoteResult> => {
      calls.promote += 1;
      return { promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" };
    },
    discard: async (): Promise<DiscardResult> => {
      calls.discard += 1;
      return { workspaceId: handle.id, removed: true };
    },
  };
  const roles: Partial<Record<WorkerRole, RoleFn>> = {
    verifier: async () => ({ role: "verifier", outcome: "success", summary: "checks ok (stubbed in test)" }),
    integrator: async () => ({
      role: "integrator",
      outcome: "success",
      summary: "promote ok (stubbed in test)",
      detail: { decision: "promote", rationale: "stubbed promote", evaluation: { approved: true } },
    }),
  };

  const orch = createOrchestrator(
    baseDeps({ resolveIdentity, roleClaim, workspaces, roles, invokeModel: makeBuilderAwareModel(), governedExec: greenGovernedExec }),
  );
  const result = await orch.run({ taskId: "t-1", targetRepo: dir, goal: "do the thing" }, parentCtx);

  // All five roles succeed → orchestrator promotes.
  assert.equal(result.outcome, "success");
  assert.equal(calls.promote, 1);
  assert.equal(calls.discard, 0);
  assert.deepEqual(result.roles.map((r) => r.role), ["scout", "builder", "critic", "verifier", "integrator"]);
  for (const r of result.roles) assert.equal(r.outcome, "success", `${r.role} succeeded`);
  // Builder really ran its (real) loop — it ran its in-loop run_checks (the verifier's
  // shared checks) green before done. The run_checks output is one neutralized tool result.
  const builderDetail = result.roles[1]?.detail as { neutralizedCount: number; checksRuns: number; doneClaim?: { checksPassed: boolean } } | undefined;
  assert.equal(builderDetail?.checksRuns, 1, "the builder ran run_checks in-loop");
  assert.equal(builderDetail?.neutralizedCount, 1, "the run_checks output was neutralized (the chokepoint)");
  assert.equal(builderDetail?.doneClaim?.checksPassed, true, "the builder claims green checks; the verifier still ran independently");
});

// ── Pass C: integrator decision wiring ─────────────────────────────────────

/** scout/builder/critic/verifier as plain success fakes (orchestrator reads only integrator). */
const successFakes = (): Partial<Record<WorkerRole, RoleFn>> => ({
  scout: async () => ({ role: "scout", outcome: "success", summary: "s" }),
  builder: async () => ({ role: "builder", outcome: "success", summary: "b" }),
  critic: async () => ({ role: "critic", outcome: "success", summary: "c" }),
  verifier: async () => ({ role: "verifier", outcome: "success", summary: "v" }),
});

test("LATENT-BUG FIX: all roles succeed but critic pass=false → integrator discards → NO promote", async () => {
  // The load-bearing test. The REAL integrator weighs a pass=false critique and
  // decides discard; the orchestrator must enact that, not promote on overall==success.
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = fakeWorkspaces(true);
  const roles: Partial<Record<WorkerRole, RoleFn>> = {
    scout: async () => ({ role: "scout", outcome: "success", summary: "s" }),
    builder: async () => ({ role: "builder", outcome: "success", summary: "b", detail: { filesWritten: ["a.ts"], rejectedToolCalls: [] } }),
    critic: async () => ({ role: "critic", outcome: "success", summary: "c", detail: { pass: false, feedback: "not good" } }),
    verifier: async () => ({ role: "verifier", outcome: "success", summary: "v", detail: { verdict: "pass", checks: [] } }),
    integrator: realIntegrator,
  };
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, workspaces: ws.workspaces, roles }));
  const result = await orch.run(task, parentCtx);

  assert.equal(ws.calls.promote, 0, "a pass=false critique is NOT promoted (bug closed)");
  assert.equal(ws.calls.discard, 1, "discarded instead");
  assert.equal(result.promoted, false);
  const integ = result.roles.find((r) => r.role === "integrator");
  assert.equal(integ?.outcome, "success", "integrator did its job (reached a decision)");
  assert.equal((integ?.detail as { decision: string }).decision, "discard");
});

test("happy path: orchestrator promotes with the evaluation SOURCED from the integrator", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  let captured: { evaluation: WorkspaceEvaluation; message?: string } | undefined;
  const handle = fakeWorkspaceHandle();
  const calls = { discard: 0 };
  const workspaces: NonNullable<OrchestratorDeps["workspaces"]> = {
    allocate: async () => handle,
    promote: async (h, approval): Promise<PromoteResult> => {
      captured = approval;
      return { promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" };
    },
    discard: async (h): Promise<DiscardResult> => {
      calls.discard += 1;
      return { workspaceId: h.id, removed: true };
    },
  };
  const roles: Partial<Record<WorkerRole, RoleFn>> = {
    ...successFakes(),
    integrator: async () => ({
      role: "integrator",
      outcome: "success",
      summary: "promote",
      detail: { decision: "promote", rationale: "all gates pass", evaluation: { approved: true, reason: "from-integrator", score: 0.91 } },
    }),
  };
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, workspaces, roles }));
  const result = await orch.run(task, parentCtx);

  assert.equal(result.promoted, true);
  assert.equal(calls.discard, 0);
  assert.equal(captured?.evaluation.approved, true);
  assert.equal(captured?.evaluation.reason, "from-integrator", "evaluation came from the integrator, not a hardcoded {approved:true}");
  assert.equal(captured?.evaluation.score, 0.91);
  assert.match(captured?.message ?? "", /all gates pass/);
});

test("fail-closed: a promote decision with a malformed/absent evaluation → discard, no promote, no throw", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = fakeWorkspaces(true);
  const roles: Partial<Record<WorkerRole, RoleFn>> = {
    ...successFakes(),
    // decision says promote but there is NO approving evaluation → must fail closed.
    integrator: async () => ({ role: "integrator", outcome: "success", summary: "x", detail: { decision: "promote" } }),
  };
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, workspaces: ws.workspaces, roles }));
  const result = await orch.run(task, parentCtx);
  assert.equal(ws.calls.promote, 0);
  assert.equal(ws.calls.discard, 1);
  assert.equal(result.promoted, false);
});

test("fail-closed: an integrator that errored (outcome failure) → discard", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = fakeWorkspaces(true);
  const roles: Partial<Record<WorkerRole, RoleFn>> = {
    ...successFakes(),
    integrator: async () => ({ role: "integrator", outcome: "failure", summary: "boom", detail: { decision: "promote", evaluation: { approved: true } } }),
  };
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, workspaces: ws.workspaces, roles }));
  await orch.run(task, parentCtx);
  assert.equal(ws.calls.promote, 0, "a failed integrator never promotes, even if detail says promote");
  assert.equal(ws.calls.discard, 1);
});

test("short-circuit: a builder hard-failure → integrator never runs → discard, no promote", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = fakeWorkspaces(true);
  const roles: Partial<Record<WorkerRole, RoleFn>> = {
    ...successFakes(),
    builder: async () => ({ role: "builder", outcome: "failure", summary: "boom" }),
    integrator: realIntegrator,
  };
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, workspaces: ws.workspaces, roles }));
  const result = await orch.run(task, parentCtx);
  assert.equal(ws.calls.promote, 0);
  assert.equal(ws.calls.discard, 1);
  assert.ok(!result.roles.some((r) => r.role === "integrator"), "integrator never dispatched (loop broke at builder)");
});

// ── P1: gate-wall governance wiring ────────────────────────────────────────

/** A workspaces fake that captures the promote approval (incl. governance). */
function capturingWorkspaces() {
  let approval: { evaluation: WorkspaceEvaluation; governance?: PromoteGovernance; message?: string } | undefined;
  const calls = { discard: 0 };
  const handle = fakeWorkspaceHandle();
  const workspaces: NonNullable<OrchestratorDeps["workspaces"]> = {
    allocate: async () => handle,
    promote: async (h, a): Promise<PromoteResult> => {
      approval = a;
      return { promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" };
    },
    discard: async (h): Promise<DiscardResult> => {
      calls.discard += 1;
      return { workspaceId: h.id, removed: true };
    },
  };
  return { workspaces, captured: () => approval, calls };
}

test("gate-wall wired: a DENYING gateWall → governance.allow=false reaches promote", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = capturingWorkspaces();
  const gateWall = { evaluate: async (): Promise<PromoteGovernance> => ({ allow: false, reason: "denied by policy", gateId: "g1" }) };
  const cap = capturingRoles();
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, workspaces: ws.workspaces, gateWall, roles: cap.roles }));
  await orch.run(task, parentCtx);
  assert.equal(ws.captured()?.governance?.allow, false, "the deny verdict is passed into promote");
  assert.match(ws.captured()?.governance?.reason ?? "", /denied by policy/);
});

test("gate-wall wired: an ALLOWING gateWall → governance.allow=true reaches promote", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = capturingWorkspaces();
  const gateWall = { evaluate: async (): Promise<PromoteGovernance> => ({ allow: true, reason: "permitted", gateId: "g2" }) };
  const cap = capturingRoles();
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, workspaces: ws.workspaces, gateWall, roles: cap.roles }));
  await orch.run(task, parentCtx);
  assert.equal(ws.captured()?.governance?.allow, true);
});

test("H5: NO gate-wall dep → the promote is DENIED fail-closed (never advisory-allowed); workspace discarded, NOT promoted", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = capturingWorkspaces();
  const cap = capturingRoles(); // integrator returns a well-formed PROMOTE decision
  // omitGate strips baseDeps' wired-allow default → the unwired/misconfig path.
  const orch = createOrchestrator(omitGate(baseDeps({ resolveIdentity, roleClaim, workspaces: ws.workspaces, roles: cap.roles })));
  const result = await orch.run(task, parentCtx);

  assert.equal(result.promoted, false, "nothing promoted without gate-wall authorization");
  assert.equal(result.outcome, "rejected", "an unwired gate-wall denies fail-closed");
  assert.match(result.reason ?? "", /gate-wall not wired/);
  assert.equal(ws.captured(), undefined, "promote() was NEVER called — the promote did not proceed");
  assert.equal(ws.calls.discard, 1, "the workspace was discarded (nothing lands on the target branch)");
});

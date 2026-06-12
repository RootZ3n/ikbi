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
  type RoleResult,
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
  const calls = { allocate: [] as unknown[], promote: 0, discard: 0, commit: [] as Array<{ id: string; message: string }> };
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
    commit: async (h, message): Promise<boolean> => {
      calls.commit.push({ id: h.id, message });
      return true; // the working tree had changes → committed
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
  // The VERIFIED work was committed (autoCommit, trusted) so promote sees a non-empty diff.
  assert.equal(ws.calls.commit.length, 1, "committed once (the verified-good state)");
});

test("COMMIT after verifier on a trusted (autoCommit) success — captured AFTER verifier, BEFORE the integrator", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = fakeWorkspaces(true);
  const seq: string[] = [];
  const cap = capturingRoles();
  const roles = {
    ...cap.roles,
    verifier: async (ctx: RoleContext) => { seq.push("verifier"); return cap.roles.verifier!(ctx); },
    integrator: async (ctx: RoleContext) => { seq.push("integrator"); return cap.roles.integrator!(ctx); },
  };
  const wrapped = { ...ws.workspaces, commit: async (h: WorkspaceHandle, m: string): Promise<boolean> => { seq.push("commit"); ws.calls.commit.push({ id: h.id, message: m }); return true; } };
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles, workspaces: wrapped }));
  await orch.run(task, parentCtx);

  assert.equal(ws.calls.commit.length, 1, "committed exactly once");
  assert.equal(ws.calls.commit[0]?.id, "wsabcd", "the run's workspace");
  assert.match(ws.calls.commit[0]?.message ?? "", /do the thing/, "commit message carries the goal prose");
  assert.deepEqual(seq, ["verifier", "commit", "integrator"], "commit lands AFTER the verifier and BEFORE the integrator promotes");
});

test("NO COMMIT for a non-autoCommit tier (verified) — the autonomy model is respected", async () => {
  // worker at 'verified' → autoCommit:false (and requiresApproval:false, so it proceeds).
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("verified", "verified");
  const ws = fakeWorkspaces(true);
  const cap = capturingRoles();
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles: cap.roles, workspaces: ws.workspaces }));
  await orch.run(task, parentCtx);
  assert.equal(ws.calls.commit.length, 0, "a non-autoCommit tier is NOT auto-committed");
});

test("verified-good but non-autoCommit tier: RETAIN + actionable reason, never a silent 'no changes to promote'", async () => {
  // A build that passes EVERY role but whose tier lacks autoCommit must not vanish behind a
  // misleading empty-diff promote. The autonomy model is still respected (no commit), but the
  // operator gets a clear, actionable outcome instead of "no changes to promote".
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("verified", "verified");
  const ws = fakeWorkspaces(true);
  const cap = capturingRoles(); // every role succeeds
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles: cap.roles, workspaces: ws.workspaces }));
  const result = await orch.run(task, parentCtx);

  assert.equal(ws.calls.commit.length, 0, "autonomy respected: still no auto-commit");
  assert.equal(ws.calls.promote, 0, "no misleading empty-diff promote attempt");
  assert.equal(result.promoted, false, "nothing landed");
  assert.equal(result.outcome, "partial", "surfaced as partial, not a silent failure/success");
  // ISSUE 2: the blocked-promotion message states all four facts explicitly.
  assert.match(result.reason ?? "", /verification PASSED/i, "says verification passed");
  assert.match(result.reason ?? "", /BLOCKED/i, "says promotion was blocked");
  assert.match(result.reason ?? "", /autoCommit/, "gives the exact reason (no autoCommit autonomy)");
  assert.match(result.reason ?? "", /ikbi trust grant .+ trusted/, "gives the exact operator command");
});

// ── ISSUE 1: performance failures (timeouts) are separated from trust demotion ───
function capturingTrust() {
  const calls: Array<{ operation: string; status: string }> = [];
  const trust = {
    recordOutcome: async (i: { agentId: string; defaultTrustTier: string; operation: string; status: string }): Promise<TrustDecision> => {
      calls.push({ operation: i.operation, status: i.status });
      const t = asTier(i.defaultTrustTier, TRUST_FLOOR);
      return { agentId: i.agentId, tier: t, previousTier: t, autonomy: autonomyForTier(t) };
    },
  };
  return { trust, calls };
}

test("ISSUE 1: a builder TIMEOUT does NOT feed the trust signal (no demotion) and writes an explicit suppression receipt", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const roles: Partial<Record<WorkerRole, RoleFn>> = {
    scout: async () => ({ role: "scout", outcome: "success", summary: "s" }),
    // a wall-clock timeout: classifyOutcome → failure, detail.stopReason === "timeout"
    builder: async () => ({ role: "builder", outcome: "failure", summary: "timed out", detail: { stopReason: "timeout" } }),
  };
  const tr = capturingTrust();
  const rc = fakeReceipts();
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles, trust: tr.trust, receipts: rc.receipts }));
  await orch.run(task, parentCtx);

  assert.equal(tr.calls.filter((c) => c.operation === "worker.role.builder").length, 0, "the builder timeout did NOT feed a trust signal");
  assert.ok(rc.calls.some((c) => c.operation === "worker.trust.signal_suppressed"), "an explicit suppression receipt was written");
});

test("ISSUE 1: with PENALIZE_TIMEOUTS policy on, a timeout IS counted as a trust failure", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const roles: Partial<Record<WorkerRole, RoleFn>> = {
    scout: async () => ({ role: "scout", outcome: "success", summary: "s" }),
    builder: async () => ({ role: "builder", outcome: "failure", summary: "timed out", detail: { stopReason: "timeout" } }),
  };
  const tr = capturingTrust();
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles, trust: tr.trust, config: { ...ENABLED, penalizeTimeouts: true } }));
  await orch.run(task, parentCtx);

  assert.equal(
    tr.calls.filter((c) => c.operation === "worker.role.builder" && c.status === "failure").length,
    1,
    "policy on → the timeout IS a trust failure signal",
  );
});

test("ISSUE 1: a REAL failure (failed verification) still feeds the trust signal regardless of policy", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  // scout+builder+critic succeed; the verifier (failed checks) is the real failure — no timeout.
  const cap = capturingRoles();
  const roles: Partial<Record<WorkerRole, RoleFn>> = {
    ...cap.roles,
    verifier: async () => ({ role: "verifier", outcome: "failure", summary: "checks failed", detail: { verdict: "fail", checks: [{ name: "test", exitCode: 1 }] } }),
  };
  const tr = capturingTrust();
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles, trust: tr.trust }));
  await orch.run(task, parentCtx);

  assert.equal(
    tr.calls.filter((c) => c.operation === "worker.role.verifier" && c.status === "failure").length,
    1,
    "a failed verification is a real failure → always a trust signal",
  );
});

// ── R1: max_iterations is only suppressible WITHOUT bad-output evidence ───────────
test("R1: max_iterations with NO bad-output evidence is suppressed (treated as performance)", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const roles: Partial<Record<WorkerRole, RoleFn>> = {
    scout: async () => ({ role: "scout", outcome: "success", summary: "s" }),
    builder: async () => ({ role: "builder", outcome: "failure", summary: "no convergence", detail: { stopReason: "max_iterations", rejectedToolCalls: [] } }),
  };
  const tr = capturingTrust();
  const rc = fakeReceipts();
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles, trust: tr.trust, receipts: rc.receipts }));
  await orch.run(task, parentCtx);
  assert.equal(tr.calls.filter((c) => c.operation === "worker.role.builder").length, 0, "clean max_iterations did NOT feed a trust signal");
  assert.ok(rc.calls.some((c) => c.operation === "worker.trust.signal_suppressed"), "suppression receipt written");
});

test("R1: max_iterations WITH rejectedToolCalls (bad output) IS penalized + metadata explains why", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const roles: Partial<Record<WorkerRole, RoleFn>> = {
    scout: async () => ({ role: "scout", outcome: "success", summary: "s" }),
    builder: async () => ({
      role: "builder",
      outcome: "failure",
      summary: "flailing",
      detail: { stopReason: "max_iterations", rejectedToolCalls: [], toolFormatErrors: [{ tool: "write_file", error: "malformed tool arguments (not JSON)" }, { tool: "done", error: "checks not green" }] },
    }),
  };
  const tr = capturingTrust();
  const appended: Array<{ operation: string; metadata: Record<string, unknown> }> = [];
  const receipts = { append: async (input: unknown): Promise<unknown> => { const i = input as { operation: string; metadata?: Record<string, unknown> }; appended.push({ operation: i.operation, metadata: i.metadata ?? {} }); return {}; } };
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles, trust: tr.trust, receipts }));
  await orch.run(task, parentCtx);

  assert.equal(tr.calls.filter((c) => c.operation === "worker.role.builder" && c.status === "failure").length, 1, "bad-output max_iterations IS a trust failure signal");
  assert.ok(!appended.some((a) => a.operation === "worker.trust.signal_suppressed"), "no suppression receipt — it was penalized");
  const builderReceipt = appended.find((a) => a.operation === "worker.role.builder");
  assert.equal(builderReceipt?.metadata.performanceFailure, true, "metadata flags the performance-class failure");
  assert.equal(builderReceipt?.metadata.trustDecision, "penalized", "metadata records the penalize decision");
  assert.match(String(builderReceipt?.metadata.trustDecisionReason ?? ""), /tool format error/, "metadata explains WHY (bad-output evidence)");
});

test("R1: PENALIZE_TIMEOUTS policy penalizes BOTH timeout and a clean max_iterations", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  for (const stop of ["timeout", "max_iterations"] as const) {
    const roles: Partial<Record<WorkerRole, RoleFn>> = {
      scout: async () => ({ role: "scout", outcome: "success", summary: "s" }),
      builder: async () => ({ role: "builder", outcome: "failure", summary: stop, detail: { stopReason: stop, rejectedToolCalls: [] } }),
    };
    const tr = capturingTrust();
    const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles, trust: tr.trust, config: { ...ENABLED, penalizeTimeouts: true } }));
    await orch.run(task, parentCtx);
    assert.equal(tr.calls.filter((c) => c.operation === "worker.role.builder" && c.status === "failure").length, 1, `policy on → ${stop} IS a trust failure`);
  }
});

// ── R2: blocked-promotion message must match the ACTUAL workspace disposition ─────
test("R2: blocked-promotion message says RETAINED when the workspace is actually retained", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("verified", "verified");
  const cap = capturingRoles();
  const ws = fakeWorkspaces(true);
  const retainCalls: string[] = [];
  const wrapped = { ...ws.workspaces, retain: async (h: WorkspaceHandle): Promise<DiscardResult> => { retainCalls.push(h.id); return { workspaceId: h.id, removed: false }; } };
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles: cap.roles, workspaces: wrapped }));
  const result = await orch.run(task, parentCtx);

  assert.equal(result.outcome, "partial");
  assert.equal(retainCalls.length, 1, "retain was actually called");
  assert.equal(ws.calls.discard, 0, "not discarded");
  assert.match(result.reason ?? "", /RETAINED/, "message says retained");
  assert.doesNotMatch(result.reason ?? "", /DISCARDED/, "does not falsely claim discard");
});

test("R2: blocked-promotion message says DISCARDED when retention did not happen", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("verified", "verified");
  const cap = capturingRoles();
  const ws = fakeWorkspaces(true); // no `retain` method → cannot retain
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles: cap.roles, workspaces: ws.workspaces, config: { ...ENABLED, retainFailedWorkspaces: false } }));
  const result = await orch.run(task, parentCtx);

  assert.equal(result.outcome, "partial");
  assert.equal(ws.calls.discard, 1, "the workspace was discarded");
  assert.match(result.reason ?? "", /DISCARDED/, "message says discarded");
  assert.doesNotMatch(result.reason ?? "", /RETAINED/, "does not falsely claim retention");
  assert.match(result.reason ?? "", /no retained workspace/i, "tells the operator no workspace is available");
});

// ── ISSUE 3: a repair run persists root cause + fix rationale into the receipt ───
test("ISSUE 3: the builder's root cause + fix rationale land in the role receipt metadata", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const cap = capturingRoles();
  const roles: Partial<Record<WorkerRole, RoleFn>> = {
    ...cap.roles,
    builder: async () => ({
      role: "builder",
      outcome: "success",
      summary: "fixed",
      detail: {
        filesWritten: ["src/lib/calculations.ts"],
        doneClaim: { rootCause: "totalTokens omitted completionTokens", fixRationale: "added completionTokens back to the sum", checksPassed: true },
      },
    }),
  };
  // a receipts fake that captures full metadata (the shared one only records operation+agentId).
  const appended: Array<{ operation: string; metadata: Record<string, unknown> }> = [];
  const receipts = {
    append: async (input: unknown): Promise<unknown> => {
      const i = input as { operation: string; metadata?: Record<string, unknown> };
      appended.push({ operation: i.operation, metadata: i.metadata ?? {} });
      return {};
    },
  };
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles, receipts }));
  await orch.run(task, parentCtx);

  const builderReceipt = appended.find((a) => a.operation === "worker.role.builder");
  assert.ok(builderReceipt, "a builder role receipt was appended");
  assert.equal(builderReceipt?.metadata.rootCause, "totalTokens omitted completionTokens", "root cause persisted");
  assert.equal(builderReceipt?.metadata.fixRationale, "added completionTokens back to the sum", "fix rationale persisted");
  assert.deepEqual(builderReceipt?.metadata.filesChanged, ["src/lib/calculations.ts"], "files changed persisted");
});

test("NO COMMIT when a role fails (verified fails) — failed work is never committed", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = fakeWorkspaces(true);
  // The verifier FAILS → short-circuit before any commit.
  const cap = capturingRoles((r) => (r === "verifier" ? "failure" : "success"));
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles: cap.roles, workspaces: ws.workspaces }));
  const result = await orch.run(task, parentCtx);
  assert.notEqual(result.outcome, "success");
  assert.equal(ws.calls.commit.length, 0, "no commit on a verifier failure");
  assert.equal(ws.calls.discard, 1, "the failed work is discarded, not promoted");
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

test("Bug 2: a role failure RETAINS the workspace (not discarded) when the manager supports retain", async () => {
  // The builder may have written real files before failing; retention keeps the worktree on
  // disk for inspection. The orchestrator calls retain (not discard) when overall is a failure.
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = fakeWorkspaces(true);
  let retained = 0;
  let retainReason = "";
  const wrapped: NonNullable<OrchestratorDeps["workspaces"]> = {
    ...ws.workspaces,
    retain: async (h, reason): Promise<DiscardResult> => {
      retained += 1;
      retainReason = reason;
      return { workspaceId: h.id, removed: false };
    },
  };
  const cap = capturingRoles((r) => (r === "builder" ? "failure" : "success"));
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles: cap.roles, workspaces: wrapped }));
  const result = await orch.run(task, parentCtx);

  assert.equal(ws.calls.promote, 0, "not promoted");
  assert.equal(ws.calls.discard, 0, "a FAILED build is NOT discarded — its work is retained");
  assert.equal(retained, 1, "the failed build's workspace is retained for inspection");
  assert.match(retainReason, /failure/, "the retain reason reflects the failed outcome");
  assert.equal(result.outcome, "failure");
  assert.equal(result.promoted, false);
});

test("Bug 2: retention OFF restores eager discard on a failed build", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = fakeWorkspaces(true);
  let retained = 0;
  const wrapped: NonNullable<OrchestratorDeps["workspaces"]> = {
    ...ws.workspaces,
    retain: async (h): Promise<DiscardResult> => { retained += 1; return { workspaceId: h.id, removed: false }; },
  };
  const cap = capturingRoles((r) => (r === "builder" ? "failure" : "success"));
  const orch = createOrchestrator(
    baseDeps({ config: { ...ENABLED, retainFailedWorkspaces: false }, resolveIdentity, roleClaim, roles: cap.roles, workspaces: wrapped }),
  );
  await orch.run(task, parentCtx);
  assert.equal(retained, 0, "retention off ⇒ retain not called");
  assert.equal(ws.calls.discard, 1, "retention off ⇒ the failed build is discarded as before");
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
    if (builderTurn === 1) return { ...okModelResponse(), content: "", finishReason: "tool_calls", toolCalls: [{ id: "rd1", name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) }] };
    if (builderTurn === 2) return { ...okModelResponse(), content: "", finishReason: "tool_calls", toolCalls: [{ id: "w1", name: "write_file", arguments: JSON.stringify({ path: "a.ts", content: "export const a = 2;\n" }) }] };
    if (builderTurn === 3) return runChecksModelResponse();
    return doneModelResponse();
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
  // shared checks) green before done. run_checks output is ACTIONABLE feedback (not
  // inert-neutralized), so it does NOT count as a neutralized tool result.
  const builderDetail = result.roles[1]?.detail as { neutralizedCount: number; checksRuns: number; doneClaim?: { checksPassed: boolean } } | undefined;
  assert.equal(builderDetail?.checksRuns, 1, "the builder ran run_checks in-loop");
  assert.equal(builderDetail?.neutralizedCount, 2, "read_file and write_file results are neutralized as untrusted repo content; run_checks is actionable (not counted)");
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

test("gate-wall wired: a DENYING gateWall → stable rejection, workspace discarded, promote not called", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = capturingWorkspaces();
  const gateWall = { evaluate: async (): Promise<PromoteGovernance> => ({ allow: false, reason: "denied by policy", gateId: "g1" }) };
  const cap = capturingRoles();
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, workspaces: ws.workspaces, gateWall, roles: cap.roles }));
  const result = await orch.run(task, parentCtx);
  assert.equal(result.promoted, false);
  assert.equal(result.outcome, "rejected");
  assert.match(result.reason ?? "", /denied by policy/);
  assert.equal(ws.captured(), undefined, "promote() was never called on gate denial");
  assert.equal(ws.calls.discard, 1, "workspace discarded; no allocated leak");
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

// ── H2: the orchestrator installs deps through the HARDENED dependency-install module ──────────
test("H2: a fresh worktree installs via the injected dependency-install module (not an inline pnpm)", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  // a REAL worktree with package.json + a pnpm lockfile and NO node_modules → triggers install
  const dir = mkdtempSync(join(tmpdir(), "ikbi-h2-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", version: "1.0.0" }));
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

  const ws = fakeWorkspaces(true);
  const handle = { ...ws.handle, path: dir };
  const workspaces = { ...ws.workspaces, allocate: async () => handle };

  const installCalls: Array<{ path: string; pm: string | undefined }> = [];
  const dependencyInstall = {
    run: async (req: { workspace: { path: string }; packageManager?: string }) => {
      installCalls.push({ path: req.workspace.path, pm: req.packageManager });
      return { installed: true, exitCode: 0 };
    },
  } as unknown as NonNullable<OrchestratorDeps["dependencyInstall"]>;

  const cap = capturingRoles();
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles: cap.roles, workspaces, dependencyInstall }));
  await orch.run(task, parentCtx);

  assert.equal(installCalls.length, 1, "the hardened installer ran exactly once for the fresh worktree");
  assert.equal(installCalls[0]?.path, dir, "installed into the run's worktree");
  assert.equal(installCalls[0]?.pm, "pnpm", "a pnpm lockfile selects the pnpm frozen install");
});

// ── H3: a hung role is bounded by the per-role wall-clock timeout ──────────────────────────────
test("H3: a hung role is bounded by the per-role wall-clock timeout and fails the run", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = fakeWorkspaces(true);
  const cap = capturingRoles();
  // the scout hangs (a gated promise) — only the wall-clock timeout can end the role. We release
  // the gate AFTER the run so node:test sees no dangling pending promise (the orchestrator has
  // already abandoned it — JS cannot cancel, so we settle it ourselves for a clean test).
  let releaseScout: () => void = () => {};
  const scoutGate = new Promise<RoleResult>((resolve) => {
    releaseScout = () => resolve({ role: "scout", outcome: "success", summary: "late (ignored)" });
  });
  const roles = { ...cap.roles, scout: (): Promise<RoleResult> => scoutGate };
  const orch = createOrchestrator(baseDeps({ config: { ...ENABLED, roleTimeoutMs: 50 }, resolveIdentity, roleClaim, roles, workspaces: ws.workspaces }));

  const result = await orch.run(task, parentCtx);
  assert.notEqual(result.outcome, "success", "a hung role never promotes");
  const scoutRole = result.roles.find((r) => r.role === "scout");
  assert.equal(scoutRole?.outcome, "failure", "the hung scout was failed by the wall-clock timeout");
  assert.match(scoutRole?.summary ?? "", /timeout/i, "the failure summary names the timeout");
  releaseScout();
  await scoutGate;
});

// ── STEP-PLANNER: reuseWorkspace + skipPromote ─────────────────────────────────────────────

test("reuseWorkspace: orchestrator reuses the provided workspace instead of allocating", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = fakeWorkspaces(true);
  const cap = capturingRoles();
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles: cap.roles, workspaces: ws.workspaces }));
  const existing = fakeWorkspaceHandle();
  const taskWithReuse: WorkerTask = { ...task, reuseWorkspace: existing };
  const result = await orch.run(taskWithReuse, parentCtx);

  assert.equal(ws.calls.allocate.length, 0, "did NOT allocate a new workspace");
  assert.equal(ws.calls.promote, 1, "still promoted (skipPromote not set)");
  assert.equal(result.workspaceId, existing.id, "used the existing workspace id");
  assert.equal(result.outcome, "success");
});

test("skipPromote: orchestrator runs all roles but skips promote/discard", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = fakeWorkspaces(true);
  const cap = capturingRoles();
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles: cap.roles, workspaces: ws.workspaces }));
  const taskSkip: WorkerTask = { ...task, skipPromote: true };
  const result = await orch.run(taskSkip, parentCtx);

  assert.equal(ws.calls.allocate.length, 1, "allocated a workspace");
  assert.equal(ws.calls.promote, 0, "did NOT promote");
  assert.equal(ws.calls.discard, 0, "did NOT discard");
  assert.equal(result.outcome, "success", "roles still report success");
  assert.equal(result.promoted, false, "not promoted");
  // All 5 roles still ran.
  assert.equal(cap.seen.length, 5, "all five roles dispatched");
});

test("reuseWorkspace + skipPromote: shared workspace across steps, no lifecycle", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = fakeWorkspaces(true);
  const cap = capturingRoles();
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles: cap.roles, workspaces: ws.workspaces }));
  const existing = fakeWorkspaceHandle();
  // Step 1: reuse + skip promote
  const step1: WorkerTask = { taskId: "t-step1", targetRepo: "/repo", goal: "step 1", reuseWorkspace: existing, skipPromote: true };
  const r1 = await orch.run(step1, parentCtx);
  assert.equal(ws.calls.allocate.length, 0, "step 1 did not allocate");
  assert.equal(ws.calls.promote, 0, "step 1 did not promote");
  assert.equal(r1.workspaceId, existing.id, "step 1 used shared workspace");

  // Step 2: reuse + skip promote (same workspace)
  const step2: WorkerTask = { taskId: "t-step2", targetRepo: "/repo", goal: "step 2", reuseWorkspace: existing, skipPromote: true };
  const r2 = await orch.run(step2, parentCtx);
  assert.equal(ws.calls.allocate.length, 0, "step 2 did not allocate");
  assert.equal(ws.calls.promote, 0, "step 2 did not promote");
  assert.equal(r2.workspaceId, existing.id, "step 2 used same workspace");

  // Final: reuse + promote (no skipPromote)
  const final: WorkerTask = { taskId: "t-final", targetRepo: "/repo", goal: "verify all", reuseWorkspace: existing };
  const rFinal = await orch.run(final, parentCtx);
  assert.equal(ws.calls.allocate.length, 0, "final did not allocate");
  assert.equal(ws.calls.promote, 1, "final promoted");
  assert.equal(rFinal.workspaceId, existing.id, "final used same workspace");
  assert.equal(rFinal.promoted, true, "final promoted flag set");

  // Total: 3 runs, 0 allocations, 1 promote, 0 discards.
  assert.equal(ws.calls.allocate.length, 0);
  assert.equal(ws.calls.promote, 1);
  assert.equal(ws.calls.discard, 0);
});

test("skipPromote: a failed step still reports failure without discarding", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = fakeWorkspaces(true);
  const cap = capturingRoles((role) => role === "builder" ? "failure" : "success");
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles: cap.roles, workspaces: ws.workspaces }));
  const existing = fakeWorkspaceHandle();
  const stepFail: WorkerTask = { ...task, reuseWorkspace: existing, skipPromote: true };
  const result = await orch.run(stepFail, parentCtx);

  assert.equal(result.outcome, "failure", "builder failure propagates");
  assert.equal(result.promoted, false, "not promoted");
  assert.equal(ws.calls.promote, 0, "did NOT promote");
  assert.equal(ws.calls.discard, 0, "did NOT discard — workspace stays alive for step planner");
});

test("skipVerifier: verifier role is skipped, other roles still run", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = fakeWorkspaces(true);
  const cap = capturingRoles();
  const orch = createOrchestrator(baseDeps({ resolveIdentity, roleClaim, roles: cap.roles, workspaces: ws.workspaces }));
  const taskSkipV: WorkerTask = { ...task, skipVerifier: true, skipPromote: true };
  const result = await orch.run(taskSkipV, parentCtx);

  // Verifier was skipped (synthetic success), other 4 roles ran.
  const verifierRole = result.roles.find((r) => r.role === "verifier");
  assert.equal(verifierRole?.outcome, "success", "verifier reports success (skipped)");
  assert.match(verifierRole?.summary ?? "", /skipped/, "verifier summary says skipped");
  // scout, builder, critic, integrator ran normally; verifier was injected.
  assert.equal(cap.seen.length, 4, "4 real roles dispatched (verifier skipped)");
  assert.equal(result.outcome, "success");
  assert.equal(ws.calls.promote, 0, "skipPromote prevents promote");
});

/**
 * SG-5 (audit): structured build PROGRESS — per-role start/end (already emitted) plus builder
 * tool-activity and verification-status events; surfaced by `ikbi build --verbose`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import { EventBus } from "../../core/events/bus.js";
import type { EventBusSurface, EventInput, IkbiEvent } from "../../core/events/index.js";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { ValidatedIdentity } from "../../core/identity/resolver.js";
import { asTier, autonomyForTier, TRUST_FLOOR, type TrustDecision } from "../../core/trust/index.js";
import type { DiscardResult, PromoteGovernance, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import { createWorkerCli, formatProgressEvent, formatRepairNarrative } from "./cli.js";
import { workerRoleDispatched, workerVerification } from "./events.js";
import { WORKER_ROLES, type RoleFn, type WorkerRole, type WorkerResult, type WorkerTask } from "./contract.js";

const silent = () => pino({ level: "silent" });

// ── orchestrator emits the full progress sequence during a build ──────────────

function ids() {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [
      { agentId: "parent-1", kind: "agent", functionalRole: "lead", defaultTrustTier: "trusted", tokenHashes: [hashToken("parent-secret")] },
      { agentId: "worker-1", kind: "agent", functionalRole: "worker", defaultTrustTier: "trusted", tokenHashes: [hashToken("worker-secret")] },
    ] }),
    logger: silent(), now: () => 1000,
  });
  const parentCtx = beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
  return { parentCtx, resolveIdentity: ((c: Parameters<typeof resolver.resolve>[0], x?: Parameters<typeof resolver.resolve>[1]) => resolver.resolve(c, x)) as NonNullable<OrchestratorDeps["resolveIdentity"]>, roleClaim: (() => ({ token: "worker-secret" })) as NonNullable<OrchestratorDeps["roleClaim"]> };
}

function capturingBus() {
  const sent: Array<EventInput<unknown>> = [];
  const bus: EventBusSurface = {
    publish: <P>(input: EventInput<P>): IkbiEvent<P> => { sent.push(input as EventInput<unknown>); return { ...input, contractVersion: "1.0.0", id: `e${sent.length}`, seq: sent.length, timestamp: 0 } as IkbiEvent<P>; },
    subscribe: () => ({ id: "s", unsubscribe: () => {}, stats: () => ({ delivered: 0, dropped: 0, failures: 0, queued: 0 }) }),
    flush: async () => {},
  };
  return { bus, types: () => sent.map((e) => (e as { type: string }).type) };
}

const progressRoles = (): Partial<Record<WorkerRole, RoleFn>> => {
  const roles: Partial<Record<WorkerRole, RoleFn>> = {};
  for (const r of WORKER_ROLES) {
    roles[r] = async () => {
      if (r === "builder") return { role: r, outcome: "success", summary: r, detail: { toolRounds: 3, filesWritten: ["a.ts", "b.ts"] } };
      if (r === "verifier") return { role: r, outcome: "success", summary: r, detail: { verdict: "pass", checks: [{ name: "typecheck", exitCode: 0 }, { name: "test", exitCode: 0 }] } };
      if (r === "integrator") return { role: r, outcome: "success", summary: r, detail: { decision: "promote", rationale: "ok", evaluation: { approved: true } } };
      return { role: r, outcome: "success", summary: r };
    };
  }
  return roles;
};

function fakeWs() {
  const handle: WorkspaceHandle = { id: "wsabcd", targetRepo: "/repo", baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/wsabcd", path: "/tmp/wsabcd", identity: { agentId: "parent-1" }, state: "allocated", createdAt: 0 };
  return {
    allocate: async () => handle,
    promote: async (h: WorkspaceHandle): Promise<PromoteResult> => ({ promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }),
    discard: async (h: WorkspaceHandle): Promise<DiscardResult> => ({ workspaceId: h.id, removed: true }),
    commit: async () => true,
  } satisfies NonNullable<OrchestratorDeps["workspaces"]>;
}
const fakeTrust = { recordOutcome: async (i: { agentId: string; defaultTrustTier: string }): Promise<TrustDecision> => { const t = asTier(i.defaultTrustTier, TRUST_FLOOR); return { agentId: i.agentId, tier: t, previousTier: t, autonomy: autonomyForTier(t) }; } };
const fakeReceipts = { append: async (): Promise<unknown> => ({}) };
const allowGate: NonNullable<OrchestratorDeps["gateWall"]> = { evaluate: async (): Promise<PromoteGovernance> => ({ allow: true }) };

test("a build emits the full progress sequence incl. builder activity + verification", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = ids();
  const bus = capturingBus();
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 1000, maxConcurrentRuns: 1 },
    resolveIdentity, roleClaim, roles: progressRoles(), workspaces: fakeWs(), trust: fakeTrust, receipts: fakeReceipts, events: bus.bus, gateWall: allowGate,
    invokeModel: async () => { throw new Error("unused"); },
  });
  await orch.run({ taskId: "t-1", targetRepo: "/repo", goal: "g" }, parentCtx);

  const types = bus.types();
  assert.ok(types.includes("worker.started"), "run start");
  assert.equal(types.filter((t) => t === "worker.role.dispatched").length, 5, "per-role START for all 5 roles");
  assert.equal(types.filter((t) => t === "worker.role.completed").length, 5, "per-role END for all 5 roles");
  assert.ok(types.includes("worker.builder.activity"), "builder tool activity");
  assert.ok(types.includes("worker.verification"), "verification status");
  assert.ok(types.includes("worker.completed"), "run complete");
});

// ── formatProgressEvent (pure) ────────────────────────────────────────────────

test("formatProgressEvent renders each worker.* event to a concise line", () => {
  assert.match(formatProgressEvent({ type: "worker.role.dispatched", payload: { role: "scout" } }), /→ scout …/);
  assert.match(formatProgressEvent({ type: "worker.role.completed", payload: { role: "builder", outcome: "success" } }), /✓ builder: success/);
  assert.match(formatProgressEvent({ type: "worker.builder.activity", payload: { toolRounds: 3, filesWritten: 2 } }), /builder: 3 tool round\(s\), 2 file\(s\)/);
  assert.match(formatProgressEvent({ type: "worker.verification", payload: { verdict: "pass", typecheckPassed: true, testsPassed: true } }), /verify: pass \(typecheck ✓, tests ✓\)/);
  assert.equal(formatProgressEvent({ type: "worker.competitive.started", payload: {} }), "", "unmapped events render empty");
});

// ── --verbose streams the events to stdout ────────────────────────────────────

test("`ikbi build --verbose` streams the progress events to stdout", async () => {
  const opResolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "operator", kind: "operator", defaultTrustTier: "operator", tokenHashes: [hashToken("op-secret")] }] }),
    logger: silent(), now: () => 1000,
  });
  const bus = new EventBus({ logger: silent(), defaultMaxQueue: 1000 });
  let out = "";
  // A fake orchestrator that PUBLISHES progress to the SAME bus the CLI subscribes to.
  const orchestrator = {
    run: async (task: WorkerTask): Promise<import("./contract.js").WorkerResult> => {
      bus.publish(workerRoleDispatched.create({ taskId: task.taskId, role: "builder" }, { source: "worker-model" }));
      bus.publish(workerVerification.create({ taskId: task.taskId, verdict: "pass", typecheckPassed: true, testsPassed: true }, { source: "worker-model" }));
      return { contractVersion: "1.0.0", taskId: task.taskId, outcome: "success", roles: [], promoted: true };
    },
  };
  const cli = createWorkerCli({
    orchestrator,
    resolveIdentity: (c: { token?: string }): ValidatedIdentity => opResolver.resolve(c),
    operatorToken: "op-secret", workerToken: "worker-secret",
    events: bus,
    stdout: (s) => { out += s; }, stderr: () => {}, setExit: () => {}, now: () => 1,
    // No workspaces lookup needed; the fake result's workspaceId is undefined ⇒ no diff summary.
  });

  await cli.build(["fix", "the", "thing", "--verbose"]);
  assert.match(out, /→ builder …/, "the per-role dispatch line streamed");
  assert.match(out, /verify: pass/, "the verification line streamed");
  assert.match(out, /"outcome": "success"/, "the final summary still prints");
});

test("without --verbose, no progress lines are streamed", async () => {
  const opResolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "operator", kind: "operator", defaultTrustTier: "operator", tokenHashes: [hashToken("op-secret")] }] }),
    logger: silent(), now: () => 1000,
  });
  const bus = new EventBus({ logger: silent(), defaultMaxQueue: 1000 });
  let out = "";
  const orchestrator = {
    run: async (task: WorkerTask): Promise<import("./contract.js").WorkerResult> => {
      bus.publish(workerRoleDispatched.create({ taskId: task.taskId, role: "builder" }, { source: "worker-model" }));
      return { contractVersion: "1.0.0", taskId: task.taskId, outcome: "success", roles: [], promoted: true };
    },
  };
  const cli = createWorkerCli({ orchestrator, resolveIdentity: (c: { token?: string }): ValidatedIdentity => opResolver.resolve(c), operatorToken: "op-secret", workerToken: "worker-secret", events: bus, stdout: (s) => { out += s; }, stderr: () => {}, setExit: () => {}, now: () => 1 });
  await cli.build(["fix", "the", "thing"]);
  assert.doesNotMatch(out, /→ builder …/, "no progress lines without --verbose");
});

// ── ISSUE 4: custom IKBI_CHECKS display correctly (no false "typecheck ✗") ───────
test("ISSUE 4: the verify line renders ACTUAL custom check names, not the typecheck/tests axes", () => {
  const line = formatProgressEvent({
    type: "worker.verification",
    payload: { verdict: "pass", typecheckPassed: false, testsPassed: true, checks: [{ name: "test", passed: true }, { name: "build", passed: true }] },
  });
  assert.match(line, /verify: pass \(test ✓, build ✓\)/, "shows the real check names + results");
  assert.doesNotMatch(line, /typecheck/, "no phantom typecheck axis when custom checks ran");
});

test("ISSUE 4: the verify line falls back to typecheck/tests when no per-check list is present", () => {
  // backward-compatible with older events that carry only the two axes.
  const line = formatProgressEvent({ type: "worker.verification", payload: { verdict: "pass", typecheckPassed: true, testsPassed: true } });
  assert.match(line, /verify: pass \(typecheck ✓, tests ✓\)/);
});

// ── ISSUE 3: the repair narrative renders in the final report ────────────────────
test("ISSUE 3: formatRepairNarrative surfaces root cause, files changed, rationale, and tests run", () => {
  const result = {
    contractVersion: "1.0.0", taskId: "t", outcome: "success", promoted: true,
    roles: [
      { role: "builder", outcome: "success", detail: { filesWritten: ["src/lib/calculations.ts"], doneClaim: { rootCause: "totalTokens omitted completionTokens", fixRationale: "re-added completionTokens to the sum", checksPassed: true } } },
      { role: "verifier", outcome: "success", detail: { verdict: "pass", checks: [{ name: "test", exitCode: 0 }, { name: "build", exitCode: 0 }] } },
    ],
  } as unknown as WorkerResult;
  const out = formatRepairNarrative(result);
  assert.match(out, /Root cause: totalTokens omitted completionTokens/);
  assert.match(out, /Files changed: src\/lib\/calculations\.ts/);
  assert.match(out, /Why this fixes it: re-added completionTokens to the sum/);
  assert.match(out, /Tests run: test ✓, build ✓/);
});

test("ISSUE 3: formatRepairNarrative is empty for a non-repair build (no narrative supplied)", () => {
  const result = {
    contractVersion: "1.0.0", taskId: "t", outcome: "success", promoted: true,
    roles: [{ role: "builder", outcome: "success", detail: { filesWritten: ["a.ts"] } }],
  } as unknown as WorkerResult;
  assert.equal(formatRepairNarrative(result), "", "no narrative → empty (safe to print unconditionally)");
});

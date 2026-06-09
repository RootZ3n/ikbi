/**
 * ikbi worker-model — PRODUCTION ORCHESTRATOR WIRING (modes threaded + observed).
 *
 * F1/F2/E: a production-shaped orchestrator (enforceProjectRoot ON) with NO env vars resolves
 * the HARDENED modes (ladder + index), wires the production scout to the index path, and stamps
 * the ACTUAL modes onto the run result + the worker.started/completed events. With
 * IKBI_VERIFY=legacy / IKBI_RETRIEVAL=legacy the legacy modes are wired instead (F7).
 *
 * The roles (except scout) are stubbed so the assertions target the orchestrator's DECISIONS +
 * observability, not the heavy verifier internals (covered in production-defaults.test.ts).
 * The scout is left to the orchestrator to build, so the index wiring is proven via a spy
 * `retrieval` API.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { AgentRecord } from "../../core/identity/registry.js";
import type { EventBusSurface } from "../../core/events/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import type { ProjectRetrievalApi } from "../project-retrieval/index.js";
import type { RoleFn, WorkerRole, WorkerTask } from "./contract.js";

const silent = () => pino({ level: "silent" });

function makeIdentities(parentTier = "trusted", workerTier = "trusted") {
  const agents: AgentRecord[] = [
    { agentId: "parent-1", kind: "agent", functionalRole: "lead", defaultTrustTier: parentTier, tokenHashes: [hashToken("parent-secret")] },
    { agentId: "worker-1", kind: "agent", functionalRole: "worker", defaultTrustTier: workerTier, tokenHashes: [hashToken("worker-secret")] },
  ];
  const resolver = new IdentityResolver({ registry: new AgentRegistry({ agents }), logger: silent(), now: () => 1000 });
  const parentCtx = beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
  const resolveIdentity: NonNullable<OrchestratorDeps["resolveIdentity"]> = (claim, ctx) => resolver.resolve(claim, ctx);
  const roleClaim: NonNullable<OrchestratorDeps["roleClaim"]> = () => ({ token: "worker-secret" });
  return { parentCtx, resolveIdentity, roleClaim };
}

function handle(id: string): WorkspaceHandle {
  return { id, targetRepo: "/repo", baseBranch: "main", baseRef: "deadbeef", scratchBranch: `ikbi/ws/${id}`, path: `/tmp/${id}`, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
}

/** Roles minus scout (orchestrator builds the production scout). `verifierMode` is what the
 *  injected verifier REPORTS — standing in for the path the orchestrator threaded. */
function rolesWithVerifier(verifierMode: "ladder" | "legacy"): Partial<Record<WorkerRole, RoleFn>> {
  const detail = verifierMode === "ladder"
    ? { verdict: "pass", verificationMode: "ladder", verificationScope: "full", checks: [] }
    : { verdict: "pass", verificationMode: "legacy", checks: [] };
  return {
    builder: async () => ({ role: "builder", outcome: "success", summary: "b", detail: { toolRounds: 1, filesWritten: ["a.ts"], rejectedToolCalls: [], stopReason: "stop" } }),
    critic: async () => ({ role: "critic", outcome: "success", summary: "c", detail: { pass: true } }),
    verifier: async () => ({ role: "verifier", outcome: "success", summary: "v", detail }),
    integrator: async () => ({ role: "integrator", outcome: "success", summary: "i", detail: { decision: "promote", rationale: "ok", evaluation: { approved: true } } }),
  };
}

function captureEvents() {
  const seen: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const events = {
    publish: (e: { type: string; payload?: unknown }) => { seen.push({ type: e.type, payload: (e.payload ?? {}) as Record<string, unknown> }); },
    subscribe: () => ({ unsubscribe: () => {} }),
    flush: async () => {},
  } as unknown as EventBusSurface;
  return { events, seen };
}

function baseDeps(over: Partial<OrchestratorDeps>): OrchestratorDeps {
  const { parentCtx: _p, resolveIdentity, roleClaim } = makeIdentities();
  void _p;
  return {
    config: { enabled: true, roleTimeoutMs: 60_000, maxConcurrentRuns: 1 },
    resolveIdentity,
    roleClaim,
    workspaces: {
      allocate: async () => handle("ws0"),
      promote: async () => ({ promoted: true }) as never,
      discard: async () => ({}) as never,
      commit: async () => true,
      diff: async () => "diff --git a/a.ts b/a.ts\n",
    },
    gateWall: { evaluate: async () => ({ allow: true }) as never },
    trust: { recordOutcome: async () => ({ agentId: "x", tier: "operator", previousTier: "operator", autonomy: { tier: "operator", autoCommit: true } }) as never },
    receipts: { append: async () => ({}) },
    killCheck: async () => ({ killed: false }),
    // Only the (orchestrator-built) scout invokes a model; a benign response keeps it green.
    invokeModel: async () => ({ content: "- a.ts:1 — relevant", model: "m", usage: { inputTokens: 1, outputTokens: 1 } }) as never,
    enforceProjectRoot: true, // PRODUCTION
    ...over,
  };
}

const task: WorkerTask = { taskId: "t1", targetRepo: "/tmp/repo", goal: "do it" };

test("F1/F2/E: production orchestrator with NO env ⇒ ladder + index wired and stamped on result + events", async () => {
  const { parentCtx } = makeIdentities();
  let retrieveCalled = 0;
  const retrieval: ProjectRetrievalApi = { retrieve: async () => { retrieveCalled += 1; return { files: [{ path: "a.ts", reasons: ["name"], why: "match" }], receipts: ["idx"] }; } } as never;
  const { events, seen } = captureEvents();
  const orch = createOrchestrator(baseDeps({ env: {}, retrieval, roles: rolesWithVerifier("ladder"), events }));

  const r = await orch.run(task, parentCtx);

  assert.equal(r.outcome, "success");
  assert.equal(r.promoted, true);
  assert.equal(retrieveCalled, 1, "F2: the production scout actually delegated to index retrieval");
  assert.equal(r.verificationMode, "ladder", "E: the run reports it ran ladder verification");
  assert.equal(r.retrievalMode, "index", "E: the run reports it ran index retrieval");
  const started = seen.find((e) => e.type === "worker.started");
  assert.equal(started?.payload.verificationMode, "ladder", "F1: startup event advertises the ladder default");
  assert.equal(started?.payload.retrievalMode, "index", "F2: startup event advertises the index default");
  const completed = seen.find((e) => e.type === "worker.completed");
  assert.equal(completed?.payload.verificationMode, "ladder");
  assert.equal(completed?.payload.retrievalMode, "index");
});

test("F7: production orchestrator with IKBI_VERIFY=legacy / IKBI_RETRIEVAL=legacy ⇒ legacy modes wired", async () => {
  const { parentCtx } = makeIdentities();
  let retrieveCalled = 0;
  const retrieval: ProjectRetrievalApi = { retrieve: async () => { retrieveCalled += 1; return { files: [], receipts: [] }; } } as never;
  const { events, seen } = captureEvents();
  const orch = createOrchestrator(baseDeps({ env: { IKBI_VERIFY: "legacy", IKBI_RETRIEVAL: "legacy" }, retrieval, roles: rolesWithVerifier("legacy"), events }));

  const r = await orch.run(task, parentCtx);

  assert.equal(retrieveCalled, 0, "legacy retrieval never calls the index API");
  assert.equal(r.retrievalMode, "legacy", "the scout ran the legacy scan");
  assert.equal(r.verificationMode, "legacy", "the verifier ran legacy");
  const started = seen.find((e) => e.type === "worker.started");
  assert.equal(started?.payload.verificationMode, "legacy");
  assert.equal(started?.payload.retrievalMode, "legacy");
});

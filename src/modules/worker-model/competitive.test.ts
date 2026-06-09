import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";

import type { EventBusSurface, EventInput, IkbiEvent } from "../../core/events/index.js";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { AgentRecord } from "../../core/identity/registry.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import { autonomyForTier, asTier, type TrustDecision } from "../../core/trust/index.js";
import { TRUST_FLOOR } from "../../core/trust/index.js";
import type { DiscardResult, PromoteGovernance, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import type { BuildCandidate } from "../deterministic-judge/index.js";
import { deterministicJudge } from "../deterministic-judge/index.js";
import type { ExecRequest, ExecResult } from "../governed-exec/index.js";
import { MAX_TOOL_ITERATIONS } from "./builder.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import { type RoleContext, type RoleFn, type WorkerRole, type WorkerTask } from "./contract.js";
import { builderModel } from "./role-models.js";

const silent = () => pino({ level: "silent" });

function makeResolver(agents: AgentRecord[]) {
  return new IdentityResolver({ registry: new AgentRegistry({ agents }), logger: silent(), now: () => 1000 });
}

function makeIdentities(parentTier: string, workerTier: string) {
  const resolver = makeResolver([
    { agentId: "parent-1", kind: "agent", functionalRole: "lead", defaultTrustTier: parentTier, tokenHashes: [hashToken("parent-secret")] },
    { agentId: "worker-1", kind: "agent", functionalRole: "worker", defaultTrustTier: workerTier, tokenHashes: [hashToken("worker-secret")] },
  ]);
  const parentCtx = beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
  const resolveIdentity: NonNullable<OrchestratorDeps["resolveIdentity"]> = (claim, ctx) => resolver.resolve(claim, ctx);
  const roleClaim: NonNullable<OrchestratorDeps["roleClaim"]> = () => ({ token: "worker-secret" });
  return { parentCtx, resolveIdentity, roleClaim };
}

function baseHandle(id: string): WorkspaceHandle {
  return { id, targetRepo: "/repo", baseBranch: "main", baseRef: "deadbeef", scratchBranch: `ikbi/ws/${id}`, path: `/tmp/${id}`, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
}

/** Fake workspaces: ids "ws0","ws1",…; promote honors governance; records lifecycle. */
function compWorkspaces(opts: { conflict?: boolean; failAllocateAt?: number } = {}) {
  const allocated: string[] = [];
  const promoted: string[] = [];
  const discarded: string[] = [];
  const committed: string[] = [];
  const events: string[] = []; // ordered trace: "commit:wsN" / "diff:wsN"
  let i = 0;
  const workspaces: NonNullable<OrchestratorDeps["workspaces"]> = {
    allocate: async () => {
      if (opts.failAllocateAt !== undefined && i === opts.failAllocateAt) throw new Error("allocate failed");
      const h = baseHandle(`ws${i++}`);
      allocated.push(h.id);
      return h;
    },
    promote: async (h, a): Promise<PromoteResult> => {
      promoted.push(h.id);
      if (a.governance !== undefined && a.governance.allow === false) return { promoted: false, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", reason: "governance denied" };
      if (opts.conflict === true) return { promoted: false, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", conflicts: ["x.ts"], reason: "conflict" };
      return { promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" };
    },
    discard: async (h): Promise<DiscardResult> => {
      discarded.push(h.id);
      return { workspaceId: h.id, removed: true };
    },
    diff: async (h) => { events.push(`diff:${h.id}`); return "line1\nline2\nline3"; },
    commit: async (h): Promise<boolean> => { committed.push(h.id); events.push(`commit:${h.id}`); return true; },
  };
  return { workspaces, allocated, promoted, discarded, committed, events };
}

const fakeTrust = () => ({
  recordOutcome: async (i: { agentId: string; operation: string; status: string; defaultTrustTier: string }): Promise<TrustDecision> => {
    const tier = asTier(i.defaultTrustTier, TRUST_FLOOR);
    return { agentId: i.agentId, tier, previousTier: tier, autonomy: autonomyForTier(tier) };
  },
});
const fakeReceipts = () => ({ append: async (_i: unknown, _id: AgentIdentity): Promise<unknown> => ({}) });
function fakeBus() {
  const sent: Array<EventInput<unknown>> = [];
  const bus: EventBusSurface = {
    publish: <P>(input: EventInput<P>): IkbiEvent<P> => { sent.push(input as EventInput<unknown>); return { ...input, contractVersion: "1.0.0", id: "e", seq: 1, timestamp: 0 } as IkbiEvent<P>; },
    subscribe: () => ({ id: "s", unsubscribe: () => {}, stats: () => ({ delivered: 0, dropped: 0, failures: 0, queued: 0 }) }),
    flush: async () => {},
  };
  return { bus, sent };
}

/** verifier checks for a candidate: typecheck/test exit codes + a parseable count. */
function checks(typecheck: number, testExit: number, passed = 10, total = 10) {
  return [
    { name: "typecheck", command: "pnpm tsc --noEmit", exitCode: typecheck, outputTail: "" },
    { name: "test", command: "pnpm test", exitCode: testExit, outputTail: `# tests ${total}\n# pass ${passed}\n` },
  ];
}

/**
 * Fake roles that branch on the workspace id so different workspaces yield different
 * candidates. `outcomes(wsId)` returns { builderOk, toolRounds, typecheck, test }.
 * Records each builder's spawned identity tier (for the #10 clamp assertion).
 */
function compRoles(outcomes: (wsId: string) => { builderOk?: boolean; toolRounds?: number; typecheck?: number; test?: number; passed?: number }) {
  const builderTiers: string[] = [];
  const roles: Partial<Record<WorkerRole, RoleFn>> = {
    scout: async () => ({ role: "scout", outcome: "success", summary: "s" }),
    builder: async (ctx: RoleContext) => {
      builderTiers.push(String(ctx.identity.trustTier));
      const o = outcomes(ctx.workspace.id);
      if (o.builderOk === false) return { role: "builder", outcome: "failure", summary: "b-fail", detail: { toolRounds: 0, filesWritten: [], rejectedToolCalls: [], stopReason: "error" } };
      return { role: "builder", outcome: "success", summary: "b", detail: { toolRounds: o.toolRounds ?? 2, filesWritten: ["a.ts"], rejectedToolCalls: [], stopReason: "stop" } };
    },
    verifier: async (ctx: RoleContext) => {
      const o = outcomes(ctx.workspace.id);
      const c = checks(o.typecheck ?? 0, o.test ?? 0, o.passed ?? 10);
      return { role: "verifier", outcome: "success", summary: "v", detail: { verdict: "pass", checks: c } };
    },
  };
  return { roles, builderTiers };
}

const COMP = { enabled: true, roleTimeoutMs: 1000, maxConcurrentRuns: 1, competitive: true, competitiveN: 2 };
const SINGLE = { enabled: true, roleTimeoutMs: 1000, maxConcurrentRuns: 1 };
const task: WorkerTask = { taskId: "t-1", targetRepo: "/repo", goal: "do the thing" };

/** An ALLOWING gate-wall — the wired/governed path. A promote REQUIRES gate-wall (H5). */
const allowGate: NonNullable<OrchestratorDeps["gateWall"]> = { evaluate: async (): Promise<PromoteGovernance> => ({ allow: true, reason: "test gate allows" }) };

/** Strip the wired gate-wall entirely — simulates the unwired/misconfig path (H5). */
function omitGate(d: OrchestratorDeps): OrchestratorDeps {
  const copy = { ...d };
  delete (copy as { gateWall?: unknown }).gateWall;
  return copy;
}

function deps(extra: Partial<OrchestratorDeps>): OrchestratorDeps {
  return { config: COMP, trust: fakeTrust(), receipts: fakeReceipts(), events: fakeBus().bus, gateWall: allowGate, invokeModel: async () => { throw new Error("unused"); }, ...extra };
}

// ── OFF BY DEFAULT (regression guard) ────────────────────────────────────────

test("competitive OFF ⇒ single-workspace path (one allocate), unchanged behavior", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = compWorkspaces();
  const cap = compRoles(() => ({}));
  // SINGLE config + a promoting integrator stub via default roles is not present, so use
  // capturing roles that succeed; single-mode reads the integrator decision.
  const roles: Partial<Record<WorkerRole, RoleFn>> = {
    ...cap.roles,
    critic: async () => ({ role: "critic", outcome: "success", summary: "c" }),
    integrator: async () => ({ role: "integrator", outcome: "success", summary: "i", detail: { decision: "promote", evaluation: { approved: true } } }),
  };
  const orch = createOrchestrator(deps({ config: SINGLE, resolveIdentity, roleClaim, workspaces: ws.workspaces, roles }));
  await orch.run(task, parentCtx);
  assert.equal(ws.allocated.length, 1, "single mode allocates exactly ONE workspace");
});

// ── COMPETITIVE WINNER: best promoted, losers discarded, no leak ─────────────

test("competitive: the better candidate wins — winner promoted, loser discarded, no leaked workspace", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = compWorkspaces();
  // ws0 passes tests; ws1 FAILS tests ⇒ ws1 disqualified ⇒ ws0 wins.
  const cap = compRoles((id) => (id === "ws0" ? { typecheck: 0, test: 0 } : { typecheck: 0, test: 1 }));
  const orch = createOrchestrator(deps({ resolveIdentity, roleClaim, workspaces: ws.workspaces, roles: cap.roles }));

  const r = await orch.run(task, parentCtx);
  assert.equal(r.promoted, true);
  assert.equal(r.outcome, "success");
  assert.equal(r.workspaceId, "ws0", "the winning workspace");
  assert.deepEqual(ws.promoted, ["ws0"], "only the winner is promoted");
  assert.deepEqual(ws.discarded, ["ws1"], "the loser is discarded");
  // every allocated workspace is promoted XOR discarded — no leak.
  for (const id of ws.allocated) assert.ok(ws.promoted.includes(id) || ws.discarded.includes(id), `${id} not leaked`);
});

test("competitive: each candidate's verified work is COMMITTED before the judge reads its diff (autoCommit)", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = compWorkspaces();
  // Both candidates pass (verifier success) → both get committed (trusted → autoCommit).
  const cap = compRoles(() => ({ typecheck: 0, test: 0 }));
  const orch = createOrchestrator(deps({ resolveIdentity, roleClaim, workspaces: ws.workspaces, roles: cap.roles }));
  await orch.run(task, parentCtx);

  // Each candidate whose verifier succeeded was committed (one per workspace).
  assert.deepEqual([...ws.committed].sort(), ["ws0", "ws1"], "both verified candidates committed");
  // And each commit precedes that candidate's diff read (safeDiffLines → judge scoring).
  assert.ok(ws.events.indexOf("commit:ws0") < ws.events.indexOf("diff:ws0"), "ws0 committed before its diff is read");
  assert.ok(ws.events.indexOf("commit:ws1") < ws.events.indexOf("diff:ws1"), "ws1 committed before its diff is read");
});

test("competitive: a candidate that never reaches a successful verifier is NOT committed (only verified work)", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = compWorkspaces();
  // ws0 builder+verifier succeed; ws1's BUILDER fails → no verifier → ws1 not committed.
  const cap = compRoles((id) => (id === "ws0" ? { typecheck: 0, test: 0 } : { builderOk: false }));
  const orch = createOrchestrator(deps({ resolveIdentity, roleClaim, workspaces: ws.workspaces, roles: cap.roles }));
  await orch.run(task, parentCtx);
  assert.deepEqual(ws.committed, ["ws0"], "only the candidate whose verifier succeeded is committed");
});

test("competitive: a non-autoCommit tier (verified) commits NO candidate (autonomy respected)", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("verified", "verified");
  const ws = compWorkspaces();
  const cap = compRoles(() => ({ typecheck: 0, test: 0 }));
  const orch = createOrchestrator(deps({ resolveIdentity, roleClaim, workspaces: ws.workspaces, roles: cap.roles }));
  await orch.run(task, parentCtx);
  assert.equal(ws.committed.length, 0, "verified tier → autoCommit false → no candidate committed");
});

// ── NO-PASS: every candidate disqualified ⇒ all discarded, nothing promoted ──

test("competitive no-pass: all candidates disqualified ⇒ all discarded, nothing promoted, fail-closed", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = compWorkspaces();
  const cap = compRoles(() => ({ typecheck: 1, test: 0 })); // BOTH fail typecheck
  const orch = createOrchestrator(deps({ resolveIdentity, roleClaim, workspaces: ws.workspaces, roles: cap.roles }));

  const r = await orch.run(task, parentCtx);
  assert.equal(r.promoted, false);
  assert.notEqual(r.outcome, "success");
  assert.ok(r.reason, "a fail-closed reason");
  assert.equal(ws.promoted.length, 0, "nothing promoted");
  assert.deepEqual([...ws.discarded].sort(), ["ws0", "ws1"], "every workspace discarded");
});

// ── CLEANUP ON ERROR: no leaked worktree ─────────────────────────────────────

test("competitive: an allocation failure discards everything already allocated (no leak)", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = compWorkspaces({ failAllocateAt: 1 }); // ws0 allocates, ws1 throws
  const cap = compRoles(() => ({}));
  const orch = createOrchestrator(deps({ resolveIdentity, roleClaim, workspaces: ws.workspaces, roles: cap.roles }));

  await assert.rejects(() => orch.run(task, parentCtx));
  assert.deepEqual(ws.allocated, ["ws0"], "only ws0 was allocated before the failure");
  assert.deepEqual(ws.discarded, ["ws0"], "the allocated workspace was discarded (no leak)");
  assert.equal(ws.promoted.length, 0);
});

// ── GATE AT PROMOTE: judge selects, gate-wall authorizes (separate) ──────────

test("competitive: a denying gate-wall blocks the winner's promote ⇒ all discarded, fail-closed", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = compWorkspaces();
  const cap = compRoles((id) => (id === "ws0" ? { typecheck: 0, test: 0 } : { typecheck: 0, test: 1 }));
  const captured: BuildCandidate[][] = [];
  const judge = { judge: (c: readonly BuildCandidate[]) => { captured.push([...c]); return deterministicJudge.judge(c); } };
  const denyGate = { evaluate: async (): Promise<PromoteGovernance> => ({ allow: false, reason: "denied by policy", gateId: "g" }) };
  const orch = createOrchestrator(deps({ resolveIdentity, roleClaim, workspaces: ws.workspaces, roles: cap.roles, judge, gateWall: denyGate }));

  const r = await orch.run(task, parentCtx);
  // The judge DID pick a winner (ws0 survived) — proving select vs authorize are separate.
  assert.equal(captured[0]?.length, 2, "the judge scored both candidates");
  assert.equal(r.promoted, false, "the gate blocked the promote");
  assert.ok(ws.promoted.includes("ws0"), "promote was attempted on the winner");
  assert.deepEqual([...ws.discarded].sort(), ["ws0", "ws1"], "winner + loser both discarded (fail-closed)");
});

test("H5 competitive: NO gate-wall → the winner promote is DENIED fail-closed; ALL discarded, nothing promoted", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = compWorkspaces();
  const cap = compRoles((id) => (id === "ws0" ? { typecheck: 0, test: 0 } : { typecheck: 0, test: 1 })); // ws0 wins the judge
  // omitGate strips the deps()' wired-allow default → the unwired/misconfig path.
  const orch = createOrchestrator(omitGate(deps({ resolveIdentity, roleClaim, workspaces: ws.workspaces, roles: cap.roles })));

  const r = await orch.run(task, parentCtx);
  assert.equal(r.promoted, false, "nothing promoted without gate-wall authorization");
  assert.equal(r.outcome, "rejected", "an unwired gate-wall denies the competitive promote fail-closed");
  assert.match(r.reason ?? "", /gate-wall not wired/);
  assert.equal(ws.promoted.length, 0, "workspaces.promote() was NEVER called — the promote did not proceed");
  assert.deepEqual([...ws.discarded].sort(), ["ws0", "ws1"], "EVERY workspace discarded (nothing lands)");
});

// ── #10 CLAMP PRESERVED through the competitive path ─────────────────────────

test("competitive: per-workspace builders are spawned through the #10 clamp (no escalation)", async () => {
  // Parent "verified"; worker credential "trusted" (more trusted) ⇒ roles clamp to "verified".
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("verified", "trusted");
  const ws = compWorkspaces();
  const cap = compRoles((id) => (id === "ws0" ? { typecheck: 0, test: 0 } : { typecheck: 0, test: 0 }));
  const orch = createOrchestrator(deps({ resolveIdentity, roleClaim, workspaces: ws.workspaces, roles: cap.roles }));

  await orch.run(task, parentCtx);
  assert.equal(cap.builderTiers.length, 2, "a builder spawned per workspace");
  for (const t of cap.builderTiers) assert.equal(t, "verified", "clamped to the parent tier, NOT the worker's trusted");
});

// ── C6: KILL AFTER THE FINAL CANDIDATE, BEFORE JUDGE/PROMOTE ─────────────────

test("competitive C6: a kill after the final candidate but before judge ⇒ all discarded, no judge, no promote, rejected", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = compWorkspaces();
  const cap = compRoles((id) => (id === "ws0" ? { typecheck: 0, test: 0 } : { typecheck: 0, test: 0 }));
  // killHalt call order (competitiveN=2): 1 pre-allocate, 2 before ws0, 3 before ws1,
  // 4 the NEW final checkpoint (after the last verifier, before judge). Kill ONLY at 4.
  let calls = 0;
  const killCheck: NonNullable<OrchestratorDeps["killCheck"]> = async () => {
    calls += 1;
    return calls >= 4 ? { killed: true, signal: { mode: "hard" } } : { killed: false };
  };
  let judged = 0;
  const judge = { judge: (c: readonly BuildCandidate[]) => { judged += 1; return deterministicJudge.judge(c); } };
  const orch = createOrchestrator(deps({ resolveIdentity, roleClaim, workspaces: ws.workspaces, roles: cap.roles, judge, killCheck }));

  const r = await orch.run(task, parentCtx);
  assert.equal(judged, 0, "the judge was NOT called — a kill before the irreversible boundary stops it");
  assert.equal(ws.promoted.length, 0, "nothing promoted");
  assert.deepEqual([...ws.discarded].sort(), ["ws0", "ws1"], "EVERY candidate workspace discarded (no leak, no half-promote)");
  assert.equal(r.promoted, false);
  assert.equal(r.outcome, "rejected");
  assert.match(r.reason ?? "", /kill-switch/);
});

// ── C1 LAYER 2 FEEDS THE JUDGE: a mutated-scripts candidate is disqualified ──

test("C1: a candidate whose builder mutated package.json scripts → verifier UNTRUSTED → disqualified; the clean candidate wins", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  // ws0's diff shows the builder rewriting the "test" script (the attack); ws1 is clean.
  const diffFor = (id: string): string =>
    id === "ws0"
      ? 'diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n-    "test": "node --test",\n+    "test": "echo pass && exit 0",'
      : "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n-export const x = 1;\n+export const x = 2;";
  const promoted: string[] = [];
  const discarded: string[] = [];
  let i = 0;
  const workspaces: NonNullable<OrchestratorDeps["workspaces"]> = {
    allocate: async () => baseHandle(`ws${i++}`),
    promote: async (h): Promise<PromoteResult> => { promoted.push(h.id); return { promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }; },
    discard: async (h): Promise<DiscardResult> => { discarded.push(h.id); return { workspaceId: h.id, removed: true }; },
    diff: async (h) => diffFor(h.id),
  };
  // The REAL governed + integrity-guarded verifier (no roles.verifier override). The
  // governed exec passes the clean candidate's checks; the mutated one never reaches it.
  const governedRuns: ExecRequest[] = [];
  const governedExec = { run: async (req: ExecRequest): Promise<ExecResult> => { governedRuns.push(req); return { executed: true, exitCode: 0, stdoutTail: "ok" }; } };
  const roles: Partial<Record<WorkerRole, RoleFn>> = {
    scout: async () => ({ role: "scout", outcome: "success", summary: "s" }),
    builder: async () => ({ role: "builder", outcome: "success", summary: "b", detail: { toolRounds: 2, filesWritten: ["a.ts"], rejectedToolCalls: [], stopReason: "stop" } }),
    // NO verifier override — the orchestrator wires the real governed/integrity verifier.
  };
  const orch = createOrchestrator(deps({ resolveIdentity, roleClaim, workspaces, roles, governedExec }));

  const r = await orch.run(task, parentCtx);
  assert.equal(r.promoted, true, "a winner was promoted");
  assert.equal(r.workspaceId, "ws1", "the CLEAN candidate won (the mutated one is disqualified)");
  assert.deepEqual(promoted, ["ws1"], "only the clean candidate is promoted");
  assert.ok(discarded.includes("ws0"), "the mutated-scripts candidate is discarded, never promoted");
  // ws0's mutated check was never executed: governed-exec only ran for the clean candidate.
  for (const req of governedRuns) assert.notEqual(req.cwd, "/tmp/ws0", "the mutated candidate's check never executed");
});

// ── CANDIDATE MAPPING: verifier/builder/diff → BuildCandidate fields ─────────

test("competitive: the judge receives correctly-mapped BuildCandidates", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = compWorkspaces();
  const cap = compRoles((id) => (id === "ws0" ? { toolRounds: 4, typecheck: 0, test: 0, passed: 9 } : { typecheck: 0, test: 0 }));
  let seen: readonly BuildCandidate[] = [];
  const judge = { judge: (c: readonly BuildCandidate[]) => { seen = c; return deterministicJudge.judge(c); } };
  const orch = createOrchestrator(deps({ resolveIdentity, roleClaim, workspaces: ws.workspaces, roles: cap.roles, judge }));

  await orch.run(task, parentCtx);
  const c0 = seen.find((c) => c.workspaceId === "ws0")!;
  assert.equal(c0.typecheckPass, true, "typecheck exit 0 ⇒ pass");
  assert.equal(c0.testsPass, true, "test exit 0 ⇒ pass");
  assert.deepEqual(c0.testCount, { passed: 9, total: 10 }, "test count parsed from the verifier output");
  assert.equal(c0.toolRounds, 4, "toolRounds from the builder detail");
  assert.equal(c0.maxToolRounds, MAX_TOOL_ITERATIONS, "the builder ceiling");
  assert.equal(c0.filesWritten, 1);
  assert.equal(c0.rejectedToolCalls, 0);
  assert.equal(c0.stopReason, "stop");
  assert.equal(c0.diffLines, 3, "diff line count from workspaces.diff");
});


// ── HEAD-TO-HEAD MODEL SHOOTOUT (per-candidate models) ───────────────────────

/** Workspaces with REAL temp dirs (the real builder realpath's + checks-cwd's its worktree). */
function realCompWorkspaces() {
  const allocated: string[] = [];
  const promoted: string[] = [];
  const discarded: string[] = [];
  let i = 0;
  const workspaces: NonNullable<OrchestratorDeps["workspaces"]> = {
    allocate: async () => {
      const id = `ws${i++}`;
      const path = mkdtempSync(join(tmpdir(), `ikbi-comp-${id}-`));
      allocated.push(id);
      return { id, targetRepo: "/repo", baseBranch: "main", baseRef: "deadbeef", scratchBranch: `ikbi/ws/${id}`, path, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
    },
    promote: async (h): Promise<PromoteResult> => { promoted.push(h.id); return { promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }; },
    discard: async (h): Promise<DiscardResult> => { discarded.push(h.id); return { workspaceId: h.id, removed: true }; },
    diff: async () => "line1\nline2",
  };
  return { workspaces, allocated, promoted, discarded };
}

/** A model response: run_checks on a model's first turn, done on its second. */
function builderDriver() {
  const capturedModels: string[] = [];
  const turnByModel = new Map<string, number>();
  const invokeModel: NonNullable<OrchestratorDeps["invokeModel"]> = async (req) => {
    const m = req.model;
    capturedModels.push(m);
    const t = (turnByModel.get(m) ?? 0) + 1;
    turnByModel.set(m, t);
    const toolCalls = t === 1
      ? [{ id: "rc1", name: "run_checks", arguments: "{}" }]
      : [{ id: "d1", name: "done", arguments: JSON.stringify({ successCondition: "x", filesReadBack: ["a.ts"], selfCheck: "ran checks green", satisfied: true }) }];
    return { contractVersion: "1.1.0", model: m, provider: "p", providerModelId: m, content: "", finishReason: "tool_calls" as const, toolCalls, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } }, latencyMs: 1, fellBack: false, attempts: [] };
  };
  return { invokeModel, capturedModels };
}
/** Stub every role EXCEPT the builder (the REAL builder must run to pick up its per-candidate model). */
function nonBuilderRoles(verifierFor: (wsId: string) => { typecheck: number; test: number }): Partial<Record<WorkerRole, RoleFn>> {
  return {
    scout: async () => ({ role: "scout", outcome: "success", summary: "s" }),
    critic: async () => ({ role: "critic", outcome: "success", summary: "c" }),
    verifier: async (ctx: RoleContext) => { const o = verifierFor(ctx.workspace.id); return { role: "verifier", outcome: "success", summary: "v", detail: { verdict: o.typecheck === 0 && o.test === 0 ? "pass" : "fail", checks: checks(o.typecheck, o.test) } }; },
    integrator: async () => ({ role: "integrator", outcome: "success", summary: "i", detail: { decision: "promote", evaluation: { approved: true } } }),
  };
}

test("HEAD-TO-HEAD: competitive + a model list races DIFFERENT models per candidate, each in its own worktree", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = realCompWorkspaces();
  const drv = builderDriver();
  const governedRuns: ExecRequest[] = [];
  const governedExec = { run: async (req: ExecRequest): Promise<ExecResult> => { governedRuns.push(req); return { executed: true, exitCode: 0, stdoutTail: "ok", stderrTail: "" }; } };
  const orch = createOrchestrator(deps({ resolveIdentity, roleClaim, workspaces: ws.workspaces, roles: nonBuilderRoles(() => ({ typecheck: 0, test: 0 })), invokeModel: drv.invokeModel, governedExec, competitiveModels: ["model-a", "model-b"] }));

  await orch.run(task, parentCtx);

  assert.equal(ws.allocated.length, 2, "N = the list length (2 models → 2 candidates)");
  assert.equal(drv.capturedModels[0], "model-a", "candidate 0 raced model-a");
  assert.ok(drv.capturedModels.includes("model-b"), "candidate 1 raced model-b");
  assert.equal(new Set(drv.capturedModels).size, 2, "the candidates raced DIFFERENT models (not the same model twice)");
  // EACH CANDIDATE GETS run_checks (governed path): 2 candidates × 2 shared checks = 4 governed runs.
  assert.equal(governedRuns.length, 4, "each candidate ran the governed run_checks (typecheck + test)");
  assert.equal(new Set(governedRuns.map((r) => r.cwd)).size, 2, "each candidate's checks ran in its OWN worktree");
});

test("HEAD-TO-HEAD: the judge picks the winner by the REAL checks, regardless of model", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = realCompWorkspaces();
  const drv = builderDriver();
  const governedExec = { run: async (): Promise<ExecResult> => ({ executed: true, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) };
  // model-a's candidate (ws0) passes typecheck; model-b's (ws1) FAILS → judge disqualifies ws1.
  const roles = nonBuilderRoles((id) => (id === "ws0" ? { typecheck: 0, test: 0 } : { typecheck: 1, test: 0 }));
  const orch = createOrchestrator(deps({ resolveIdentity, roleClaim, workspaces: ws.workspaces, roles, invokeModel: drv.invokeModel, governedExec, competitiveModels: ["model-a", "model-b"] }));

  const r = await orch.run(task, parentCtx);
  assert.equal(r.promoted, true, "a winner was promoted");
  assert.equal(r.workspaceId, "ws0", "the judge picked model-a's candidate — the one that passed the real checks");
  assert.deepEqual(ws.discarded, ["ws1"], "model-b's candidate (failed typecheck) was discarded — by checks, not by model");
});

test("competitive WITHOUT a model list ⇒ competitiveN candidates all on the single builder model (old behavior)", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = realCompWorkspaces();
  const drv = builderDriver();
  const governedExec = { run: async (): Promise<ExecResult> => ({ executed: true, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) };
  // No competitiveModels → COMP config (competitiveN 2) → 2 candidates, all on builderModel().
  const orch = createOrchestrator(deps({ resolveIdentity, roleClaim, workspaces: ws.workspaces, roles: nonBuilderRoles(() => ({ typecheck: 0, test: 0 })), invokeModel: drv.invokeModel, governedExec }));

  await orch.run(task, parentCtx);
  assert.equal(ws.allocated.length, 2, "competitiveN candidates (workspace-isolation mode)");
  assert.equal(new Set(drv.capturedModels).size, 1, "all candidates use the SAME model");
  assert.equal(drv.capturedModels[0], builderModel(), "the single builder model == builderModel() (config-driven, robust to IKBI_MODEL_BUILDER)");
});

test("N = LIST LENGTH (capped at MAX_COMPETITIVE_N): a 3-model list ⇒ 3 candidates", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities("trusted", "trusted");
  const ws = realCompWorkspaces();
  const drv = builderDriver();
  const governedExec = { run: async (): Promise<ExecResult> => ({ executed: true, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) };
  const orch = createOrchestrator(deps({ resolveIdentity, roleClaim, workspaces: ws.workspaces, roles: nonBuilderRoles(() => ({ typecheck: 0, test: 0 })), invokeModel: drv.invokeModel, governedExec, competitiveModels: ["m1", "m2", "m3"] }));

  await orch.run(task, parentCtx);
  assert.equal(ws.allocated.length, 3, "one candidate per listed model (within MAX_COMPETITIVE_N=4)");
  assert.deepEqual([...new Set(drv.capturedModels)].sort(), ["m1", "m2", "m3"], "each listed model raced once");
});

/**
 * Candidate tournament (#tournament) tests.
 *
 * TWO LAYERS:
 *   1. UNIT — drive `runTournament` directly against a FAKE `TournamentEngine`. This isolates the
 *      deterministic algorithm (independence, no model-to-model communication, scoring via the REAL
 *      deterministic judge, shadow replay, fail-closed paths, full receipts).
 *   2. E2E — drive the REAL `createOrchestrator` tournament dispatch with injected workspace/role
 *      doubles + an injected `applyDiff`, proving the production wiring (per-candidate workspaces,
 *      shadow allocation, winner promoted through the existing path, candidate workspaces discarded).
 */

import assert from "node:assert/strict";
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
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import { runTournament } from "./tournament.js";
import type { CandidateRun, CandidateSpec, ShadowVerification, TournamentEngine, TournamentEvent, TournamentReceipt } from "./tournament.js";
import type { OperationContext } from "../../core/identity/index.js";
import { type RoleContext, type RoleFn, type RoleResult, type WorkerRole, type WorkerTask } from "./contract.js";

const silent = () => pino({ level: "silent" });

function makeResolver(agents: AgentRecord[]) {
  return new IdentityResolver({ registry: new AgentRegistry({ agents }), logger: silent(), now: () => 1000 });
}

function makeIdentities(parentTier = "trusted", workerTier = "trusted") {
  const resolver = makeResolver([
    { agentId: "parent-1", kind: "agent", functionalRole: "lead", defaultTrustTier: parentTier, tokenHashes: [hashToken("parent-secret")] },
    { agentId: "worker-1", kind: "agent", functionalRole: "worker", defaultTrustTier: workerTier, tokenHashes: [hashToken("worker-secret")] },
  ]);
  const parentCtx = beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
  const resolveIdentity: NonNullable<OrchestratorDeps["resolveIdentity"]> = (claim, ctx) => resolver.resolve(claim, ctx);
  const roleClaim: NonNullable<OrchestratorDeps["roleClaim"]> = () => ({ token: "worker-secret" });
  return { parentCtx, resolveIdentity, roleClaim };
}

function handle(id: string): WorkspaceHandle {
  return { id, targetRepo: "/repo", baseBranch: "main", baseRef: "deadbeef", scratchBranch: `ikbi/ws/${id}`, path: `/tmp/${id}`, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
}

const task: WorkerTask = { taskId: "t-1", targetRepo: "/repo", goal: "do the thing" };
const ctx = (): OperationContext => makeIdentities().parentCtx;

/** A full, valid BuildCandidate with overridable fields (defaults: a clean PASSING build). */
function buildCandidate(workspaceId: string, over: Partial<BuildCandidate> = {}): BuildCandidate {
  return {
    workspaceId,
    typecheckPass: true,
    testsPass: true,
    testEvidence: "executed",
    testCount: { passed: 10, total: 10 },
    toolRounds: 2,
    maxToolRounds: 40,
    rejectedToolCalls: 0,
    filesWritten: 1,
    diffLines: 10,
    stopReason: "stop",
    ...over,
  };
}

function role(r: WorkerRole, outcome: RoleResult["outcome"], detail?: Record<string, unknown>): RoleResult {
  return { role: r, outcome, summary: r, ...(detail !== undefined ? { detail } : {}) };
}

/** One candidate's scripted facts for the fake engine. */
interface CandidateScript {
  readonly candidate: Omit<BuildCandidate, "workspaceId">;
  readonly diff: string;
  readonly builderOk?: boolean;
  readonly verified?: boolean;
}

interface FakeOpts {
  /** Per-spec scripted result (keyed by model id). */
  readonly scripts: Readonly<Record<string, CandidateScript>>;
  readonly failAllocate?: (label: string) => boolean;
  readonly applyResult?: { applied: boolean; reason?: string };
  readonly shadowResult?: ShadowVerification;
  readonly promoteResult?: { promoted: boolean; reason?: string; conflicts?: readonly string[] };
  readonly killReason?: string;
}

function fakeEngine(opts: FakeOpts) {
  const calls = {
    allocate: [] as string[],
    runCandidate: [] as Array<{ wsId: string; spec: CandidateSpec; sawRuns: number }>,
    applyDiff: [] as Array<{ wsId: string; diff: string }>,
    verifyShadow: [] as string[],
    promote: [] as Array<{ wsId: string; composite: number; roleCount: number }>,
    discard: [] as string[],
    retain: [] as Array<{ wsId: string; reason: string }>,
    receipts: [] as TournamentReceipt[],
    events: [] as TournamentEvent[],
  };
  let cAlloc = 0;
  const engine: TournamentEngine = {
    verificationMode: "ladder",
    allocate: async (label) => {
      calls.allocate.push(label);
      if (opts.failAllocate?.(label) === true) return null;
      const id = label.includes("shadow") ? "shadow" : `c${cAlloc++}`;
      return handle(id);
    },
    runCandidate: async (_t, ws, spec) => {
      // Record how many prior candidate runs exist at call time — proves NO cross-candidate state
      // is threaded in: the engine receives only (task, its own workspace, its own spec).
      calls.runCandidate.push({ wsId: ws.id, spec, sawRuns: calls.runCandidate.length });
      const s = opts.scripts[spec.model];
      assert.ok(s !== undefined, `script for model ${spec.model}`);
      const builderOk = s.builderOk ?? true;
      const verified = s.verified ?? true;
      const roles: RoleResult[] = [
        role("scout", "success"),
        role("builder", builderOk ? "success" : "failure", { toolRounds: s.candidate.toolRounds, filesWritten: ["a.ts"], rejectedToolCalls: [], stopReason: s.candidate.stopReason }),
        ...(builderOk ? [role("verifier", "success", { verdict: verified ? "pass" : "fail", checks: [] })] : []),
      ];
      // Force the candidate's workspaceId to its REAL workspace (the scripted facts may carry a
      // placeholder id from the buildCandidate helper).
      const candidate: BuildCandidate = { ...buildCandidate(ws.id, s.candidate as Partial<BuildCandidate>), workspaceId: ws.id };
      const run: CandidateRun = { spec, workspace: ws, roles, candidate, diff: s.diff };
      return run;
    },
    judge: (candidates) => deterministicJudge.judge(candidates),
    applyDiff: async (ws, diff) => {
      calls.applyDiff.push({ wsId: ws.id, diff });
      return opts.applyResult ?? { applied: true };
    },
    verifyShadow: async (_t, ws) => {
      calls.verifyShadow.push(ws.id);
      return opts.shadowResult ?? { pass: true, roles: [role("verifier", "success", { verdict: "pass", checks: [] })] };
    },
    promote: async (_t, ws, roles, composite) => {
      calls.promote.push({ wsId: ws.id, composite, roleCount: roles.length });
      return opts.promoteResult ?? { promoted: true };
    },
    discard: async (ws) => void calls.discard.push(ws.id),
    retain: async (ws, reason) => void calls.retain.push({ wsId: ws.id, reason }),
    recordReceipt: async (r) => void calls.receipts.push(r),
    cost: () => 0.42,
    killed: async () => opts.killReason,
    emit: (ev) => void calls.events.push(ev),
  };
  return { engine, calls };
}

function specs(...models: string[]): CandidateSpec[] {
  return models.map((model) => ({ model, mode: "agent" as const }));
}

// ── 1. INDEPENDENCE: each candidate gets its OWN workspace ────────────────────

test("tournament: runs multiple candidates independently — each gets its own workspace", async () => {
  const { engine, calls } = fakeEngine({
    scripts: { a: { candidate: { ...buildCandidate("x") }, diff: "d-a" }, b: { candidate: { ...buildCandidate("x") }, diff: "d-b" }, c: { candidate: { ...buildCandidate("x") }, diff: "d-c" } },
  });
  await runTournament(task, ctx(), specs("a", "b", "c"), engine);

  assert.equal(calls.runCandidate.length, 3, "one run per candidate");
  const wsIds = calls.runCandidate.map((r) => r.wsId);
  assert.equal(new Set(wsIds).size, 3, "every candidate ran in a DISTINCT workspace");
  // The three candidate allocations are distinct from the shadow allocation.
  assert.ok(calls.allocate.some((l) => l.includes("shadow")), "a shadow workspace is allocated");
});

// ── 2. NO MODEL-TO-MODEL COMMUNICATION ───────────────────────────────────────

test("tournament: no model-to-model communication — a candidate never sees another's workspace or output", async () => {
  const { engine, calls } = fakeEngine({
    scripts: { a: { candidate: { ...buildCandidate("x") }, diff: "d-a" }, b: { candidate: { ...buildCandidate("x") }, diff: "d-b" } },
  });
  await runTournament(task, ctx(), specs("a", "b"), engine);

  // Each runCandidate received ONLY its own (task, workspace, spec). The recorded spec.model matches
  // the allocation order and no candidate's workspace id is reused for another candidate.
  assert.deepEqual(calls.runCandidate.map((r) => r.spec.model), ["a", "b"]);
  const wsIds = calls.runCandidate.map((r) => r.wsId);
  assert.equal(wsIds[0] !== wsIds[1], true, "candidate b did not run in candidate a's workspace");
});

// ── 3. VERIFIED PASS BEATS ALL ───────────────────────────────────────────────

test("tournament: verified pass beats all — a passing candidate wins over cheaper/smaller-diff failures", async () => {
  const { engine, calls } = fakeEngine({
    scripts: {
      // pass: PASSES verification but has a big diff + many tool rounds (would lose on cost/diff).
      pass: { candidate: { ...buildCandidate("x"), diffLines: 400, toolRounds: 30 }, diff: "winning-diff" },
      // cheapFail: tiny diff, few rounds — but tests FAIL ⇒ disqualified by the judge override.
      cheapFail: { candidate: { ...buildCandidate("x"), testsPass: false, diffLines: 2, toolRounds: 1 }, diff: "d2", verified: false },
    },
  });
  const r = await runTournament(task, ctx(), specs("pass", "cheapFail"), engine);

  assert.equal(r.outcome, "success");
  assert.equal(r.promoted, true);
  // The winner's diff — not the cheap failure's — is what gets replayed into the shadow.
  assert.equal(calls.applyDiff.length, 1);
  assert.equal(calls.applyDiff[0]!.diff, "winning-diff", "the VERIFIED candidate's diff is replayed");
});

// ── 4. SMALLER DIFF WINS ON A TIE ────────────────────────────────────────────

test("tournament: smaller diff wins on a tie — two passing candidates, the smaller diff is replayed", async () => {
  const { engine, calls } = fakeEngine({
    scripts: {
      big: { candidate: { ...buildCandidate("x"), diffLines: 200 }, diff: "big-diff" },
      small: { candidate: { ...buildCandidate("x"), diffLines: 20 }, diff: "small-diff" },
    },
  });
  const r = await runTournament(task, ctx(), specs("big", "small"), engine);

  assert.equal(r.promoted, true);
  assert.equal(calls.applyDiff[0]!.diff, "small-diff", "the smaller diff wins the tie");
});

// ── 5. SHADOW WORKSPACE REPLAY ───────────────────────────────────────────────

test("tournament: shadow workspace replay — winner's diff applied to a CLEAN workspace, then verified, then promoted", async () => {
  const { engine, calls } = fakeEngine({
    scripts: { a: { candidate: { ...buildCandidate("x"), diffLines: 5 }, diff: "winner" }, b: { candidate: { ...buildCandidate("x"), diffLines: 50 }, diff: "loser" } },
  });
  const r = await runTournament(task, ctx(), specs("a", "b"), engine);

  // The winner's diff is applied to the SHADOW (not a candidate) workspace, which is then verified
  // and promoted — IN THAT ORDER.
  assert.equal(calls.applyDiff.length, 1);
  assert.equal(calls.applyDiff[0]!.wsId, "shadow");
  assert.equal(calls.applyDiff[0]!.diff, "winner");
  assert.deepEqual(calls.verifyShadow, ["shadow"], "the shadow is verified");
  assert.equal(calls.promote.length, 1);
  assert.equal(calls.promote[0]!.wsId, "shadow", "the SHADOW is promoted, not a candidate workspace");
  assert.equal(r.workspaceId, "shadow");
  // Both candidate workspaces are discarded — only the shadow carries the change forward.
  assert.deepEqual([...calls.discard].sort(), ["c0", "c1"]);
});

// ── 6. SHADOW VERIFICATION FAILURE FAILS THE TOURNAMENT ──────────────────────

test("tournament: shadow verification failure fails the tournament (no fallback to other candidates)", async () => {
  const { engine, calls } = fakeEngine({
    scripts: { a: { candidate: { ...buildCandidate("x") }, diff: "winner" }, b: { candidate: { ...buildCandidate("x"), diffLines: 99 }, diff: "loser" } },
    shadowResult: { pass: false, roles: [role("verifier", "failure", { verdict: "fail", checks: [] })], reason: "tests failed in pristine tree" },
  });
  const r = await runTournament(task, ctx(), specs("a", "b"), engine);

  assert.equal(r.outcome, "rejected");
  assert.equal(r.promoted, false);
  assert.equal(calls.promote.length, 0, "a shadow that fails verification is NEVER promoted");
  assert.ok(calls.discard.includes("shadow"), "the failed shadow is discarded");
  assert.match(r.reason ?? "", /shadow verification failed/);
});

// ── 7. ALL CANDIDATES FAIL → TOURNAMENT FAILS (no best-of-bad) ───────────────

test("tournament: all candidates fail → tournament fails closed, nothing promoted, no shadow allocated", async () => {
  const { engine, calls } = fakeEngine({
    scripts: {
      a: { candidate: { ...buildCandidate("x"), testsPass: false }, diff: "d", verified: false },
      b: { candidate: { ...buildCandidate("x"), typecheckPass: false }, diff: "d", verified: false },
    },
  });
  const r = await runTournament(task, ctx(), specs("a", "b"), engine);

  assert.equal(r.outcome, "rejected");
  assert.equal(r.promoted, false);
  assert.equal(calls.allocate.filter((l) => l.includes("shadow")).length, 0, "no shadow is allocated when all candidates fail");
  assert.equal(calls.applyDiff.length, 0);
  assert.equal(calls.promote.length, 0);
  // One candidate retained for inspection, the rest discarded — no leak.
  assert.equal(calls.retain.length, 1);
});

// ── 8. FULL RECEIPTS ─────────────────────────────────────────────────────────

test("tournament: full receipts — every candidate + winner + shadow result recorded", async () => {
  const { engine, calls } = fakeEngine({
    scripts: { a: { candidate: { ...buildCandidate("x"), diffLines: 5, rejectedToolCalls: 0 }, diff: "winner" }, b: { candidate: { ...buildCandidate("x"), diffLines: 80 }, diff: "loser" } },
  });
  await runTournament(task, ctx(), specs("a", "b"), engine);

  assert.equal(calls.receipts.length, 1, "exactly one tournament receipt");
  const rec = calls.receipts[0]!;
  assert.equal(rec.candidates.length, 2, "every candidate is in the receipt");
  assert.deepEqual(rec.candidates.map((c) => c.model).sort(), ["a", "b"]);
  for (const c of rec.candidates) assert.equal(c.verified, true, "per-candidate verification recorded");
  assert.ok(rec.winner !== null, "winner recorded");
  assert.equal(rec.winner!.model, "a", "the smaller-diff candidate is the recorded winner");
  assert.equal(rec.shadow.applied, true);
  assert.equal(rec.shadow.verified, true);
  assert.equal(rec.shadow.workspaceId, "shadow");
  assert.equal(rec.promoted, true);
});

// ── extra UNIT: winner's diff that cannot apply fails closed ──────────────────

test("tournament: winner's diff that cannot apply to the shadow fails the tournament closed", async () => {
  const { engine, calls } = fakeEngine({
    scripts: { a: { candidate: { ...buildCandidate("x") }, diff: "winner" }, b: { candidate: { ...buildCandidate("x"), diffLines: 99 }, diff: "loser" } },
    applyResult: { applied: false, reason: "patch does not apply" },
  });
  const r = await runTournament(task, ctx(), specs("a", "b"), engine);

  assert.equal(r.outcome, "rejected");
  assert.equal(r.promoted, false);
  assert.equal(calls.verifyShadow.length, 0, "a diff that won't apply is never verified");
  assert.equal(calls.promote.length, 0);
  assert.match(r.reason ?? "", /failed to apply/);
});

// ── extra UNIT: a killed run does not allocate or promote ─────────────────────

test("tournament: a kill before allocation stops the run cleanly (rejected, nothing allocated)", async () => {
  const { engine, calls } = fakeEngine({
    scripts: { a: { candidate: { ...buildCandidate("x") }, diff: "d" } },
    killReason: "halted by kill-switch (soft)",
  });
  const r = await runTournament(task, ctx(), specs("a"), engine);

  assert.equal(r.outcome, "rejected");
  assert.equal(calls.allocate.length, 0);
  assert.equal(calls.promote.length, 0);
  assert.match(r.reason ?? "", /kill-switch/);
});

// ── extra UNIT: a skipped allocation continues with the remaining candidates ──

test("tournament: a candidate whose workspace fails to allocate is skipped; the rest still run", async () => {
  let n = 0;
  const { engine, calls } = fakeEngine({
    scripts: { a: { candidate: { ...buildCandidate("x") }, diff: "d-a" }, b: { candidate: { ...buildCandidate("x") }, diff: "d-b" } },
    failAllocate: (label) => !label.includes("shadow") && n++ === 0, // first candidate allocation fails
  });
  const r = await runTournament(task, ctx(), specs("a", "b"), engine);

  assert.equal(calls.runCandidate.length, 1, "only the candidate that allocated ran");
  assert.equal(calls.runCandidate[0]!.spec.model, "b");
  assert.equal(r.promoted, true, "the surviving candidate still wins + promotes");
});

// ════════════════════════════════════════════════════════════════════════════
//  E2E — the REAL createOrchestrator tournament dispatch + wiring
// ════════════════════════════════════════════════════════════════════════════

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
const allowGate: NonNullable<OrchestratorDeps["gateWall"]> = { evaluate: async (): Promise<PromoteGovernance> => ({ allow: true, reason: "test gate allows" }) };

/** Workspaces double: sequential ids ws0,ws1,…; records lifecycle; commit/diff are non-empty. */
function tourWorkspaces() {
  const allocated: string[] = [];
  const promoted: string[] = [];
  const discarded: string[] = [];
  let i = 0;
  const workspaces: NonNullable<OrchestratorDeps["workspaces"]> = {
    allocate: async () => { const h = handle(`ws${i++}`); allocated.push(h.id); return h; },
    promote: async (h, a): Promise<PromoteResult> => {
      promoted.push(h.id);
      if (a.governance?.allow === false) return { promoted: false, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", reason: "denied" };
      return { promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" };
    },
    discard: async (h): Promise<DiscardResult> => { discarded.push(h.id); return { workspaceId: h.id, removed: true }; },
    retain: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: false }),
    diff: async (h) => `diff for ${h.id}\nline2\nline3`,
    commit: async (): Promise<boolean> => true,
  };
  return { workspaces, allocated, promoted, discarded };
}

/** Roles double: scout/builder always succeed; verifier passes unless its workspace id is in `failOn`. */
function tourRoles(failOn: ReadonlySet<string> = new Set()) {
  return {
    scout: async (): Promise<RoleResult> => ({ role: "scout", outcome: "success", summary: "s" }),
    builder: async (): Promise<RoleResult> => ({ role: "builder", outcome: "success", summary: "b", detail: { toolRounds: 2, filesWritten: ["a.ts"], rejectedToolCalls: [], stopReason: "stop" } }),
    verifier: async (c: RoleContext): Promise<RoleResult> => {
      const pass = !failOn.has(c.workspace.id);
      return { role: "verifier", outcome: "success", summary: "v", detail: { verdict: pass ? "pass" : "fail", checks: [{ name: "typecheck", command: "tsc", exitCode: pass ? 0 : 1, outputTail: "" }, { name: "test", command: "test", exitCode: pass ? 0 : 1, outputTail: "# tests 10\n# pass 10\n" }] } };
    },
  } satisfies Partial<Record<WorkerRole, RoleFn>>;
}

const TOUR_CONFIG = { enabled: true, roleTimeoutMs: 1000, maxConcurrentRuns: 1 };

function tourDeps(extra: Partial<OrchestratorDeps>): OrchestratorDeps {
  return {
    config: TOUR_CONFIG,
    trust: fakeTrust(),
    receipts: fakeReceipts(),
    events: fakeBus().bus,
    gateWall: allowGate,
    invokeModel: async () => { throw new Error("unused"); },
    applyDiff: async () => ({ applied: true }),
    ...extra,
  };
}

test("e2e: candidate models route through the tournament — candidates + shadow allocated, shadow promoted", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const ws = tourWorkspaces();
  const applied: string[] = [];
  const orch = createOrchestrator(tourDeps({
    resolveIdentity,
    roleClaim,
    workspaces: ws.workspaces,
    roles: tourRoles(),
    candidateModels: ["model-a", "model-b"],
    applyDiff: async (w, diff) => { applied.push(`${w.id}:${diff.split("\n")[0]}`); return { applied: true }; },
  }));

  const r = await orch.run(task, parentCtx);

  assert.equal(r.outcome, "success", r.reason);
  assert.equal(r.promoted, true);
  // 2 candidate workspaces (ws0, ws1) + 1 shadow (ws2) allocated.
  assert.deepEqual(ws.allocated, ["ws0", "ws1", "ws2"]);
  assert.equal(r.workspaceId, "ws2", "the shadow workspace is the promoted one");
  assert.deepEqual(ws.promoted, ["ws2"], "ONLY the shadow is promoted — no candidate goes through promote");
  // The winner's diff was replayed into the shadow.
  assert.equal(applied.length, 1);
  assert.equal(applied[0]!.startsWith("ws2:"), true, "the diff is applied into the shadow workspace");
  // The two candidate workspaces are discarded (their changes live in the shadow now).
  assert.deepEqual([...ws.discarded].sort(), ["ws0", "ws1"]);
  assert.equal(r.verificationMode, "legacy"); // bare orchestrator (non-production) ⇒ legacy mode
});

test("e2e: a task's own `candidates` field triggers the tournament (overrides config)", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const ws = tourWorkspaces();
  const orch = createOrchestrator(tourDeps({ resolveIdentity, roleClaim, workspaces: ws.workspaces, roles: tourRoles() }));

  const r = await orch.run({ ...task, candidates: ["m1", "m2"] }, parentCtx);

  assert.equal(r.promoted, true);
  assert.equal(ws.allocated.length, 3, "2 candidates + 1 shadow");
  assert.equal(r.workspaceId, "ws2");
});

test("e2e: a real git-apply failure in the shadow fails the tournament closed", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const ws = tourWorkspaces();
  const orch = createOrchestrator(tourDeps({
    resolveIdentity,
    roleClaim,
    workspaces: ws.workspaces,
    roles: tourRoles(),
    candidateModels: ["model-a", "model-b"],
    applyDiff: async () => ({ applied: false, reason: "patch does not apply" }),
  }));

  const r = await orch.run(task, parentCtx);

  assert.equal(r.outcome, "rejected");
  assert.equal(r.promoted, false);
  assert.deepEqual(ws.promoted, [], "nothing is promoted when the winner's diff cannot apply");
  assert.match(r.reason ?? "", /failed to apply/);
});

test("e2e: no candidate models ⇒ tournament does NOT run (single-workspace path is unchanged)", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const ws = tourWorkspaces();
  const roles: Partial<Record<WorkerRole, RoleFn>> = {
    ...tourRoles(),
    critic: async () => ({ role: "critic", outcome: "success", summary: "c" }),
    integrator: async () => ({ role: "integrator", outcome: "success", summary: "i", detail: { decision: "promote", evaluation: { approved: true } } }),
  };
  const orch = createOrchestrator(tourDeps({ resolveIdentity, roleClaim, workspaces: ws.workspaces, roles }));

  await orch.run(task, parentCtx);

  assert.equal(ws.allocated.length, 1, "no candidate models ⇒ exactly ONE workspace (single path), no tournament");
});

// ════════════════════════════════════════════════════════════════════════════
//  AUTO-VERIFY RESCUE IN TOURNAMENT MODE
// ════════════════════════════════════════════════════════════════════════════

test("e2e: tournament rescues a builder that wrote files but hit no_progress — candidate proceeds through judge", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const ws = tourWorkspaces();
  let verifierRuns = 0;
  const roles: Partial<Record<WorkerRole, RoleFn>> = {
    scout: async () => ({ role: "scout", outcome: "success", summary: "s" }),
    // Builder writes files but hits no_progress (protocol termination, never calls done).
    builder: async () => ({
      role: "builder", outcome: "failure", summary: "no_progress",
      detail: { stopReason: "no_progress", filesWritten: ["a.ts"], checksRuns: 0, rejectedToolCalls: [], toolRounds: 10 },
    }),
    verifier: async (_c: RoleContext) => {
      verifierRuns += 1;
      return { role: "verifier", outcome: "success", summary: "v", detail: { verdict: "pass", checks: [{ name: "typecheck", command: "tsc", exitCode: 0, outputTail: "" }, { name: "test", command: "test", exitCode: 0, outputTail: "# tests 10\n# pass 10\n" }] } };
    },
  };
  const orch = createOrchestrator(tourDeps({
    resolveIdentity, roleClaim, workspaces: ws.workspaces, roles,
    candidateModels: ["flash-model"],
    applyDiff: async () => ({ applied: true }),
  }));

  const r = await orch.run(task, parentCtx);

  // The rescue should reclassify the builder as success, run the verifier,
  // the judge scores it, shadow replay runs, and it promotes.
  assert.equal(r.outcome, "success", r.reason);
  assert.equal(r.promoted, true, "rescued tournament candidate promotes through shadow");
  // At least 2 verifier runs: 1 rescue (in candidate) + 1 shadow verify
  assert.ok(verifierRuns >= 2, `rescue verifier + shadow verifier ran (got ${verifierRuns})`);
  // The rescued builder detail should carry the rescue stamp.
  const candidateRoles = r.roles;
  const builder = candidateRoles.find((x) => x.role === "builder");
  assert.equal((builder?.detail as Record<string, unknown> | undefined)?.autoVerifyRescue, true, "tournament rescue stamp present");
});

test("e2e: tournament does NOT rescue a builder with policy violations — candidate fails", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const ws = tourWorkspaces();
  let verifierRuns = 0;
  const roles: Partial<Record<WorkerRole, RoleFn>> = {
    scout: async () => ({ role: "scout", outcome: "success", summary: "s" }),
    builder: async () => ({
      role: "builder", outcome: "failure", summary: "no_progress",
      detail: { stopReason: "no_progress", filesWritten: ["a.ts"], checksRuns: 0, rejectedToolCalls: [], policyViolations: [{ kind: "unsafe" }], toolRounds: 10 },
    }),
    verifier: async () => { verifierRuns += 1; return { role: "verifier", outcome: "success", summary: "v", detail: { verdict: "pass", checks: [] } }; },
  };
  const orch = createOrchestrator(tourDeps({
    resolveIdentity, roleClaim, workspaces: ws.workspaces, roles,
    candidateModels: ["flash-model"],
  }));

  const r = await orch.run(task, parentCtx);

  assert.equal(r.outcome, "rejected", "tournament rejects when rescue is blocked by policy violations");
  assert.equal(r.promoted, false);
  assert.equal(verifierRuns, 0, "no rescue verifier when policy violations block rescue");
});

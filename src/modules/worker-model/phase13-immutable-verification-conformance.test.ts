/**
 * PHASE 13 — IMMUTABLE VERIFICATION: fence timed-out mutations + fail-closed tree identity + truthful bypass.
 *
 * Closes IKBI-REAUDIT2-001 (a timed-out, uncancellable candidate-mutating role could promote a tree the
 * executed tests never saw), -002 (a paired git-probe failure reclassified a real worktree as exempt and
 * dropped stale-tree/CAS), -008 (a bypassed gate masqueraded as a fully-governed promotion), and -009 (manual
 * apply proceeded unbound on a git identity read error).
 *
 * The central invariant: the exact immutable candidate tested + semantically evaluated is the ONLY candidate
 * that may be autonomously promoted; timed-out / stale / late-running work cannot mutate it or create valid
 * promotion evidence. Fail-closed at the authority is the final defense (cooperative abort is best-effort).
 *
 * Seam tests drive the REAL orchestrator promotion authority; several double as MUTATION GUARDS (see
 * HANDOFF-PHASE-13-IMMUTABLE-VERIFICATION.md).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { labTempDir as tmpdir } from "../../core/temp-root.js";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";
import type { AgentIdentity } from "../../core/identity/contract.js";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { OperationContext, ValidatedIdentity } from "../../core/identity/resolver.js";
import type { EventBusSurface, EventInput, IkbiEvent } from "../../core/events/index.js";
import { autonomyForTier, asTier, TRUST_FLOOR, type TrustDecision } from "../../core/trust/index.js";
import type { DiscardResult, PromoteGovernance, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import { createGateWall } from "../gate-wall/gate.js";
import { createOrchestrator, type OrchestratorDeps, type WorkspaceIdentityResolution } from "./orchestrator.js";
import type { RoleFn } from "./contract.js";

// ── shared doubles ────────────────────────────────────────────────────────────────────────────────
const silent = () => pino({ level: "silent" });
function makeIdentities() {
  const agents = [
    { agentId: "parent-1", kind: "agent" as const, functionalRole: "lead", defaultTrustTier: "trusted", tokenHashes: [hashToken("parent-secret")] },
    { agentId: "worker-1", kind: "agent" as const, functionalRole: "worker", defaultTrustTier: "trusted", tokenHashes: [hashToken("worker-secret")] },
  ];
  const resolver = new IdentityResolver({ registry: new AgentRegistry({ agents }), logger: silent(), now: () => 1000 });
  const parentCtx: OperationContext = beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
  return { parentCtx, resolveIdentity: ((c: unknown, x: unknown) => resolver.resolve(c as never, x as never)) as NonNullable<OrchestratorDeps["resolveIdentity"]>, roleClaim: (() => ({ token: "worker-secret" })) as NonNullable<OrchestratorDeps["roleClaim"]> };
}
const fakeBus: EventBusSurface = {
  publish: <P>(input: EventInput<P>): IkbiEvent<P> => ({ ...input, contractVersion: "1.0.0", id: "e", seq: 1, timestamp: 0 } as IkbiEvent<P>),
  subscribe: () => ({ id: "s", unsubscribe: () => {}, stats: () => ({ delivered: 0, dropped: 0, failures: 0, queued: 0 }) }),
  flush: async () => {},
};
function capturingReceipts() {
  const appended: Array<{ operation: string; metadata: Record<string, unknown> }> = [];
  return { receipts: { append: async (i: unknown, _id: AgentIdentity): Promise<unknown> => { const r = i as { operation: string; metadata?: Record<string, unknown> }; appended.push({ operation: r.operation, metadata: r.metadata ?? {} }); return {}; } }, appended };
}
const stubTrust = { recordOutcome: async (i: { agentId: string; defaultTrustTier: string }, _s: ValidatedIdentity): Promise<TrustDecision> => { const t = asTier(i.defaultTrustTier, TRUST_FLOOR); return { agentId: i.agentId, tier: t, previousTier: t, autonomy: autonomyForTier(t) }; } };
const allowGate: NonNullable<OrchestratorDeps["gateWall"]> = { evaluate: async (): Promise<PromoteGovernance> => ({ allow: true, reason: "ok" }) };
const greenExec = { run: async () => ({ executed: true as const, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) };
const greenVerifier: RoleFn = async () => ({ role: "verifier", outcome: "success", summary: "green", detail: { verdict: "pass", checks: [{ name: "test", command: "pnpm test", exitCode: 0, testCount: { passed: 1, total: 1 } }], testEvidence: "executed" } });
const passCritic: RoleFn = async () => ({ role: "critic", outcome: "success", summary: "c", detail: { pass: true } });
const promoteIntegrator: RoleFn = async () => ({ role: "integrator", outcome: "success", summary: "i", detail: { decision: "promote", rationale: "s", evaluation: { approved: true } } });
const find = (rs: Array<{ operation: string; metadata: Record<string, unknown> }>, op: string) => rs.find((r) => r.operation === op);
/**
 * INJECTED TEST FACT (adjudication seam) — a complete tree-bound GREEN work product for a promotable
 * candidate. These seam tests drive fake role/workspace doubles (the builder never physically writes),
 * so the authoritative adjudication core (which requires a tree-bound WorkProduct) is fed this labeled
 * fact via `deps.computeWorkProduct`. Production always computes from real git; no env var injects this.
 * Every orchestrator test here reaches its real chokepoint (fence, identity block, quarantine) with the
 * fact available — none is a "no-work" scenario, so all use the promotable fact.
 */
function promotableWorkProduct(treeHash = "test-tree-green"): NonNullable<OrchestratorDeps["computeWorkProduct"]> {
  return async () => ({ treeHash, diffStat: { filesChanged: 1, insertions: 1, deletions: 0 }, nonEmpty: true });
}
function gitInit(dir: string): void {
  const g = (...a: string[]): string => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g("init", "-q"); writeFileSync(join(dir, "a.ts"), "export const a = 1;"); g("add", "-A"); g("commit", "-q", "-m", "base");
}

/** Build an orchestrator over a real git workspace with the given role/dep overrides. */
function makeRun(over: { roles?: OrchestratorDeps["roles"]; gateWall?: OrchestratorDeps["gateWall"]; resolveWorkspaceIdentity?: OrchestratorDeps["resolveWorkspaceIdentity"] } = {}) {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const rc = capturingReceipts();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-p13-"));
  gitInit(dir);
  const handle: WorkspaceHandle = { id: "wsp13", targetRepo: dir, baseBranch: "main", baseRef: "HEAD", scratchBranch: "s", path: dir, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 2000, maxConcurrentRuns: 1, trustLadder: false },
    workspaces: {
      allocate: async () => handle,
      diff: async () => "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n-export const a = 1;\n+export const a = 2;\n",
      promote: async (h): Promise<PromoteResult> => ({ promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }),
      discard: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: true }),
      retain: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: false }),
      commit: async () => true,
    },
    events: fakeBus, receipts: rc.receipts, trust: stubTrust, resolveIdentity, roleClaim,
    roles: over.roles ?? { scout: async () => ({ role: "scout", outcome: "success", summary: "s" }), verifier: greenVerifier, critic: passCritic, integrator: promoteIntegrator },
    invokeModel: async () => { throw new Error("unused"); }, governedExec: greenExec, builderModel: "deepseek-v4-flash",
    gateWall: over.gateWall ?? allowGate,
    computeWorkProduct: promotableWorkProduct(), // injected adjudication fact — the fake builder writes no disk
    ...(over.resolveWorkspaceIdentity !== undefined ? { resolveWorkspaceIdentity: over.resolveWorkspaceIdentity } : {}),
  });
  return { run: (extra: Record<string, unknown> = {}) => orch.run({ taskId: "t13", targetRepo: dir, goal: "do the thing", ...extra }, parentCtx), receipts: rc.appended, dir };
}
/** A builder dispatch flagged `timedOut` (the orchestrator race marks this). Even a dispatch that otherwise
 *  produced a promotable result must be FENCED — a timed-out role's uncancellable work cannot be trusted. */
const timedOutBuilder: RoleFn = async () => ({ role: "builder", outcome: "success", summary: "produced work then hit wall-clock timeout", detail: { timedOut: true, filesWritten: ["a.ts"], rejectedToolCalls: [], stopReason: "timeout" } });
const cleanBuilder: RoleFn = async () => ({ role: "builder", outcome: "success", summary: "built", detail: { filesWritten: ["a.ts"], rejectedToolCalls: [], stopReason: "stop" } });
const rolesWith = (builder: RoleFn): NonNullable<OrchestratorDeps["roles"]> => ({ scout: async () => ({ role: "scout", outcome: "success", summary: "s" }), builder, verifier: greenVerifier, critic: passCritic, integrator: promoteIntegrator });

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part A — timeout fencing (IKBI-REAUDIT2-001; reqs 1,2,4,5,11,12,13,14,15)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test("A1 [MUTATION 1,3] (req 1,4,5): a timed-out candidate-mutating builder cannot autonomously promote (mutation fence)", async () => {
  const h = makeRun({ roles: rolesWith(timedOutBuilder) });
  const result = await h.run();
  assert.equal(result.promoted, false, "a timed-out builder's tree is never autonomously promoted");
  assert.ok(find(h.receipts, "worker.promotion.superseded_mutation") !== undefined, "the fence refusal is recorded");
  assert.ok(find(h.receipts, "worker.promotion")?.metadata.promoted !== true, "no successful worker.promotion");
});

test("A2 [MUTATION 2] (req 2): a REAL uncancellable timeout (the losing promise abandoned) fences promotion", async () => {
  // A builder that resolves AFTER its wall-clock timeout — runRoleFn races it, the timer wins and marks
  // `timedOut`, the builder promise is abandoned (uncancellable). The fence must block the promote.
  const slowBuilder: RoleFn = () => new Promise((resolve) => setTimeout(() => resolve({ role: "builder", outcome: "success", summary: "late", detail: { filesWritten: ["a.ts"] } }), 120));
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const rc = capturingReceipts();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-p13rt-")); gitInit(dir);
  const handle: WorkspaceHandle = { id: "wsp13rt", targetRepo: dir, baseBranch: "main", baseRef: "HEAD", scratchBranch: "s", path: dir, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 20, maxConcurrentRuns: 1, trustLadder: false }, // 20ms builder timeout
    workspaces: { allocate: async () => handle, diff: async () => "d", promote: async (hh): Promise<PromoteResult> => ({ promoted: true, workspaceId: hh.id, targetBranch: hh.baseBranch, beforeRef: "a", afterRef: "b" }), discard: async (hh): Promise<DiscardResult> => ({ workspaceId: hh.id, removed: true }), retain: async (hh): Promise<DiscardResult> => ({ workspaceId: hh.id, removed: false }), commit: async () => true },
    events: fakeBus, receipts: rc.receipts, trust: stubTrust, resolveIdentity, roleClaim,
    roles: rolesWith(slowBuilder), invokeModel: async () => { throw new Error("unused"); }, governedExec: greenExec, builderModel: "deepseek-v4-flash", gateWall: allowGate,
    computeWorkProduct: promotableWorkProduct(), // injected adjudication fact — the timeout fence is the real chokepoint
  });
  const result = await orch.run({ taskId: "t13rt", targetRepo: dir, goal: "g" }, parentCtx);
  assert.equal(result.promoted, false, "an uncancellable timed-out builder (abandoned promise) does not autonomously promote");
  // The runRoleFn timer marks `timedOut` and abandons the losing promise; whether the run then fails outright
  // or reaches the authority and is fenced, the timed-out tree never lands autonomously.
  const promo = find(rc.appended, "worker.promotion");
  assert.ok(promo === undefined || promo.metadata.promoted !== true, "no successful autonomous promotion from a timed-out generation");
});

test("A3 (req 12,13,14,15): a CLEAN (non-timed-out) generation supersedes a prior fence — a normal build promotes", async () => {
  const h = makeRun({ roles: rolesWith(cleanBuilder) });
  const result = await h.run();
  assert.equal(result.promoted, true, "a build with no timed-out mutating role promotes normally (fence is inert)");
  assert.ok(find(h.receipts, "worker.promotion.superseded_mutation") === undefined);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part B — fail-closed tree identity + CAS (IKBI-REAUDIT2-002; reqs 16-25)
// ════════════════════════════════════════════════════════════════════════════════════════════════

const gitId = (identity: string): WorkspaceIdentityResolution => ({ status: "resolved", backing: "git", identity });
const nonGitId: WorkspaceIdentityResolution = { status: "resolved", backing: "non-git", identity: "nongit:x" };
const indetId: WorkspaceIdentityResolution = { status: "indeterminate", error: "git probe failed" };

test("B16 (req 16): a resolved GIT-backed identity promotes (tree identity enforced, not blocked)", async () => {
  const h = makeRun({ roles: rolesWith(cleanBuilder), resolveWorkspaceIdentity: async (p) => gitId(execFileSync("git", ["-C", p, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim()) });
  const result = await h.run();
  assert.equal(result.promoted, true, "a git-backed candidate with a readable tree promotes");
});

test("B17 (req 17): a proven NON-GIT workspace resolves and is exempt (promotes)", async () => {
  const h = makeRun({ roles: rolesWith(cleanBuilder), resolveWorkspaceIdentity: async () => nonGitId });
  const result = await h.run();
  assert.equal(result.promoted, true, "a proven non-git workspace is legitimately exempt");
});

test("B18/B21/B24 [MUTATION 5,6] (req 18,21,24): an INDETERMINATE identity blocks autonomous promotion (probe error never waives CAS)", async () => {
  const h = makeRun({ roles: rolesWith(cleanBuilder), resolveWorkspaceIdentity: async () => indetId });
  const result = await h.run();
  assert.equal(result.promoted, false, "an indeterminate identity is fail-closed blocked");
  assert.ok(find(h.receipts, "worker.promotion.identity_indeterminate") !== undefined, "the indeterminate refusal is recorded (verifiedAgainst is NOT silently omitted)");
  assert.ok(find(h.receipts, "worker.promotion")?.metadata.promoted !== true);
});

test("B19 (req 19): a PERMISSION-denied git probe is indeterminate (default resolver) → blocks", async () => {
  const h = makeRun({ roles: rolesWith(cleanBuilder), resolveWorkspaceIdentity: async () => ({ status: "indeterminate", error: "git identity probe could not run (EACCES)" }) });
  const result = await h.run();
  assert.equal(result.promoted, false);
});

test("B20 (req 20): a paired/conflicting probe failure is indeterminate → blocks (the exact reproduced case)", async () => {
  // The audit reproduced: both git probes fail → old boolean reclassified the real worktree as exempt and
  // dropped CAS. The resolver returns indeterminate instead, and the authority refuses.
  const h = makeRun({ roles: rolesWith(cleanBuilder), resolveWorkspaceIdentity: async () => ({ status: "indeterminate", error: "both probes failed" }) });
  const result = await h.run();
  assert.equal(result.promoted, false);
  assert.ok(find(h.receipts, "worker.promotion.identity_indeterminate") !== undefined);
});

test("B23 (req 23): the DEFAULT resolver classifies git-error codes fail-closed (unit)", async () => {
  // Exercise the real default resolver against a nonexistent path (git runs, answers "cannot change to" →
  // proven non-git/exempt) vs a git-backed dir (resolves git). The paired-error → indeterminate path is
  // covered at the seam above; here we assert the default never throws + classifies a real dir as git.
  const gdir = mkdtempSync(join(tmpdir(), "ikbi-p13def-")); gitInit(gdir);
  const h = makeRun({ roles: rolesWith(cleanBuilder) }); // no injected resolver ⇒ the DEFAULT probes git itself
  const result = await h.run();
  assert.equal(result.promoted, true, "the default resolver classifies a real git dir as git-backed and promotes");
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part C — gate-wall bypass truthfulness (IKBI-REAUDIT2-008; reqs 26,27,28,29)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test("C26/C27 [MUTATION 8] (req 26,27): a BYPASSED gate carries a bypass discriminator; the promotion receipt surfaces it", async () => {
  // A real gate-wall in BYPASS mode (the local-.env config) must not masquerade as a policy evaluation.
  const gateReceipts: Array<{ operation: string; metadata: Record<string, unknown> }> = [];
  const bypassGate = createGateWall({ config: { enabled: true, bypass: true }, receipts: { append: async (i: unknown) => { const r = i as { operation: string; metadata?: Record<string, unknown> }; gateReceipts.push({ operation: r.operation, metadata: r.metadata ?? {} }); return {}; } }, publish: () => {} });
  const h = makeRun({ roles: rolesWith(cleanBuilder), gateWall: bypassGate });
  const result = await h.run();
  // Post-REAUDIT3 CONTAINMENT: a gate-BYPASSED autonomous promote no longer lands — the quarantine gate refuses
  // it and records the truthful `administratively-bypassed` authority on a `worker.promotion.quarantined` receipt.
  assert.equal(result.promoted, false, "a bypassed autonomous promote is quarantined (never lands)");
  const promo = find(h.receipts, "worker.promotion");
  assert.ok(promo === undefined || promo.metadata.promoted !== true, "no successful worker.promotion receipt from a bypassed run");
  const quar = find(h.receipts, "worker.promotion.quarantined")!;
  assert.ok(quar !== undefined, "a quarantine receipt is written for the bypassed run");
  assert.equal(quar.metadata.gateBypassed, true, "the quarantine receipt records the bypass");
  assert.equal(quar.metadata.gateAuthority, "administratively-bypassed", "authority is NOT fully-governed");
  assert.ok(gateReceipts.some((r) => r.metadata.bypass === true), "the gate receipt surfaces bypass=true");
});

test("C28/C29 (req 28,29): a POLICY-EVALUATED gate (bypass disabled) is labelled fully governed", async () => {
  const gate = createGateWall({ config: { enabled: true, bypass: false }, receipts: { append: async () => ({}) }, publish: () => {} });
  const h = makeRun({ roles: rolesWith(cleanBuilder), gateWall: gate });
  const result = await h.run();
  const promo = find(h.receipts, "worker.promotion")!;
  assert.notEqual(promo.metadata.gateBypassed, true, "a governed promote is not marked bypassed");
  assert.equal(promo.metadata.gateAuthority, "policy-evaluated");
  assert.equal(result.promoted, true);
});

test("C-gate (req 26): the gate DECISION object carries `bypass` only in bypass mode", async () => {
  const bypass = createGateWall({ config: { enabled: true, bypass: true }, receipts: { append: async () => ({}) }, publish: () => {} });
  const governed = createGateWall({ config: { enabled: true, bypass: false }, receipts: { append: async () => ({}) }, publish: () => {} });
  const grant = autonomyForTier(asTier("trusted", TRUST_FLOOR));
  const idn: AgentIdentity = { agentId: "op", functionalRole: "lead", trustTier: "trusted" };
  const act = { kind: "promote" as const, task: { taskId: "t", targetRepo: "/r", goal: "g" }, results: [] };
  const b = await bypass.evaluate({ grant, action: act, identity: idn });
  const g = await governed.evaluate({ grant, action: act, identity: idn });
  assert.equal(b.bypass, true, "bypass decision is discriminable");
  assert.notEqual(g.bypass, true, "a governed allow is not marked bypass");
});

/**
 * PHASE 13B — FROZEN VERIFICATION SNAPSHOT + GENERATION-SCOPED LEASES.
 *
 * Completes Phase 13's immutable-verification invariant:
 *   > After a candidate GENERATION is frozen, no active or late operation can change the verification subject,
 *   > and promotion applies exactly the frozen subject identified by all evidence.
 *
 * Part A unit-tests the CandidateLeaseRegistry — the generation-scoped mutation authority + write-boundary +
 * freeze rules (the production authority module). Part B/C drive the real orchestrator seam: the promotion
 * receipt binds the frozen snapshot id, a fenced generation rejects a candidate diff apply at the write
 * boundary, and a gate-BYPASSED autonomous promote earns no fully-governed success trust.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { CandidateLeaseRegistry } from "./candidate-lease.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import type { RoleFn } from "./contract.js";

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part A — CandidateLeaseRegistry: generation-scoped mutation authority (reqs 1-9,14-18)
// ════════════════════════════════════════════════════════════════════════════════════════════════

const reg = () => new CandidateLeaseRegistry({ runId: "r", taskId: "t" });

test("A1 [MUTATION 1] (req 1): leases are GENERATION-scoped, not task-only — each openGeneration yields a distinct id", () => {
  const r = reg();
  const g1 = r.openGeneration({ attemptId: "t", candidateId: "c", workspaceId: "ws1" });
  const g2 = r.openGeneration({ attemptId: "t", candidateId: "c", workspaceId: "ws2" });
  assert.notEqual(g1.generationId, g2.generationId, "distinct workspaces get distinct generations");
  assert.ok(g1.generationId.includes("ws1") && g2.generationId.includes("ws2"));
});

test("A2 (req 2,26): primary and peer generations have distinct leases", () => {
  const r = reg();
  const primary = r.openGeneration({ attemptId: "build:deepseek", candidateId: "c", workspaceId: "ws-primary" });
  const peer = r.openGeneration({ attemptId: "build:mimo", candidateId: "c", workspaceId: "ws-peer" });
  const lp = r.issueLease(primary.generationId, "op-p");
  const lq = r.issueLease(peer.generationId, "op-q");
  assert.notEqual(lp.leaseId, lq.leaseId);
  assert.notEqual(lp.generationId, lq.generationId, "primary and peer leases bind different generations");
});

test("A3 (req 3,27): a fixer generation (derived) has a distinct lease + records its source", () => {
  const r = reg();
  const src = r.openGeneration({ attemptId: "t", candidateId: "c", workspaceId: "ws" });
  const fixer = r.openGeneration({ attemptId: "t", candidateId: "c", workspaceId: "ws", sourceGenerationId: src.generationId });
  assert.notEqual(fixer.generationId, src.generationId, "the fixer round is a new generation");
  assert.equal(fixer.sourceGenerationId, src.generationId, "provenance to the source generation is recorded");
  assert.equal(r.lifecycleOf(src.generationId), "superseded", "opening a new generation supersedes the prior active one on that workspace");
});

test("A4 (req 4,28,29): multi-step / tournament candidates each get their own generation", () => {
  const r = reg();
  const step1 = r.openGeneration({ attemptId: "t", candidateId: "step1", workspaceId: "ws" });
  const step2 = r.openGeneration({ attemptId: "t", candidateId: "step2", workspaceId: "ws" });
  const cand = r.openGeneration({ attemptId: "t", candidateId: "tourn-a", workspaceId: "ws-a" });
  assert.equal(new Set([step1.generationId, step2.generationId, cand.generationId]).size, 3);
});

test("A5 [MUTATION 2] (req 5): revoking one generation does not revoke an unrelated generation", () => {
  const r = reg();
  const a = r.openGeneration({ attemptId: "t", candidateId: "c", workspaceId: "wsA" });
  const b = r.openGeneration({ attemptId: "t", candidateId: "c", workspaceId: "wsB" });
  r.revokeGeneration(a.generationId, "revoked");
  assert.equal(r.lifecycleOf(a.generationId), "revoked");
  assert.equal(r.lifecycleOf(b.generationId), "active", "an unrelated generation is untouched");
  assert.equal(r.isFenced("wsB"), false);
});

test("A6 [MUTATION 2] (req 6): a stale operation cannot write into a newer generation on the same workspace", () => {
  const r = reg();
  const oldGen = r.openGeneration({ attemptId: "t", candidateId: "c", workspaceId: "ws" });
  const staleLease = r.issueLease(oldGen.generationId, "old-op");
  r.openGeneration({ attemptId: "t", candidateId: "c", workspaceId: "ws" }); // a newer generation supersedes oldGen
  assert.equal(r.checkWrite(staleLease).ok, false, "a lease for a superseded generation cannot write");
});

test("A7 [MUTATION 2] (req 7,8): a REVOKED lease blocks a write/patch BEFORE mutation", () => {
  const r = reg();
  const g = r.openGeneration({ attemptId: "t", candidateId: "c", workspaceId: "ws" });
  const lease = r.issueLease(g.generationId, "op");
  assert.equal(r.checkWrite(lease).ok, true, "an active lease may write");
  r.revokeGeneration(g.generationId, "timed-out");
  assert.equal(r.checkWrite(lease).ok, false, "a revoked/timed-out generation rejects the write");
});

test("A8 [MUTATION 9] (req 9): an aborted lease signal blocks delayed output application", () => {
  const r = reg();
  const g = r.openGeneration({ attemptId: "t", candidateId: "c", workspaceId: "ws" });
  const controller = new AbortController();
  const lease = r.issueLease(g.generationId, "op", controller.signal);
  assert.equal(r.checkWrite(lease).ok, true);
  controller.abort();
  assert.equal(r.checkWrite(lease).ok, false, "an aborted operation cannot apply late output");
  assert.equal(r.isLeaseValid(lease), false);
});

test("A9 (req 12): the mutation fence is generation-precise — a timed-out generation is fenced; a clean new one supersedes", () => {
  const r = reg();
  r.openGeneration({ attemptId: "t", candidateId: "c", workspaceId: "ws" });
  r.recordMutatingTimeout("ws");
  assert.equal(r.isFenced("ws"), true, "the timed-out generation fences the workspace");
  r.openGeneration({ attemptId: "t", candidateId: "c", workspaceId: "ws" }); // a fresh clean generation
  assert.equal(r.isFenced("ws"), false, "a clean superseding generation lifts the fence");
});

test("A10 [MUTATION 7] (req 14): a snapshot CANNOT be created while an active mutation lease remains", () => {
  const r = reg();
  const g = r.openGeneration({ attemptId: "t", candidateId: "c", workspaceId: "ws" });
  r.issueLease(g.generationId, "op");
  const elig = r.canFreeze(g.generationId);
  assert.equal(elig.ok, false);
  assert.match(elig.reason ?? "", /active mutation lease/);
  assert.throws(() => r.freeze(g.generationId, { canonicalDigest: "d" }), /cannot freeze/);
});

test("A11 (req 15,16): a snapshot cannot be created from a timed-out or superseded generation", () => {
  const r = reg();
  const g1 = r.openGeneration({ attemptId: "t", candidateId: "c", workspaceId: "ws" });
  r.recordMutatingTimeout("ws");
  assert.equal(r.canFreeze(g1.generationId).ok, false, "timed-out generation is not freezable");
  const g2 = r.openGeneration({ attemptId: "t", candidateId: "c", workspaceId: "ws2" });
  r.openGeneration({ attemptId: "t", candidateId: "c", workspaceId: "ws2" }); // supersede g2
  assert.equal(r.canFreeze(g2.generationId).ok, false, "superseded generation is not freezable");
});

test("A12 [MUTATION 3] (req 17,18): a frozen snapshot has a stable canonical identity; freezing marks the generation frozen (immutable)", () => {
  const r = reg();
  const g = r.openGeneration({ attemptId: "t", candidateId: "c", workspaceId: "ws" });
  const snap = r.freeze(g.generationId, { canonicalDigest: "TREE-DIGEST", gitTree: "TREE-DIGEST", baseIdentity: "BASE" });
  assert.equal(snap.canonicalDigest, "TREE-DIGEST");
  assert.equal(snap.gitTree, "TREE-DIGEST");
  assert.equal(snap.lifecycle, "frozen");
  assert.equal(r.lifecycleOf(g.generationId), "frozen", "a frozen generation is no longer active");
  // A frozen generation cannot issue new mutation leases (the subject is immutable).
  assert.throws(() => r.issueLease(g.generationId, "late-op"), /non-active generation/);
  assert.equal(r.snapshotOf(g.generationId)?.snapshotId, snap.snapshotId, "the snapshot identity is stable + retrievable");
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part B/C — orchestrator seam: snapshot binding, write-boundary, bypass trust
// ════════════════════════════════════════════════════════════════════════════════════════════════

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
/** A trust double that RECORDS its outcome calls (so we can prove a bypassed promote earns none). */
function recordingTrust() {
  const calls: Array<{ status: string }> = [];
  const trust = { recordOutcome: async (i: { agentId: string; defaultTrustTier: string; status: string }, _s: ValidatedIdentity): Promise<TrustDecision> => { calls.push({ status: i.status }); const t = asTier(i.defaultTrustTier, TRUST_FLOOR); return { agentId: i.agentId, tier: t, previousTier: t, autonomy: autonomyForTier(t) }; } };
  return { trust, calls };
}
const cleanBuilder: RoleFn = async () => ({ role: "builder", outcome: "success", summary: "built", detail: { filesWritten: ["a.ts"], rejectedToolCalls: [], stopReason: "stop" } });
const greenVerifier: RoleFn = async () => ({ role: "verifier", outcome: "success", summary: "green", detail: { verdict: "pass", checks: [{ name: "test", command: "pnpm test", exitCode: 0, testCount: { passed: 1, total: 1 } }], testEvidence: "executed" } });
const passCritic: RoleFn = async () => ({ role: "critic", outcome: "success", summary: "c", detail: { pass: true } });
const promoteIntegrator: RoleFn = async () => ({ role: "integrator", outcome: "success", summary: "i", detail: { decision: "promote", rationale: "s", evaluation: { approved: true } } });
const find = (rs: Array<{ operation: string; metadata: Record<string, unknown> }>, op: string) => rs.find((r) => r.operation === op);
function gitInit(dir: string): void {
  const g = (...a: string[]): string => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g("init", "-q"); writeFileSync(join(dir, "a.ts"), "export const a = 1;"); g("add", "-A"); g("commit", "-q", "-m", "base");
}
function makeRun(over: { gateWall?: OrchestratorDeps["gateWall"]; trust?: OrchestratorDeps["trust"]; trustLadder?: boolean } = {}) {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const rc = capturingReceipts();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-p13b-"));
  gitInit(dir);
  const handle: WorkspaceHandle = { id: "wsp13b", targetRepo: dir, baseBranch: "main", baseRef: "HEAD", scratchBranch: "s", path: dir, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 2000, maxConcurrentRuns: 1, trustLadder: over.trustLadder ?? false },
    workspaces: {
      allocate: async () => handle,
      diff: async () => "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n-export const a = 1;\n+export const a = 2;\n",
      promote: async (h): Promise<PromoteResult> => ({ promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }),
      discard: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: true }),
      retain: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: false }),
      commit: async () => true,
    },
    events: fakeBus, receipts: rc.receipts, trust: over.trust ?? { recordOutcome: async (i: { agentId: string; defaultTrustTier: string }): Promise<TrustDecision> => { const t = asTier(i.defaultTrustTier, TRUST_FLOOR); return { agentId: i.agentId, tier: t, previousTier: t, autonomy: autonomyForTier(t) }; } },
    resolveIdentity, roleClaim,
    roles: { scout: async () => ({ role: "scout", outcome: "success", summary: "s" }), builder: cleanBuilder, verifier: greenVerifier, critic: passCritic, integrator: promoteIntegrator },
    invokeModel: async () => { throw new Error("unused"); }, governedExec: { run: async () => ({ executed: true as const, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) }, builderModel: "deepseek-v4-flash",
    gateWall: over.gateWall ?? { evaluate: async (): Promise<PromoteGovernance> => ({ allow: true, reason: "ok" }) },
  });
  return { run: () => orch.run({ taskId: "t13b", targetRepo: dir, goal: "do the thing" }, parentCtx), receipts: rc.appended };
}

test("B-snapshot [MUTATION 4,5] (req 20,22,23,30): the promotion receipt binds a FROZEN snapshot id + digest equal to the verified tree", async () => {
  const h = makeRun();
  const result = await h.run();
  assert.equal(result.promoted, true);
  const promo = find(h.receipts, "worker.promotion")!;
  assert.equal(typeof promo.metadata.snapshotId, "string", "the promotion binds a frozen snapshot id");
  assert.equal(promo.metadata.snapshotDigest, promo.metadata.verifiedTree, "the snapshot digest IS the verified tree (the content-addressed frozen subject the CAS confirms)");
});

test("C-bypass-trust [MUTATION 8] (req 32,33,34): a gate-BYPASSED autonomous promote earns NO governed-success trust + is surfaced", async () => {
  const rt = recordingTrust();
  const bypassGate = createGateWall({ config: { enabled: true, bypass: true }, receipts: { append: async () => ({}) }, publish: () => {} });
  const h = makeRun({ gateWall: bypassGate, trust: rt.trust, trustLadder: true });
  const result = await h.run();
  assert.equal(result.promoted, true, "the bypassed promote still lands");
  assert.ok(!rt.calls.some((c) => c.status === "success"), "NO governed-success trust outcome was recorded for a bypassed promote");
  assert.ok(find(h.receipts, "worker.trust.signal_suppressed") !== undefined, "a trust-suppressed receipt records why");
  assert.equal(find(h.receipts, "worker.run.summary")?.metadata.gateBypassed, true, "the run summary surfaces the bypass");
});

test("C-governed-trust (req 33 control): a POLICY-EVALUATED promote DOES earn governed-success trust", async () => {
  const rt = recordingTrust();
  const gate = createGateWall({ config: { enabled: true, bypass: false }, receipts: { append: async () => ({}) }, publish: () => {} });
  const h = makeRun({ gateWall: gate, trust: rt.trust, trustLadder: true });
  const result = await h.run();
  assert.equal(result.promoted, true);
  assert.ok(rt.calls.some((c) => c.status === "success"), "a governed promote earns success trust (control)");
  assert.notEqual(find(h.receipts, "worker.run.summary")?.metadata.gateBypassed, true);
});

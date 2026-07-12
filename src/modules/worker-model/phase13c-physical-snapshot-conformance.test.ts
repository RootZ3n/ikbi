/**
 * PHASE 13C — PHYSICAL FROZEN VERIFICATION SNAPSHOT.
 *
 * The final Phase 13 containment pass. It proves the physically-isolated snapshot subject:
 *   > Autonomous promotion binds a physically isolated snapshot (a read-only detached worktree) whose exact
 *   > committed tree is the verified subject; a source mutation after freeze cannot change it; a git-backed
 *   > candidate that cannot be physically frozen + verified fails closed; and a timed-out builder is aborted.
 *
 * Part A integration-tests the physical snapshot (real git). Part B drives the orchestrator seam (the promotion
 * receipt binds the physically-isolated snapshot; an integrity failure blocks). Part C proves the builder tool
 * loop honors the cooperative abort. Several double as MUTATION GUARDS — see HANDOFF-PHASE-13C-PHYSICAL-SNAPSHOT.md.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";
import type { AgentIdentity } from "../../core/identity/contract.js";
import { neutralizeUntrusted as coreNeutralize } from "../../core/injection/index.js";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { OperationContext, ValidatedIdentity } from "../../core/identity/resolver.js";
import type { EventBusSurface, EventInput, IkbiEvent } from "../../core/events/index.js";
import { autonomyForTier, asTier, TRUST_FLOOR, type TrustDecision } from "../../core/trust/index.js";
import type { DiscardResult, PromoteGovernance, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import { createPhysicalSnapshot, verifySnapshotUnchanged } from "./workspace-snapshot.js";
import { createBuilder } from "./builder.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import type { RoleContext, RoleFn } from "./contract.js";

function gitInit(dir: string): string {
  const g = (...a: string[]): string => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g("init", "-q"); writeFileSync(join(dir, "a.ts"), "export const a = 1;\n"); g("add", "-A"); g("commit", "-q", "-m", "base");
  return g("rev-parse", "HEAD^{tree}").trim();
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part A — physical snapshot (real git integration; reqs 1,2,3,4,5,15,36)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test("A1 [MUTATION 1] (req 1): the snapshot lives at a SEPARATE physical path from the source workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p13c-a1-")); const tree = gitInit(dir);
  const snap = (await createPhysicalSnapshot(dir, tree))!;
  assert.ok(snap !== undefined);
  assert.notEqual(snap.snapshotPath, dir, "the snapshot is not the source path");
  assert.ok(existsSync(join(snap.snapshotPath, "a.ts")), "the snapshot physically contains the candidate content");
  await snap.cleanup();
});

test("A2 [MUTATION 2] (req 2,4,5): the snapshot is READ-ONLY (enforced + write-probed)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p13c-a2-")); const tree = gitInit(dir);
  const snap = (await createPhysicalSnapshot(dir, tree))!;
  assert.equal(snap.immutable, true, "read-only enforcement + probe confirmed immutability");
  assert.throws(() => writeFileSync(join(snap.snapshotPath, "a.ts"), "mutate"), /EACCES|EROFS|permission/i, "a direct write to the snapshot is rejected by the filesystem");
  await snap.cleanup();
});

test("A3 [MUTATION 3] (req 3,14): a source mutation AFTER freeze does NOT change the snapshot content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p13c-a3-")); const tree = gitInit(dir);
  const g = (...a: string[]): string => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  const snap = (await createPhysicalSnapshot(dir, tree))!;
  writeFileSync(join(dir, "a.ts"), "export const a = 999;\n"); g("add", "-A"); g("commit", "-q", "-m", "late");
  assert.equal(readFileSync(join(snap.snapshotPath, "a.ts"), "utf8"), "export const a = 1;\n", "the snapshot still holds the tested content after a late source commit");
  assert.equal(await verifySnapshotUnchanged(snap), true, "the snapshot still resolves to its recorded tree");
  await snap.cleanup();
});

test("A4 (req 16,30): a tree-mismatch (source ≠ expected verified tree) FAILS CLOSED", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p13c-a4-")); gitInit(dir);
  await assert.rejects(() => createPhysicalSnapshot(dir, "0000000000000000000000000000000000000000"), /≠ expected verified tree|refusing to freeze/);
});

test("A5 (req 3): a non-git source produces NO physical snapshot (caller keeps the logical binding)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p13c-a5-")); // no git init
  assert.equal(await createPhysicalSnapshot(dir), undefined, "a non-git source is not physically frozen");
});

test("A6 [MUTATION 9] (req 36): cleanup removes the isolated worktree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p13c-a6-")); const tree = gitInit(dir);
  const snap = (await createPhysicalSnapshot(dir, tree))!;
  const p = snap.snapshotPath;
  assert.ok(existsSync(p));
  await snap.cleanup();
  assert.equal(existsSync(p), false, "the isolated worktree is cleaned up");
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part B — orchestrator seam: promotion binds the physical snapshot; integrity fails closed
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
const stubTrust = { recordOutcome: async (i: { agentId: string; defaultTrustTier: string }, _s: ValidatedIdentity): Promise<TrustDecision> => { const t = asTier(i.defaultTrustTier, TRUST_FLOOR); return { agentId: i.agentId, tier: t, previousTier: t, autonomy: autonomyForTier(t) }; } };
const cleanBuilder: RoleFn = async () => ({ role: "builder", outcome: "success", summary: "built", detail: { filesWritten: ["a.ts"], rejectedToolCalls: [], stopReason: "stop" } });
const greenVerifier: RoleFn = async () => ({ role: "verifier", outcome: "success", summary: "green", detail: { verdict: "pass", checks: [{ name: "test", command: "pnpm test", exitCode: 0, testCount: { passed: 1, total: 1 } }], testEvidence: "executed" } });
const passCritic: RoleFn = async () => ({ role: "critic", outcome: "success", summary: "c", detail: { pass: true } });
const promoteIntegrator: RoleFn = async () => ({ role: "integrator", outcome: "success", summary: "i", detail: { decision: "promote", rationale: "s", evaluation: { approved: true } } });
// INJECTED TEST FACT (adjudication seam): the STUB builder reports filesWritten but does not actually
// mutate the real git worktree, so the production computeWorkProduct would see an empty tree. Inject a
// tree-bound GREEN work product so the core promotes and the PHYSICAL-snapshot path (real git) is exercised.
// (Production always computes from real git; this stands in for the work the stub builder claims.)
const promotableWorkProduct: NonNullable<OrchestratorDeps["computeWorkProduct"]> = async () => ({ treeHash: "test-tree-green", diffStat: { filesChanged: 1, insertions: 1, deletions: 0 }, nonEmpty: true });
const find = (rs: Array<{ operation: string; metadata: Record<string, unknown> }>, op: string) => rs.find((r) => r.operation === op);

/** A real-git-backed run (default real readTreeHash ⇒ the physical snapshot path is active). */
function makeRun(over: { createPhysicalSnapshot?: OrchestratorDeps["createPhysicalSnapshot"] } = {}) {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const rc = capturingReceipts();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-p13c-run-"));
  gitInit(dir);
  const handle: WorkspaceHandle = { id: "wsp13c", targetRepo: dir, baseBranch: "main", baseRef: "HEAD", scratchBranch: "s", path: dir, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
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
    roles: { scout: async () => ({ role: "scout", outcome: "success", summary: "s" }), builder: cleanBuilder, verifier: greenVerifier, critic: passCritic, integrator: promoteIntegrator },
    invokeModel: async () => { throw new Error("unused"); }, governedExec: { run: async () => ({ executed: true as const, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) }, builderModel: "deepseek-v4-flash",
    gateWall: { evaluate: async (): Promise<PromoteGovernance> => ({ allow: true, reason: "ok" }) },
    computeWorkProduct: promotableWorkProduct,
    ...(over.createPhysicalSnapshot !== undefined ? { createPhysicalSnapshot: over.createPhysicalSnapshot } : {}),
  });
  return { run: () => orch.run({ taskId: "t13c", targetRepo: dir, goal: "do the thing" }, parentCtx), receipts: rc.appended };
}

test("B1 [MUTATION 4] (req 6,7,8,13,15): a git-backed promote binds the PHYSICALLY-ISOLATED snapshot on the receipt", async () => {
  const h = makeRun();
  const result = await h.run();
  assert.equal(result.promoted, true);
  const promo = find(h.receipts, "worker.promotion")!;
  assert.equal(promo.metadata.snapshotKind, "physical-isolated", "the promoted subject is the physical snapshot, not the mutable source");
  assert.equal(typeof promo.metadata.snapshotPath, "string", "the isolated snapshot path is bound");
  assert.notEqual(promo.metadata.snapshotPath, undefined);
  assert.equal(promo.metadata.snapshotImmutable, true);
  assert.equal(promo.metadata.snapshotDigest, promo.metadata.verifiedTree, "the frozen subject digest == the verified tree the CAS confirms");
});

test("B2 [MUTATION 10] (req 16,17,30,31): a physical-snapshot integrity failure FAILS CLOSED (no promote, no success trust)", async () => {
  const h = makeRun({ createPhysicalSnapshot: async () => { throw new Error("read-only enforcement failed"); } });
  const result = await h.run();
  assert.notEqual(result.outcome, "success");
  assert.equal(result.promoted, false, "a candidate that cannot be physically frozen is not promoted");
  assert.ok(find(h.receipts, "worker.promotion.snapshot_integrity_error") !== undefined, "the integrity failure is recorded");
  assert.ok(find(h.receipts, "worker.promotion")?.metadata.promoted !== true);
});

test("B3 (req 3): a non-git candidate keeps the LOGICAL binding (no physical snapshot required)", async () => {
  // An injected snapshotter returning undefined (non-git) ⇒ the logical Phase 13B binding stands + promotes.
  const h = makeRun({ createPhysicalSnapshot: async () => undefined });
  const result = await h.run();
  assert.equal(result.promoted, true);
  const promo = find(h.receipts, "worker.promotion")!;
  assert.equal(promo.metadata.snapshotKind, "logical", "a candidate without a physical snapshot promotes under the logical binding");
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part C — cooperative abort reaches the builder tool loop (req 28)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test("C1 [MUTATION 7] (req 28,33): an ABORTED ctx.signal stops the builder tool loop before scheduling tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p13c-c1-"));
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  const controller = new AbortController();
  controller.abort(); // already aborted (as if the role timed out)
  let modelCalls = 0;
  const ctx: RoleContext = {
    task: { taskId: "t", targetRepo: dir, goal: "do a thing" },
    role: "builder", identity: { agentId: "worker-1", functionalRole: "worker", trustTier: "trusted" }, autonomy: autonomyForTier("trusted"),
    workspace: { id: "ws", targetRepo: dir, baseBranch: "main", baseRef: "H", scratchBranch: "s", path: dir, identity: { agentId: "worker-1" }, state: "allocated", createdAt: 0 },
    priorResults: [],
    engine: { invokeModel: async () => { modelCalls += 1; return { contractVersion: "1.1.0", model: "m", provider: "p", providerModelId: "m", content: "", finishReason: "tool_calls", toolCalls: [{ id: "w", name: "write_file", arguments: JSON.stringify({ path: "a.ts", content: "mutated" }) }], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } }, latencyMs: 1, fellBack: false, attempts: [] }; }, neutralizeUntrusted: (c, x) => coreNeutralize(c, x) },
    signal: controller.signal,
  };
  const builder = createBuilder({ governedExec: { run: async () => ({ executed: true as const, exitCode: 0, stdoutTail: "", stderrTail: "" }) } });
  const result = await builder(ctx);
  assert.equal((result.detail as Record<string, unknown>).stopReason, "aborted", "the builder loop broke on the aborted signal");
  assert.equal(modelCalls, 0, "no tools were scheduled after abort (the loop stopped before invoking the model)");
  // The candidate file was NOT mutated by the aborted builder.
  assert.equal(readFileSync(join(dir, "a.ts"), "utf8"), "export const a = 1;\n", "an aborted builder did not write to the candidate");
});

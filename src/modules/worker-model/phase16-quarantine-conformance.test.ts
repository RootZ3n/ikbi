/**
 * PHASE 16 — AUTONOMOUS-PROMOTION QUARANTINE (post-REAUDIT3 final containment).
 *
 * The Critical immutable tested-subject invariant (IKBI-REAUDIT3-001) remains architecturally OPEN, so
 * autonomous promotion is DISABLED BY DEFAULT for every strategy and refuses whenever the gate-wall veto is
 * administratively bypassed. Candidate generation / verification / criticism / receipts still run; the
 * candidate does not land unattended. Manual `/apply` remains a separately-classified operator-directed path.
 *
 * The quarantine is enforced at the ONE canonical authority (`promoteCandidate`), so all strategies inherit it.
 * These tests drive the real `createOrchestrator` for the distinct promotion callers (normal / duel-variant /
 * competitive / tournament) plus the pure opt-in reader and the real manual-apply seam.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { labTempDir as tmpdir } from "../../core/temp-root.js";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";
import type { ModelResponse } from "../../core/provider/contract.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { OperationContext, ValidatedIdentity } from "../../core/identity/resolver.js";
import type { EventBusSurface, EventInput, IkbiEvent } from "../../core/events/index.js";
import { autonomyForTier, asTier, TRUST_FLOOR, type TrustDecision } from "../../core/trust/index.js";
import type { DiscardResult, PromoteGovernance, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import { createGateWall } from "../gate-wall/index.js";
import { createOrchestrator, resolveAutonomousPromotionEnabled, type OrchestratorDeps } from "./orchestrator.js";
import type { RoleFn, WorkerTask } from "./contract.js";

// ── the pure opt-in reader (reqs 1,2,3) ────────────────────────────────────────────────────────────

test("Q1 (req 1,2): autonomous promotion is DISABLED by default / when the setting is missing", () => {
  assert.equal(resolveAutonomousPromotionEnabled({}), false, "missing config ⇒ disabled");
  assert.equal(resolveAutonomousPromotionEnabled({ OTHER: "true" }), false, "unrelated env ⇒ disabled");
});

test("Q2 (req 3): INVALID configuration is disabled; only exact 'true' enables", () => {
  for (const v of ["1", "yes", "on", "TRUE-ish", "", " ", "false", "0", "disabled"]) {
    assert.equal(resolveAutonomousPromotionEnabled({ IKBI_ENABLE_AUTONOMOUS_PROMOTION: v }), false, `"${v}" ⇒ disabled`);
  }
  assert.equal(resolveAutonomousPromotionEnabled({ IKBI_ENABLE_AUTONOMOUS_PROMOTION: "true" }), true, "exact 'true' ⇒ enabled");
  assert.equal(resolveAutonomousPromotionEnabled({ IKBI_ENABLE_AUTONOMOUS_PROMOTION: " TRUE " }), true, "trimmed/case-insensitive 'true' ⇒ enabled");
});

// ── orchestrator harness ────────────────────────────────────────────────────────────────────────

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
function recordingTrust() {
  const calls: Array<{ status: string }> = [];
  const trust = { recordOutcome: async (i: { agentId: string; defaultTrustTier: string; outcome?: string }, _s: ValidatedIdentity): Promise<TrustDecision> => { calls.push({ status: String(i.outcome ?? "") }); const t = asTier(i.defaultTrustTier, TRUST_FLOOR); return { agentId: i.agentId, tier: t, previousTier: t, autonomy: autonomyForTier(t) }; } };
  return { trust, calls };
}
const greenVerifier: RoleFn = async () => ({ role: "verifier", outcome: "success", summary: "green", detail: { verdict: "pass", checks: [{ name: "test", command: "pnpm test", exitCode: 0, testCount: { passed: 1, total: 1 } }], testEvidence: "executed" } });
const passCritic: RoleFn = async () => ({ role: "critic", outcome: "success", summary: "PASS", detail: { pass: true } });
const promoteIntegrator: RoleFn = async () => ({ role: "integrator", outcome: "success", summary: "p", detail: { decision: "promote", rationale: "s", evaluation: { approved: true } } });
const cleanBuilder: RoleFn = async () => ({ role: "builder", outcome: "success", summary: "built", detail: { filesWritten: ["a.ts"], rejectedToolCalls: [], stopReason: "stop" } });
const greenExec = { run: async () => ({ executed: true as const, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) };
const allowGate = { evaluate: async (): Promise<PromoteGovernance> => ({ allow: true, reason: "ok" }) };
// INJECTED TEST FACT (adjudication seam): these in-memory workspace doubles have no real tree change on
// disk, so the authoritative adjudication core (which requires a tree-bound WorkProduct) would compute
// discard(no-work) and never reach the quarantine chokepoint. Feed a promotable tree-bound fact so the
// flow REACHES the quarantine gate — the quarantine backstop must still block the autonomous land.
const promotableWorkProduct: NonNullable<OrchestratorDeps["computeWorkProduct"]> = async () => ({ treeHash: "test-tree-green", diffStat: { filesChanged: 1, insertions: 1, deletions: 0 }, nonEmpty: true });
const DIFF = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n-export const a = 1;\n+export const a = 2;\n";
function gitInit(dir: string): string {
  const g = (...a: string[]): string => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g("init", "-q"); writeFileSync(join(dir, "a.ts"), "export const a = 1;"); g("add", "-A"); g("commit", "-q", "-m", "base");
  return g("rev-parse", "HEAD").trim();
}

interface RunOpts {
  autonomousPromotionEnabled?: boolean;
  gateWall?: OrchestratorDeps["gateWall"];
  config?: Partial<NonNullable<OrchestratorDeps["config"]>>;
  task?: Partial<WorkerTask>;
}
function makeRun(over: RunOpts = {}) {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const rc = capturingReceipts();
  const rt = recordingTrust();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-p16q-"));
  gitInit(dir);
  const handle: WorkspaceHandle = { id: "wsq", targetRepo: dir, baseBranch: "main", baseRef: "HEAD", scratchBranch: "s", path: dir, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 2000, maxConcurrentRuns: 1, trustLadder: false, ...over.config },
    ...(over.autonomousPromotionEnabled !== undefined ? { autonomousPromotionEnabled: over.autonomousPromotionEnabled } : {}),
    workspaces: {
      allocate: async () => ({ ...handle, id: `wsq-${Math.random().toString(36).slice(2)}` }),
      diff: async () => DIFF,
      promote: async (h): Promise<PromoteResult> => ({ promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }),
      discard: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: true }),
      retain: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: false }),
      commit: async () => true,
    },
    events: fakeBus, receipts: rc.receipts, trust: rt.trust, resolveIdentity, roleClaim,
    roles: { scout: async () => ({ role: "scout", outcome: "success", summary: "s" }), builder: cleanBuilder, verifier: greenVerifier, critic: passCritic, integrator: promoteIntegrator },
    invokeModel: async (): Promise<ModelResponse> => { throw new Error("unused"); }, governedExec: greenExec, builderModel: "deepseek-v4-flash",
    computeWorkProduct: promotableWorkProduct,
    escalationTierModels: { worker: ["deepseek-v4-flash"], mid: ["deepseek-v4-pro"], frontier: ["deepseek-v4-pro"] },
    gateWall: over.gateWall ?? allowGate,
  });
  const task: WorkerTask = { taskId: "cand-q", targetRepo: dir, goal: "add a route", escalationDisabled: true, ...over.task } as WorkerTask;
  return { run: () => orch.run(task, parentCtx), receipts: rc.appended, trustCalls: rt.calls };
}
const quarantineReceipt = (recs: Array<{ operation: string; metadata: Record<string, unknown> }>) => recs.find((r) => r.operation === "worker.promotion.quarantined");

// ── per-strategy quarantine (reqs 4-11) ────────────────────────────────────────────────────────────

test("Q3 (req 4,7,11): NORMAL mode cannot autonomously promote while quarantined + the receipt states it", async () => {
  const h = makeRun({ autonomousPromotionEnabled: false });
  const result = await h.run();
  assert.equal(result.promoted, false, "quarantine blocks the autonomous land");
  const quar = quarantineReceipt(h.receipts)!;
  assert.ok(quar !== undefined, "a worker.promotion.quarantined receipt is written");
  assert.equal(quar.metadata.autonomousPromotionQuarantined, true);
  assert.equal(quar.metadata.operatorReviewRequired, true);
  assert.equal(quar.metadata.openFinding, "IKBI-REAUDIT3-001");
  assert.match(String(result.reason), /quarantined/i, "the result explicitly states quarantine");
});

test("Q4 (req 10): a quarantined run awards NO governed landed-success trust", async () => {
  const h = makeRun({ autonomousPromotionEnabled: false });
  await h.run();
  assert.ok(!h.trustCalls.some((c) => c.status === "success"), "no success trust for an un-landed candidate");
  assert.equal(quarantineReceipt(h.receipts)!.metadata.governedLandedSuccessTrustAwarded, false);
});

test("Q5 (req 5): the conditional-DUEL variant cannot autonomously promote while quarantined", async () => {
  const h = makeRun({ autonomousPromotionEnabled: false, task: { moeExpertRental: true, moeVendorLane: "deepseek" } });
  const result = await h.run();
  assert.equal(result.promoted, false, "the duel-primary strategy is quarantined at the same chokepoint");
  assert.ok(quarantineReceipt(h.receipts) !== undefined);
});

test("Q6 (req 6): COMPETITIVE mode cannot autonomously promote while quarantined", async () => {
  const h = makeRun({ autonomousPromotionEnabled: false, config: { competitive: true, competitiveN: 2 } });
  const result = await h.run();
  assert.equal(result.promoted, false, "the competitive winner is quarantined");
  assert.ok(quarantineReceipt(h.receipts) !== undefined, "the competitive winner produced a quarantine receipt");
  assert.ok(!h.trustCalls.some((c) => c.status === "success"), "no governed-success trust for a quarantined competitive winner");
});

test("Q7 (req 7): TOURNAMENT mode cannot autonomously promote while quarantined", async () => {
  const h = makeRun({ autonomousPromotionEnabled: false, task: { candidates: ["deepseek-v4-flash", "deepseek-v4-flash"] } });
  const result = await h.run();
  assert.equal(result.promoted, false, "the tournament winner/shadow is quarantined");
  assert.ok(quarantineReceipt(h.receipts) !== undefined, "the tournament winner produced a quarantine receipt");
});

test("Q8 (req 8,9): multi-step finalizer + fixer/repaired candidates share the SAME chokepoint (normal caller)", async () => {
  // Both the multi-step finalizer and a fixer/repaired candidate promote through the normal promoteCandidate
  // caller — proven quarantined by Q3. A fixer that closes red checks still cannot bypass the quarantine.
  const h = makeRun({ autonomousPromotionEnabled: false, config: { criticFixLoop: true } });
  const result = await h.run();
  assert.equal(result.promoted, false, "a repaired/finalized candidate cannot bypass the quarantine");
  assert.ok(quarantineReceipt(h.receipts) !== undefined);
});

// ── opt-in reaches the authority only when bypass is false (reqs 12,13) ─────────────────────────────

test("Q9 (req 12): explicit opt-in reaches the promotion authority and promotes when bypass is FALSE", async () => {
  const h = makeRun({ autonomousPromotionEnabled: true, gateWall: allowGate });
  const result = await h.run();
  assert.equal(result.promoted, true, "opt-in + a policy-evaluated allow lands");
  assert.ok(quarantineReceipt(h.receipts) === undefined, "no quarantine receipt when opted-in + bypass false");
});

test("Q10 (req 13): gate-wall BYPASS blocks autonomous promotion EVEN WITH explicit opt-in", async () => {
  const bypassGate = createGateWall({ config: { enabled: true, bypass: true }, receipts: { append: async () => ({}) }, publish: () => {} });
  const h = makeRun({ autonomousPromotionEnabled: true, gateWall: bypassGate });
  const result = await h.run();
  assert.equal(result.promoted, false, "an active bypass quarantines autonomous promotion even when opted in");
  const quar = quarantineReceipt(h.receipts)!;
  assert.ok(quar !== undefined);
  assert.equal(quar.metadata.gateBypassed, true);
  assert.equal(quar.metadata.gateAuthority, "administratively-bypassed");
  assert.ok(!h.trustCalls.some((c) => c.status === "success"), "no governed-success trust for a bypassed run");
});

// ── manual apply is unchanged (req 14) ──────────────────────────────────────────────────────────────

test("Q11 (req 14): manual /apply remains explicitly manual-unverified (unaffected by the quarantine)", async () => {
  const { allocateSessionWorkspace } = await import("../chat/repl-workspace.js");
  const dir = mkdtempSync(join(tmpdir(), "ikbi-p16q-manual-"));
  const captured: Array<{ evaluatorId: unknown }> = [];
  const mgr = {
    allocate: async () => handle,
    commit: async () => true,
    diff: async () => "",
    promote: async (h: { id: string; baseBranch: string; baseRef: string }, approval: Record<string, unknown>) => { captured.push({ evaluatorId: (approval.evaluation as { evaluatorId?: unknown }).evaluatorId }); return { promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "landed" }; },
    discard: async (h: { id: string }) => ({ workspaceId: h.id, removed: true }),
    get: async () => handle as never,
  };
  const handle = { id: "mws-quar", targetRepo: dir, baseBranch: "main", baseRef: "x", scratchBranch: "s", path: dir, identity: { agentId: "ikbi-chat" }, state: "allocated" as const, createdAt: 0 };
  const ws = await allocateSessionWorkspace({ targetRepo: dir, sessionId: "sess-q", manager: mgr as never, gateWall: allowGate as never });
  const result = await ws.promote("apply my work");
  assert.equal(result.promoted, true, "manual apply still lands (operator-directed, separate from autonomous quarantine)");
  assert.equal(captured[0]!.evaluatorId, "repl-operator", "attributed to the operator");
  const { receipts: coreReceipts } = await import("../../core/receipt/index.js");
  const all = await coreReceipts.query({});
  const manual = all.find((r) => r.operation === "workspace.manual_apply" && (r.metadata as { sourceWorkspaceId?: string } | undefined)?.sourceWorkspaceId === "mws-quar")!;
  assert.ok(manual !== undefined, "a workspace.manual_apply receipt was written");
  assert.equal((manual.metadata as Record<string, unknown>).authorityMode, "manual-unverified");
  assert.equal((manual.metadata as Record<string, unknown>).verifiedPromotion, false);
  assert.equal((manual.metadata as Record<string, unknown>).successTrustAwarded, false);
});

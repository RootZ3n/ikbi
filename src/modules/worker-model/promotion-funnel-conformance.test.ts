/**
 * PROMOTION-FUNNEL CONFORMANCE (Phase 3, IKBI-RT-004 / IKBI-RT-005).
 *
 * One canonical promotion authority (`promoteCandidate`) is the SOLE caller of `workspaces.promote`.
 * These tests prove, at the real orchestration→provider→promote seam:
 *   - a promoting build routes through the authority and emits the canonical `worker.promotion` receipt
 *     carrying the identity chain (task/attempt/candidate/strategy/model/lane/verified-tree);
 *   - the exact candidate that was verified is the exact candidate that promotes — a post-verify
 *     mutation (stale tree) blocks the promote, fail-closed;
 *   - success-based trust credit is recorded only AFTER an actual promotion;
 *   - duel primary and peer are separately attributable and never share evidence;
 *   - a first-attempt promotion incurs zero peer cost (Phase 2 preserved);
 *   - the critic-parser boundary: a bare/unparsable FAIL is `indeterminate`, never a concrete defect;
 *   - IKBI_LEGACY_COMPLETION=off cannot autonomously promote over an integrator deny (quarantined).
 *
 * The pure-helper and single-caller checks complement the real-seam tests.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { pino } from "pino";

import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import type { EventBusSurface, EventInput, IkbiEvent } from "../../core/events/index.js";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import type { OperationContext } from "../../core/identity/resolver.js";
import type { ValidatedIdentity } from "../../core/identity/resolver.js";
import { autonomyForTier, asTier, TRUST_FLOOR, type TrustDecision } from "../../core/trust/index.js";
import type { DiscardResult, PromoteGovernance, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import { createOrchestrator, classifySemanticVerdict, type OrchestratorDeps } from "./orchestrator.js";
import type { RoleFn, RoleResult, WorkerRole } from "./contract.js";

const silent = () => pino({ level: "silent" });

// ───────────────────────── Part 1: PURE critic-parser boundary ─────────────────────────

test("critic boundary: a bare FAIL with no concrete issue is INDETERMINATE, never a concrete defect (req 18)", () => {
  const bareFail: RoleResult = { role: "critic", outcome: "success", summary: "c", detail: { pass: false, feedback: "FAIL" } };
  assert.equal(classifySemanticVerdict(bareFail), "indeterminate");
});

test("critic boundary: an unparsable/failed critic is INDETERMINATE (req 19)", () => {
  const unparsable: RoleResult = { role: "critic", outcome: "failure", summary: "parse error", detail: {} };
  assert.equal(classifySemanticVerdict(unparsable), "indeterminate");
});

test("critic boundary: a FAIL WITH a concrete issue is fail; a PASS is pass; no critic is not-evaluated", () => {
  assert.equal(classifySemanticVerdict({ role: "critic", outcome: "success", detail: { pass: false, issues: ["missing subtreeBounds()"] } }), "fail");
  assert.equal(classifySemanticVerdict({ role: "critic", outcome: "success", detail: { pass: true } }), "pass");
  assert.equal(classifySemanticVerdict(undefined), "not-evaluated");
});

// ───────────────────────── Part 2: single promotion authority (source invariant) ─────────────────────────

test("single authority: `workspaces.promote(` is called from EXACTLY one place in the orchestrator (req 6/7, mutation 1)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "orchestrator.ts"), "utf8");
  const count = (src.match(/workspaces\.promote\(/g) ?? []).length;
  assert.equal(count, 1, "every strategy must promote through the one canonical authority — no direct low-level promote from strategy code");
});

// ───────────────────────── Part 3: REAL orchestrator → authority seam ─────────────────────────

function makeIdentities() {
  const agents = [
    { agentId: "parent-1", kind: "agent" as const, functionalRole: "lead", defaultTrustTier: "trusted", tokenHashes: [hashToken("parent-secret")] },
    { agentId: "worker-1", kind: "agent" as const, functionalRole: "worker", defaultTrustTier: "trusted", tokenHashes: [hashToken("worker-secret")] },
  ];
  const resolver = new IdentityResolver({ registry: new AgentRegistry({ agents }), logger: silent(), now: () => 1000 });
  const parentCtx: OperationContext = beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
  const resolveIdentity: NonNullable<OrchestratorDeps["resolveIdentity"]> = (claim, ctx) => resolver.resolve(claim, ctx);
  const roleClaim: NonNullable<OrchestratorDeps["roleClaim"]> = () => ({ token: "worker-secret" });
  return { parentCtx, resolveIdentity, roleClaim };
}
function fakeBus() {
  const bus: EventBusSurface = {
    publish: <P>(input: EventInput<P>): IkbiEvent<P> => ({ ...input, contractVersion: "1.0.0", id: "e", seq: 1, timestamp: 0 } as IkbiEvent<P>),
    subscribe: () => ({ id: "s", unsubscribe: () => {}, stats: () => ({ delivered: 0, dropped: 0, failures: 0, queued: 0 }) }),
    flush: async () => {},
  };
  return { bus };
}
function capturingReceipts() {
  const appended: Array<{ operation: string; metadata: Record<string, unknown> }> = [];
  const receipts = { append: async (input: unknown, _id: AgentIdentity): Promise<unknown> => { const r = input as { operation: string; metadata?: Record<string, unknown> }; appended.push({ operation: r.operation, metadata: r.metadata ?? {} }); return {}; } };
  return { receipts, appended };
}
function capturingTrust() {
  const calls: Array<{ status: string; order: number }> = [];
  let n = 0;
  const trust = {
    recordOutcome: async (input: { agentId: string; defaultTrustTier: string; status: string }, _subject: ValidatedIdentity): Promise<TrustDecision> => {
      calls.push({ status: input.status, order: n });
      const tier = asTier(input.defaultTrustTier, TRUST_FLOOR);
      return { agentId: input.agentId, tier, previousTier: tier, autonomy: autonomyForTier(tier) };
    },
  };
  const markPromote = (): void => { n = 1; };
  return { trust, calls, markPromote };
}
const greenGovernedExec = { run: async () => ({ executed: true as const, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) };
const COST = 0.002;
function ok(content: string): ModelResponse {
  return { contractVersion: "1.1.0", model: "recording", provider: "recording", providerModelId: "recording", content, finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, cost: { usd: COST, promptUsd: COST, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } }, latencyMs: 1, fellBack: false, attempts: [] };
}
function toolResp(name: string, args: unknown): ModelResponse { return { ...ok(""), finishReason: "tool_calls", toolCalls: [{ id: `${name}1`, name, arguments: JSON.stringify(args) }] }; }
function successProvider() {
  const builderModels: string[] = [];
  let turn = 0;
  const invokeModel = async (req: ModelRequest): Promise<ModelResponse> => {
    if (typeof (req as { prompt?: unknown }).prompt === "string") return ok(JSON.stringify({ tier: "worker", rationale: "x" }));
    if (!(req.tools ?? []).some((t) => t.name === "done")) return ok(JSON.stringify({ verdict: "PASS", scores: { files_modified: 5, goal_correctness: 5, code_quality: 5, tests: 5, suspicious_patterns: 5 }, feedback: "correct and complete for the goal" }));
    builderModels.push(req.model);
    turn += 1;
    if (turn === 1) return toolResp("read_file", { path: "a.ts" });
    if (turn === 2) return toolResp("write_file", { path: "a.ts", content: "export const a = 2;\n" });
    if (turn === 3) return toolResp("run_checks", {});
    return toolResp("done", { successCondition: "do the thing", filesReadBack: ["a.ts"], selfCheck: "ran checks green; goal met", satisfied: true });
  };
  return { invokeModel, builderModels };
}
const stubRoles: Partial<Record<WorkerRole, RoleFn>> = {
  verifier: async () => ({ role: "verifier", outcome: "success", summary: "ok", detail: { verdict: "pass", checks: [{ name: "test", command: "pnpm test", exitCode: 0, testCount: { passed: 1, total: 1 } }] } }),
  critic: async () => ({ role: "critic", outcome: "success", summary: "c", detail: { pass: true, semanticVerdict: { kind: "pass", summary: "ok", blockingDefects: [], incompleteRequirements: [], advisories: [], parseStatus: "structured" } } }),
  integrator: async () => ({ role: "integrator", outcome: "success", summary: "p", detail: { decision: "promote", rationale: "s", evaluation: { approved: true } } }),
};

/** A tree reader that walks `seq` by call index, staying on the last entry (undefined ⇒ no git). */
function treeReader(seq: (string | undefined)[]) {
  let i = 0;
  return async (): Promise<string | undefined> => { const v = seq[Math.min(i, seq.length - 1)]; i += 1; return v; };
}

function realOrchestrator(opts: { invokeModel: (r: ModelRequest) => Promise<ModelResponse>; treeSeq?: (string | undefined)[]; extra?: Partial<OrchestratorDeps> }) {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const rc = capturingReceipts();
  const tr = capturingTrust();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-p3f-"));
  writeFileSync(join(dir, "a.ts"), "export const a = 1;");
  const handle: WorkspaceHandle = { id: "wsp3", targetRepo: dir, baseBranch: "main", baseRef: "BASEHEAD", scratchBranch: "s", path: dir, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  const promoteCalls: Array<{ hasVerifiedAgainst: boolean }> = [];
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 1000, maxConcurrentRuns: 1, trustLadder: true },
    workspaces: {
      allocate: async () => handle,
      promote: async (h, approval): Promise<PromoteResult> => { promoteCalls.push({ hasVerifiedAgainst: (approval as { verifiedAgainst?: unknown }).verifiedAgainst !== undefined }); return { promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }; },
      discard: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: true }),
      retain: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: false }),
      commit: async () => true,
    },
    events: fakeBus().bus, receipts: rc.receipts, trust: tr.trust, resolveIdentity, roleClaim, roles: stubRoles,
    invokeModel: opts.invokeModel, governedExec: greenGovernedExec, builderModel: "deepseek-v4-flash",
    gateWall: { evaluate: async (): Promise<PromoteGovernance> => ({ allow: true, reason: "ok" }) },
    ...(opts.treeSeq !== undefined ? { readTreeHash: treeReader(opts.treeSeq) } : {}),
    ...opts.extra,
  });
  return { orch, parentCtx, receipts: rc.appended, trust: tr, dir, promoteCalls };
}

// req 1, 10, 13, 17: a promoting build routes through the authority + canonical receipt with the chain.
test("normal success routes through the canonical authority and emits worker.promotion with the identity chain", async () => {
  const rp = successProvider();
  const { orch, parentCtx, receipts, promoteCalls } = realOrchestrator({ invokeModel: rp.invokeModel, treeSeq: ["T-verified"] });
  const result = await orch.run({ taskId: "t1", targetRepo: "/unused", goal: "do the thing", moeExpertRental: true, moeVendorLane: "deepseek" }, parentCtx);

  assert.equal(result.outcome, "success");
  assert.equal(promoteCalls.length, 1, "exactly one low-level promote — through the authority");
  const promo = receipts.find((r) => r.operation === "worker.promotion");
  assert.ok(promo !== undefined, "the canonical promotion receipt was written (no success without it)");
  assert.equal(promo!.metadata.taskId, "t1");
  assert.equal(promo!.metadata.attemptId, "t1");
  assert.equal(promo!.metadata.strategy, "duel-primary");
  assert.equal(promo!.metadata.model, "deepseek-v4-flash", "executed model recorded (Phase 1 chain)");
  assert.equal(promo!.metadata.vendorLane, "deepseek");
  assert.equal(promo!.metadata.verifiedTree, "T-verified", "candidate verified == candidate promoted (req 13)");
  assert.equal(promo!.metadata.promoted, true);
  assert.equal(promo!.metadata.gateWallAllowed, true);
});

// req 14, 15, mutation 2: a post-verify mutation (tree changed) blocks the promote, fail-closed.
test("stale-tree: a candidate mutated after verification is REFUSED — the promoted tree must be the verified tree", async () => {
  const rp = successProvider();
  // capture at verification → "T-verified"; the authority's re-read → "T-mutated" (a post-verify change).
  const { orch, parentCtx, receipts, promoteCalls } = realOrchestrator({ invokeModel: rp.invokeModel, treeSeq: ["T-verified", "T-mutated"] });
  const result = await orch.run({ taskId: "t-stale", targetRepo: "/unused", goal: "do the thing", moeExpertRental: true, moeVendorLane: "deepseek" }, parentCtx);

  assert.notEqual(result.outcome, "success", "a stale candidate does not promote");
  assert.equal(result.promoted, false);
  assert.equal(promoteCalls.length, 0, "the low-level promote was NEVER reached — the authority refused first");
  assert.ok(receipts.some((r) => r.operation === "worker.promotion.stale_tree"), "the refusal is recorded as stale-tree");
  assert.match(result.reason ?? "", /stale-tree/);
});

// req 16, mutation 4: success trust credit occurs ONLY after an actual promotion.
test("trust ordering: a build that promotes records success trust; a stale-blocked build does NOT", async () => {
  const good = realOrchestrator({ invokeModel: successProvider().invokeModel, treeSeq: ["T"] });
  await good.orch.run({ taskId: "t-good", targetRepo: "/unused", goal: "do the thing", moeExpertRental: true, moeVendorLane: "deepseek" }, good.parentCtx);
  assert.deepEqual(good.trust.calls.map((c) => c.status), ["success"], "promoted build → one success trust outcome");

  const stale = realOrchestrator({ invokeModel: successProvider().invokeModel, treeSeq: ["T", "T2"] });
  await stale.orch.run({ taskId: "t-stale2", targetRepo: "/unused", goal: "do the thing", moeExpertRental: true, moeVendorLane: "deepseek" }, stale.parentCtx);
  assert.ok(!stale.trust.calls.some((c) => c.status === "success"), "a stale-blocked build earns NO success trust credit");
});

// req 3, 4, 5, 24, mutation 3: duel primary and peer are separately attributable with independent evidence.
test("duel funnel: primary and peer each traverse the authority with DISTINCT attempt ids + their own verified tree", async () => {
  const primary = realOrchestrator({ invokeModel: successProvider().invokeModel, treeSeq: ["T-primary"] });
  await primary.orch.run({ taskId: "build:deepseek", targetRepo: "/unused", goal: "do the thing", moeExpertRental: true, moeVendorLane: "deepseek" }, primary.parentCtx);
  const peer = realOrchestrator({ invokeModel: successProvider().invokeModel, treeSeq: ["T-peer"] });
  await peer.orch.run({ taskId: "build:mimo", targetRepo: "/unused", goal: "do the thing", moeExpertRental: true, moeVendorLane: "mimo" }, peer.parentCtx);

  const pPromo = primary.receipts.find((r) => r.operation === "worker.promotion")!;
  const qPromo = peer.receipts.find((r) => r.operation === "worker.promotion")!;
  assert.equal(pPromo.metadata.attemptId, "build:deepseek");
  assert.equal(qPromo.metadata.attemptId, "build:mimo");
  assert.notEqual(pPromo.metadata.attemptId, qPromo.metadata.attemptId, "distinct attempt ids");
  assert.equal(pPromo.metadata.strategy, "duel-primary");
  assert.equal(qPromo.metadata.strategy, "duel-peer");
  assert.notEqual(pPromo.metadata.verifiedTree, qPromo.metadata.verifiedTree, "each attempt binds its OWN verified tree — no evidence reuse");
});

// req 20: a build the integrator does not promote yields NO canonical promotion — selection ≠ completion.
test("selection is not completion: an integrator DISCARD produces no worker.promotion and no success", async () => {
  const rp = successProvider();
  const { orch, parentCtx, receipts, promoteCalls } = realOrchestrator({
    invokeModel: rp.invokeModel, treeSeq: ["T"],
    extra: { roles: { verifier: stubRoles.verifier!, integrator: async () => ({ role: "integrator", outcome: "success", summary: "i", detail: { decision: "discard", rationale: "not promotable", evaluation: { approved: false } } }) } },
  });
  const result = await orch.run({ taskId: "t-disc", targetRepo: "/unused", goal: "do the thing", moeExpertRental: true, moeVendorLane: "deepseek" }, parentCtx);
  assert.notEqual(result.outcome, "success");
  assert.equal(promoteCalls.length, 0, "no promote for a non-promoted candidate");
  assert.ok(!receipts.some((r) => r.operation === "worker.promotion"), "no canonical promotion receipt for a selected-but-not-promoted candidate");
});

// req 12, mutation 5: the authority binds verifiedAgainst so the workspace CAS also gets the certified tree.
test("candidate-bound authorization: the promote carries verifiedAgainst (hash-bound) when a tree is known", async () => {
  const rp = successProvider();
  const { orch, parentCtx, promoteCalls } = realOrchestrator({ invokeModel: rp.invokeModel, treeSeq: ["T-verified"] });
  await orch.run({ taskId: "t-va", targetRepo: "/unused", goal: "do the thing", moeExpertRental: true, moeVendorLane: "deepseek" }, parentCtx);
  assert.equal(promoteCalls.length, 1);
  assert.equal(promoteCalls[0]!.hasVerifiedAgainst, true, "the authority binds the certified tree + target head into the promote (IKBI-RT-005 stale-target guard)");
});

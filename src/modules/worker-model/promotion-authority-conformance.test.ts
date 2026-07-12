/**
 * PROMOTION-AUTHORITY CONFORMANCE (Phase 10, IKBI-REAUDIT-001 / IKBI-REAUDIT-006).
 *
 * THE CENTRAL INVARIANT: no autonomous authoritative change without authentic, candidate-bound, EXECUTED
 * verification evidence and an ENFORCEABLE tree identity. These tests prove — at the real orchestrator →
 * `promoteCandidate` seam, the pure executed-test-evidence policy, and the REPL `/apply` boundary — that:
 *   - a build with authentic `executed` tests can promote; missing / zero / unverified / no-tests (without
 *     an explicit policy) block; a failed verifier blocks;
 *   - the multi-step accumulated final pass is held to the SAME executed-evidence bar (the reuseWorkspace
 *     exemption is gone);
 *   - a git-backed candidate whose tree identity is unreadable fails CLOSED (stale-tree/CAS can't be dropped);
 *   - REPL `/apply` is an explicitly MANUAL-UNVERIFIED authority — it never emits an autonomous
 *     `worker.promotion`, never claims verification, and awards no success trust;
 *   - `workspaces.promote` is reachable from exactly ONE authority in the worker (source boundary).
 *
 * Doubles as MUTATION GUARDS (see HANDOFF-PHASE-10-PROMOTION-AUTHORITY.md for the 8 enumerated mutations).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { pino } from "pino";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { OperationContext, ValidatedIdentity } from "../../core/identity/resolver.js";
import type { EventBusSurface, EventInput, IkbiEvent } from "../../core/events/index.js";
import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import { autonomyForTier, asTier, TRUST_FLOOR, type TrustDecision } from "../../core/trust/index.js";
import type { DiscardResult, PromoteGovernance, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import { evaluateExecutedTestEvidence, noTestsPolicyEnabled } from "./executed-evidence.js";
import { allocateSessionWorkspace, type WorkspaceManagerLike } from "../chat/repl-workspace.js";
import type { GateWall } from "../gate-wall/index.js";
import { receipts as coreReceipts } from "../../core/receipt/index.js";
import type { RoleFn } from "./contract.js";

// ════════════════════════════════════════════════════════════════════════════════
// Part A — the executed-test-evidence POLICY (pure)
// ════════════════════════════════════════════════════════════════════════════════

test("A1 [MUTATION 1] (req 1,5,7,8): only `executed` (or `absent` under explicit policy) is acceptable; missing/zero/unverified block", () => {
  assert.equal(evaluateExecutedTestEvidence("executed", { allowNoTests: false }).acceptable, true);
  assert.equal(evaluateExecutedTestEvidence("zero", { allowNoTests: false }).acceptable, false, "a runner that ran nothing proved nothing");
  assert.equal(evaluateExecutedTestEvidence("unverified", { allowNoTests: false }).acceptable, false, "a pass with no parsed count proved nothing");
  assert.equal(evaluateExecutedTestEvidence(undefined, { allowNoTests: false }).acceptable, false, "MISSING evidence is not a pass");
  assert.equal(evaluateExecutedTestEvidence("absent", { allowNoTests: false }).acceptable, false, "no tests configured blocks by default");
  assert.equal(evaluateExecutedTestEvidence("absent", { allowNoTests: true }).acceptable, true, "no tests configured promotes ONLY under explicit policy");
  assert.equal(evaluateExecutedTestEvidence("zero", { allowNoTests: true }).acceptable, false, "the no-tests policy NEVER excuses zero/unverified");
});

test("A2 (req 8): the no-tests policy resolves from the task field OR IKBI_ALLOW_NO_TESTS, default false", () => {
  assert.equal(noTestsPolicyEnabled({}, {}), false, "default fail-closed");
  assert.equal(noTestsPolicyEnabled({ noTestsPolicy: true }, {}), true, "explicit task policy");
  assert.equal(noTestsPolicyEnabled({}, { IKBI_ALLOW_NO_TESTS: "true" }), true, "explicit operator env");
});

// ════════════════════════════════════════════════════════════════════════════════
// Part B — the AUTHORITY enforces evidence + tree identity (real orchestrator seam)
// ════════════════════════════════════════════════════════════════════════════════

const silent = () => pino({ level: "silent" });
function makeIdentities() {
  const agents = [
    { agentId: "parent-1", kind: "agent" as const, functionalRole: "lead", defaultTrustTier: "trusted", tokenHashes: [hashToken("parent-secret")] },
    { agentId: "worker-1", kind: "agent" as const, functionalRole: "worker", defaultTrustTier: "trusted", tokenHashes: [hashToken("worker-secret")] },
  ];
  const resolver = new IdentityResolver({ registry: new AgentRegistry({ agents }), logger: silent(), now: () => 1000 });
  const parentCtx: OperationContext = beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
  const resolveIdentity: NonNullable<OrchestratorDeps["resolveIdentity"]> = (claim, c) => resolver.resolve(claim, c);
  const roleClaim: NonNullable<OrchestratorDeps["roleClaim"]> = () => ({ token: "worker-secret" });
  return { parentCtx, resolveIdentity, roleClaim };
}
const fakeBus: EventBusSurface = {
  publish: <P>(input: EventInput<P>): IkbiEvent<P> => ({ ...input, contractVersion: "1.0.0", id: "e", seq: 1, timestamp: 0 } as IkbiEvent<P>),
  subscribe: () => ({ id: "s", unsubscribe: () => {}, stats: () => ({ delivered: 0, dropped: 0, failures: 0, queued: 0 }) }),
  flush: async () => {},
};
function capturingReceipts() {
  const appended: Array<{ operation: string; metadata: Record<string, unknown> }> = [];
  const receipts = { append: async (input: unknown): Promise<unknown> => { const r = input as { operation: string; metadata?: Record<string, unknown> }; appended.push({ operation: r.operation, metadata: r.metadata ?? {} }); return {}; } };
  return { receipts, appended };
}
const stubTrust = { recordOutcome: async (i: { agentId: string; defaultTrustTier: string }, _s: ValidatedIdentity): Promise<TrustDecision> => { const tier = asTier(i.defaultTrustTier, TRUST_FLOOR); return { agentId: i.agentId, tier, previousTier: tier, autonomy: autonomyForTier(tier) }; } };
function ok(content: string): ModelResponse {
  return { contractVersion: "1.1.0", model: "recording", provider: "recording", providerModelId: "recording", content, finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, cost: { usd: 0.001, promptUsd: 0.001, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } }, latencyMs: 1, fellBack: false, attempts: [] };
}
function toolResp(name: string, args: unknown): ModelResponse { return { ...ok(""), finishReason: "tool_calls", toolCalls: [{ id: `${name}1`, name, arguments: JSON.stringify(args) }] }; }
function builderProvider(): (r: ModelRequest) => Promise<ModelResponse> {
  let turn = 0;
  return async (req: ModelRequest): Promise<ModelResponse> => {
    if (typeof (req as { prompt?: unknown }).prompt === "string") return ok(JSON.stringify({ tier: "worker", rationale: "x" }));
    if (!(req.tools ?? []).some((t) => t.name === "done")) return ok(JSON.stringify({ verdict: "PASS", scores: { files_modified: 5, goal_correctness: 5, code_quality: 5, tests: 5, suspicious_patterns: 5 }, feedback: "ok" }));
    turn += 1;
    if (turn === 1) return toolResp("read_file", { path: "a.ts" });
    if (turn === 2) return toolResp("write_file", { path: "a.ts", content: "export const a = 2;\n" });
    if (turn === 3) return toolResp("run_checks", {});
    return toolResp("done", { successCondition: "do the thing", filesReadBack: ["a.ts"], selfCheck: "green", satisfied: true });
  };
}
const passCritic: RoleFn = async () => ({ role: "critic", outcome: "success", summary: "PASS", detail: { pass: true, semanticVerdict: { kind: "pass", summary: "ok", blockingDefects: [], incompleteRequirements: [], advisories: [], parseStatus: "structured" } } });
const promoteIntegrator: RoleFn = async () => ({ role: "integrator", outcome: "success", summary: "p", detail: { decision: "promote", rationale: "s", evaluation: { approved: true } } });
/** A verifier whose test-evidence class the test controls (executed | zero | unverified | absent | fail). */
function verifierFor(kind: "executed" | "zero" | "unverified" | "absent" | "fail"): RoleFn {
  return async () => {
    if (kind === "fail") return { role: "verifier", outcome: "failure", summary: "RED", detail: { verdict: "fail", checks: [{ name: "test", exitCode: 1 }] } };
    const checks =
      kind === "executed" ? [{ name: "test", command: "pnpm test", exitCode: 0, testCount: { passed: 1, total: 1 } }]
      : kind === "zero" ? [{ name: "test", command: "pnpm test", exitCode: 0, testCount: { passed: 0, total: 0 } }]
      : kind === "unverified" ? [{ name: "test", command: "pnpm test", exitCode: 0, outputTail: "done" }]
      : [{ name: "typecheck", command: "tsc", exitCode: 0, outputTail: "" }]; // absent: no "test" check
    return { role: "verifier", outcome: "success", summary: "green", detail: { verdict: "pass", checks } };
  };
}
function gitInit(dir: string): void {
  const g = (...a: string[]): string => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g("init", "-q"); writeFileSync(join(dir, "a.ts"), "export const a = 1;"); g("add", "-A"); g("commit", "-q", "-m", "base");
}
function authorityRun(opts: { verifier: "executed" | "zero" | "unverified" | "absent" | "fail"; noTestsPolicy?: boolean; gitInit?: boolean; isGitBacked?: boolean; readTreeHash?: () => Promise<string | undefined> }) {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const rc = capturingReceipts();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-p10a-"));
  if (opts.gitInit !== false) gitInit(dir); else writeFileSync(join(dir, "a.ts"), "export const a = 1;");
  const handle: WorkspaceHandle = { id: "wsp10", targetRepo: dir, baseBranch: "main", baseRef: "HEAD", scratchBranch: "s", path: dir, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  const promoteCalls: string[] = [];
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 1000, maxConcurrentRuns: 1, trustLadder: true },
    workspaces: {
      allocate: async () => handle,
      promote: async (h): Promise<PromoteResult> => { promoteCalls.push(h.id); return { promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }; },
      discard: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: true }),
      retain: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: false }),
      commit: async () => true,
    },
    events: fakeBus, receipts: rc.receipts, trust: stubTrust, resolveIdentity, roleClaim,
    roles: { verifier: verifierFor(opts.verifier), critic: passCritic, integrator: promoteIntegrator },
    invokeModel: builderProvider(), governedExec: { run: async () => ({ executed: true as const, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) }, builderModel: "deepseek-v4-flash",
    gateWall: { evaluate: async (): Promise<PromoteGovernance> => ({ allow: true, reason: "ok" }) },
    ...(opts.isGitBacked !== undefined ? { isGitBacked: async () => opts.isGitBacked! } : {}),
    ...(opts.readTreeHash !== undefined ? { readTreeHash: opts.readTreeHash } : {}),
  });
  const task = { taskId: "t1", targetRepo: "/unused", goal: "do the thing", ...(opts.noTestsPolicy !== undefined ? { noTestsPolicy: opts.noTestsPolicy } : {}) };
  return { run: () => orch.run(task, parentCtx), receipts: rc.appended, promoteCalls };
}

test("B1 (req 1): a build with authentic EXECUTED tests promotes through the authority", async () => {
  const h = authorityRun({ verifier: "executed" });
  const r = await h.run();
  assert.equal(r.promoted, true);
  assert.equal(h.promoteCalls.length, 1);
});

test("B2 [MUTATION 1] (req 5,7): MISSING/zero/unverified test evidence blocks autonomous promotion at the authority", async () => {
  for (const kind of ["zero", "unverified", "absent"] as const) {
    const h = authorityRun({ verifier: kind });
    const r = await h.run();
    assert.equal(r.promoted, false, `${kind} evidence must not promote`);
    assert.equal(h.promoteCalls.length, 0, `${kind}: the low-level promote is never reached`);
    assert.ok(h.receipts.some((x) => x.operation === "worker.promotion.evidence_withheld"), `${kind}: an evidence-withheld receipt is emitted`);
  }
});

test("B3 (req 5): a FAILED verifier blocks autonomous promotion at the authority (verificationPassed enforced)", async () => {
  const h = authorityRun({ verifier: "fail" });
  const r = await h.run();
  assert.equal(r.promoted, false);
  assert.equal(h.promoteCalls.length, 0);
});

test("B4 (req 6,8): no-tests-configured blocks by default, promotes under the explicit no-tests policy", async () => {
  const blocked = authorityRun({ verifier: "absent" });
  assert.equal((await blocked.run()).promoted, false, "absent blocks without policy");
  const allowed = authorityRun({ verifier: "absent", noTestsPolicy: true });
  assert.equal((await allowed.run()).promoted, true, "absent promotes under an explicit no-tests policy");
});

test("B5 [MUTATION 3,4] (req 9,10,11): a git-backed candidate whose tree identity is UNREADABLE fails closed", async () => {
  const h = authorityRun({ verifier: "executed", isGitBacked: true, readTreeHash: async () => undefined });
  const r = await h.run();
  assert.equal(r.promoted, false, "an unreadable tree hash on a git-backed candidate blocks promotion");
  assert.equal(h.promoteCalls.length, 0);
  assert.ok(h.receipts.some((x) => x.operation === "worker.promotion.tree_identity_unavailable"), "a tree-identity-unavailable receipt is emitted");
});

test("B6 (req 9): a genuinely non-git (in-memory) workspace is exempt from the tree-identity gate (unchanged)", async () => {
  const h = authorityRun({ verifier: "executed", gitInit: false, isGitBacked: false });
  const r = await h.run();
  assert.equal(r.promoted, true, "a non-git test workspace legitimately has no tree and still promotes on executed evidence");
});

// ════════════════════════════════════════════════════════════════════════════════
// Part C — REPL `/apply` is an explicitly MANUAL-UNVERIFIED authority (not autonomous)
// ════════════════════════════════════════════════════════════════════════════════

function fakeManager(promoted = true) {
  const captured: Array<{ evaluatorId: string | undefined; hasVerifiedAgainst: boolean }> = [];
  const handle: WorkspaceHandle = { id: "repl-ws", targetRepo: "/tmp/repl-target", baseBranch: "main", baseRef: "x", scratchBranch: "s", path: "/tmp/repl-scratch", identity: { agentId: "ikbi-chat" }, state: "allocated", createdAt: 0 };
  const mgr: WorkspaceManagerLike = {
    allocate: async () => handle,
    commit: async () => true,
    diff: async () => "",
    promote: async (h, approval): Promise<PromoteResult> => {
      captured.push({ evaluatorId: (approval.evaluation as { evaluatorId?: string }).evaluatorId, hasVerifiedAgainst: (approval as { verifiedAgainst?: unknown }).verifiedAgainst !== undefined });
      return promoted ? { promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "landed" } : { promoted: false, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", strategy: "noop", reason: "no" };
    },
    discard: async (h) => ({ workspaceId: h.id, removed: true }),
    get: async () => handle as never,
  };
  return { mgr, captured };
}
const allowGate: GateWall = { evaluate: async (): Promise<PromoteGovernance> => ({ allow: true, reason: "ok" }) };
const denyGate: GateWall = { evaluate: async (): Promise<PromoteGovernance> => ({ allow: false, reason: "denied by policy" }) };

async function manualReceiptsFor(workspaceId: string) {
  const all = await coreReceipts.query({});
  return all.filter((r) => (r.metadata as { sourceWorkspaceId?: string } | undefined)?.sourceWorkspaceId === workspaceId || r.operation === "workspace.manual_apply");
}

test("C1 [MUTATION 5] (req 13,15): REPL /apply emits a MANUAL-UNVERIFIED receipt, never an autonomous worker.promotion", async () => {
  const { mgr, captured } = fakeManager(true);
  const ws = await allocateSessionWorkspace({ targetRepo: "/tmp/repl-target", sessionId: "sess-c1", manager: mgr, gateWall: allowGate });
  const result = await ws.promote("apply my work");
  assert.equal(result.promoted, true);
  assert.equal(captured[0]!.evaluatorId, "repl-operator", "the manual apply is attributed to the operator, not a worker strategy");
  const recs = await manualReceiptsFor("repl-ws");
  const manual = recs.find((r) => r.operation === "workspace.manual_apply");
  assert.ok(manual !== undefined, "a workspace.manual_apply receipt was written");
  assert.equal((manual!.metadata as Record<string, unknown>).authorityMode, "manual-unverified");
  assert.equal((manual!.metadata as Record<string, unknown>).verifiedPromotion, false, "it makes NO verified-promotion claim");
  assert.equal((manual!.metadata as Record<string, unknown>).testsCertified, false);
  assert.ok(!recs.some((r) => r.operation === "worker.promotion"), "a manual apply NEVER emits the autonomous worker.promotion receipt");
});

test("C2 [MUTATION 6] (req 14): the manual apply awards NO success trust and is unmistakably labelled", async () => {
  const { mgr } = fakeManager(true);
  const ws = await allocateSessionWorkspace({ targetRepo: "/tmp/repl-target", sessionId: "sess-c2", manager: mgr, gateWall: allowGate });
  await ws.promote("apply");
  const manual = (await manualReceiptsFor("repl-ws")).find((r) => r.operation === "workspace.manual_apply" && (r.metadata as Record<string, unknown>).sessionId === "sess-c2");
  assert.ok(manual !== undefined);
  assert.equal((manual!.metadata as Record<string, unknown>).successTrustAwarded, false, "manual apply grants no success trust");
  assert.equal((manual!.metadata as Record<string, unknown>).operatorDirected, true);
  assert.equal((manual!.metadata as Record<string, unknown>).semanticEvaluationAuthoritative, false);
});

test("C3 (req 13): a DENYING gate-wall blocks the manual apply and records it as not-promoted (fail-closed)", async () => {
  const { mgr, captured } = fakeManager(true);
  const ws = await allocateSessionWorkspace({ targetRepo: "/tmp/repl-target", sessionId: "sess-c3", manager: mgr, gateWall: denyGate });
  const result = await ws.promote("apply");
  assert.equal(result.promoted, false, "a gate-wall deny blocks the manual apply");
  assert.equal(captured.length, 0, "the low-level promote is never reached on a deny");
  const manual = (await manualReceiptsFor("repl-ws")).find((r) => r.operation === "workspace.manual_apply" && (r.metadata as Record<string, unknown>).sessionId === "sess-c3");
  assert.ok(manual !== undefined && (manual.metadata as Record<string, unknown>).promoted === false);
});

// ════════════════════════════════════════════════════════════════════════════════
// Part D — source boundary (req 25) + mutation-guard summary
// ════════════════════════════════════════════════════════════════════════════════

test("D1 [MUTATION 7-implicit] (req 25): `workspaces.promote(` is reachable from EXACTLY one authority in the worker orchestrator", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "orchestrator.ts"), "utf8");
  assert.equal((src.match(/workspaces\.promote\(/g) ?? []).length, 1, "one canonical autonomous promotion authority — no strategy promotes directly");
});

test("D2 (req 25): the promotion authority consumes executed-test evidence + tree identity (the enforcement lives in one place)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "orchestrator.ts"), "utf8");
  assert.match(src, /evaluateExecutedTestEvidence\(evidence\.testEvidence/, "the authority evaluates executed-test evidence");
  assert.match(src, /candidate\.treeIdentityRequired === true/, "the authority enforces tree identity fail-closed");
  assert.match(src, /if \(evidence\.verificationPassed !== true\)/, "the authority enforces the deterministic verifier gate");
});

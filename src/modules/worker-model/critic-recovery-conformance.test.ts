/**
 * CRITIC-RECOVERY CONFORMANCE (Phase 9, IKBI-RT-006 — the critic contract + bounded reformat recovery).
 *
 * Proves the Phase 9 critic contract end-to-end at the critic seam + the pure recovery policy + the
 * durable semantic evidence:
 *   - the canonical prompt carries goal / candidateId / verifiedTree / deterministic evidence / the
 *     structured schema / explicit anti-style-bias language;
 *   - a correct alternate implementation PASSES; a concrete defect FAILS; a named unmet requirement is
 *     INCOMPLETE; a bare FAIL is INDETERMINATE and never triggers recovery/duel/fixer;
 *   - bounded structured-output recovery: exactly ONE in-lane, separately-costed reformat attempt, only
 *     for a recoverable STRUCTURAL failure; a substantive mutation (invented defect / flipped verdict) is
 *     rejected; candidate/stale mismatch, empty, truncation, and content-filter never recover;
 *   - retry taxonomy stays distinct (provider retry ≠ structured-output recovery ≠ candidate repair);
 *   - the fixer receives VALIDATED defects, not raw prose;
 *   - a durable `worker.semantic` receipt carries the full validated defect set and the promotion receipt
 *     references its id.
 *
 * These double as MUTATION GUARDS (see HANDOFF-PHASE-9-CRITIC-RECOVERY.md for the 10 enumerated mutations).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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
import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import { autonomyForTier, asTier, TRUST_FLOOR, type TrustDecision } from "../../core/trust/index.js";
import type { DiscardResult, PromoteGovernance, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import { createCritic } from "./critic.js";
import { formatValidatedFixGoal, runCriticFixLoop, isRetryableCriticFail } from "./critic-fix-loop.js";
import { classifyRecoveryEligibility, recoveredPreservesSubstance } from "./critic-recovery.js";
import { parseSemanticVerdict, semanticDuelEligible, type SemanticVerdict } from "./semantic-verdict.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import type { RoleContext, RoleFn, RoleResult } from "./contract.js";

const CRITIC_MODEL = "deepseek-v4-pro";
const IDENTITY: AgentIdentity = { agentId: "worker-1", functionalRole: "critic", trustTier: "verified", spawnedFrom: "parent-1" };

function modelResponse(content: string, finishReason: ModelResponse["finishReason"] = "stop", costUsd: number | undefined = 0): ModelResponse {
  return {
    contractVersion: "1.1.0", model: CRITIC_MODEL, provider: "deepseek", providerModelId: CRITIC_MODEL,
    content, finishReason, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: costUsd as number, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}

const DIFF = ["diff --git a/server.ts b/server.ts", "--- a/server.ts", "+++ b/server.ts", "@@ -1,1 +1,3 @@", "+export function health() { return { ok: true }; }", ""].join("\n");
const builderResult: RoleResult = { role: "builder", outcome: "success", summary: "added /health", detail: { filesWritten: ["server.ts"], rejectedToolCalls: [] } };

/** A critic ctx driving the REAL critic with a scripted, request-capturing engine + a verified tree. */
function makeCriticCtx(responses: ModelResponse[], opts: { goal?: string; vendorLane?: "deepseek" | "mimo"; verifiedTree?: string; verifier?: RoleResult } = {}) {
  const calls: ModelRequest[] = [];
  let i = 0;
  const path = mkdtempSync(join(tmpdir(), "ikbi-p9crit-"));
  writeFileSync(join(path, "server.ts"), "export const ok = true;\n", "utf8");
  const workspace: WorkspaceHandle = { id: "ws1", targetRepo: path, baseBranch: "main", baseRef: "x", scratchBranch: "s", path, identity: IDENTITY, state: "allocated", createdAt: 0 };
  const prior: RoleResult[] = [builderResult, ...(opts.verifier !== undefined ? [opts.verifier] : [])];
  const ctx: RoleContext = {
    task: { taskId: "t-1", targetRepo: "/repo", goal: opts.goal ?? "add a health endpoint", criticModelOverride: CRITIC_MODEL, ...(opts.vendorLane !== undefined ? { moeVendorLane: opts.vendorLane } : {}) },
    role: "critic", identity: IDENTITY, autonomy: autonomyForTier("verified"), workspace, priorResults: prior,
    engine: {
      invokeModel: async (req) => { calls.push(req); return responses[Math.min(i++, responses.length - 1)]!; },
      neutralizeUntrusted: (content, context) => coreNeutralize(content, context),
    },
  };
  const role = createCritic({ diff: async () => DIFF, resolveVerifiedTree: async () => opts.verifiedTree });
  return { ctx, calls, role };
}

const detailOf = (r: RoleResult) => r.detail as Record<string, unknown>;
const svOf = (r: RoleResult) => detailOf(r).semanticVerdict as SemanticVerdict;

// ── canonical structured critic outputs ─────────────────────────────────────────────────────────
const passOut = (candidateId = "t-1", tree?: string) => JSON.stringify({ schemaVersion: 1, candidateId, ...(tree !== undefined ? { verifiedTree: tree } : {}), verdict: "pass", summary: "the endpoint is correct and complete", blockingDefects: [], missingRequirements: [], advisories: [] });
const failOut = (candidateId = "t-1", tree?: string) => JSON.stringify({ schemaVersion: 1, candidateId, ...(tree !== undefined ? { verifiedTree: tree } : {}), verdict: "fail", summary: "missing import causes a runtime crash", blockingDefects: [{ id: "d1", claim: "server.ts references `db` but never imports it — ReferenceError at runtime", requirement: "the /users route must return the user list", evidence: [{ kind: "diff", reference: "server.ts:2", detail: "db.users used without an import" }], severity: "blocking", confidence: 0.95, repairable: true }], missingRequirements: [], advisories: [] });
const incompleteOut = () => JSON.stringify({ schemaVersion: 1, candidateId: "t-1", verdict: "incomplete", summary: "auth added but the /admin guard is missing", blockingDefects: [], missingRequirements: [{ requirement: "protect the /admin routes with the auth middleware", evidence: "the diff adds the middleware but never applies it to /admin" }], advisories: [] });

// ════════════════════════════════════════════════════════════════════════════════
// Part A — the canonical critic PROMPT contract (req 1)
// ════════════════════════════════════════════════════════════════════════════════

test("A1 (req 1): the critic prompt carries goal, candidateId, verifiedTree, deterministic evidence, the structured schema, and explicit anti-style-bias language", async () => {
  const verifier: RoleResult = { role: "verifier", outcome: "success", summary: "green", detail: { verdict: "pass", checks: [{ name: "test", exitCode: 0, outputTail: "ok" }] } };
  const { ctx, calls, role } = makeCriticCtx([modelResponse(passOut("t-1", "TREE9"))], { goal: "add a health endpoint", verifiedTree: "TREE9", verifier });
  await role(ctx);
  const msgs = calls[0]!.messages!;
  const system = msgs.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
  const untrusted = msgs.filter((m) => m.untrusted === true).map((m) => String(m.content)).join("\n");
  assert.match(untrusted, /add a health endpoint/, "the goal is supplied");
  assert.match(system, /candidateId: t-1/, "the candidate id is bound in the prompt");
  assert.match(system, /verifiedTree: TREE9/, "the verified tree is bound in the prompt");
  assert.match(untrusted, /Verifier results/, "the deterministic verifier evidence is supplied");
  assert.match(system, /"blockingDefects"/, "the structured schema is instructed");
  assert.match(system, /schemaVersion/, "the schema version is instructed");
  assert.match(system, /NOT style, taste/i, "explicit anti-style-bias instruction is present");
  assert.match(system, /alternate.{0,20}implementation|another way/i, "alternate valid implementations are accepted");
});

// ════════════════════════════════════════════════════════════════════════════════
// Part B — verdict behaviors (reqs 2,3,4,5)
// ════════════════════════════════════════════════════════════════════════════════

test("B1 (req 2): a correct alternate implementation PASSES and is not rejected for shape", async () => {
  const { ctx, calls, role } = makeCriticCtx([modelResponse(passOut())]);
  const r = await role(ctx);
  assert.equal(detailOf(r).pass, true);
  assert.equal(svOf(r).kind, "pass");
  assert.equal(calls.length, 1, "a clean pass needs no recovery call");
});

test("B2 (req 3): a concrete candidate-bound defect produces a validated FAIL", async () => {
  const { ctx, role } = makeCriticCtx([modelResponse(failOut())], { goal: "add a /users route that returns the user list" });
  const r = await role(ctx);
  assert.equal(svOf(r).kind, "fail");
  assert.equal(svOf(r).blockingDefects.length, 1);
  assert.match(svOf(r).blockingDefects[0]!.claim, /never imports it/);
  assert.equal(svOf(r).candidateId, "t-1", "the defect binds the candidate");
});

test("B3 (req 4): a named unmet requirement produces INCOMPLETE", async () => {
  const { ctx, role } = makeCriticCtx([modelResponse(incompleteOut())]);
  const r = await role(ctx);
  assert.equal(svOf(r).kind, "incomplete");
  assert.equal(svOf(r).incompleteRequirements.length, 1);
});

test("B4 [MUTATION 1] (req 5): a bare FAIL is INDETERMINATE — no recovery, not duel-eligible, not fixer-eligible", async () => {
  const { ctx, calls, role } = makeCriticCtx([modelResponse(JSON.stringify({ verdict: "FAIL" }))]);
  const r = await role(ctx);
  assert.equal(svOf(r).kind, "indeterminate");
  assert.equal(calls.length, 1, "a bare FAIL must NOT trigger a model-backed recovery call");
  assert.equal(detailOf(r).recoveryInvoked, false);
});

// ════════════════════════════════════════════════════════════════════════════════
// Part C — bounded structured-output recovery (reqs 6-13, 17-22, 29)
// ════════════════════════════════════════════════════════════════════════════════

test("C1 (req 6): a malformed-but-recoverable output triggers EXACTLY ONE in-lane recovery bound to the same candidate/tree", async () => {
  // Raw: a real assessment with an UNRECOGNIZED verdict enum ("REJECT") — a structural failure the parser
  // cannot resolve, but a reformatter can. Recovery returns the canonical shape.
  const rawMalformed = "Here is my review:\n" + JSON.stringify({ verdict: "REJECT", blockingDefects: [{ claim: "server.ts references `db` but never imports it — ReferenceError", requirement: "return the users", evidence: "db used without import" }] });
  const { ctx, calls, role } = makeCriticCtx([modelResponse(rawMalformed), modelResponse(failOut("t-1", "TREE9"))], { vendorLane: "deepseek", verifiedTree: "TREE9" });
  const r = await role(ctx);
  assert.equal(calls.length, 2, "exactly one recovery call (two total invocations)");
  assert.equal(calls[1]!.model, CRITIC_MODEL, "recovery ran on the SAME critic model (in-lane)");
  assert.equal(detailOf(r).recoveryInvoked, true);
  assert.equal(detailOf(r).recoveryOutcome, "repaired");
  assert.equal(svOf(r).kind, "fail");
  assert.equal(svOf(r).parseStatus, "repaired");
  assert.equal(svOf(r).candidateId, "t-1");
  assert.equal(svOf(r).verifiedTree, "TREE9", "the recovered verdict binds the SAME candidate/tree");
});

test("C2 [MUTATION 2] (req 7, 29): recovery is capped at ONE — a still-indeterminate recovery yields indeterminate, no second call, no fabricated defect", async () => {
  const rawMalformed = JSON.stringify({ verdict: "REJECT", blockingDefects: [{ claim: "a concrete blocking defect about the import", requirement: "x", evidence: "y" }] });
  const { ctx, calls, role } = makeCriticCtx([modelResponse(rawMalformed), modelResponse("still nonsense, no verdict")]);
  const r = await role(ctx);
  assert.equal(calls.length, 2, "at most ONE recovery call — never a second");
  assert.equal(svOf(r).kind, "indeterminate");
  assert.equal(svOf(r).blockingDefects.length, 0, "no fabricated defect on a failed recovery");
  assert.equal(detailOf(r).recoveryOutcome, "rejected");
});

test("C3 [MUTATION 3] (req 8): recovery that INVENTS a new blocking defect is rejected → indeterminate", async () => {
  // Raw has NO defect substance (a bare unrecognized token); the recovery tries to add one.
  const rawMalformed = JSON.stringify({ verdict: "REJECT" });
  const invented = JSON.stringify({ verdict: "fail", blockingDefects: [{ claim: "an invented bug the raw output never mentioned at all", requirement: "x", evidence: "z" }] });
  const { ctx, role } = makeCriticCtx([modelResponse(rawMalformed), modelResponse(invented)]);
  const r = await role(ctx);
  assert.equal(svOf(r).kind, "indeterminate", "an invented defect is a substantive mutation → rejected");
  assert.equal(detailOf(r).recoveryOutcome, "rejected");
  assert.equal(detailOf(r).recoveryRejectReason, "blocking-verdict-without-raw-substance");
});

test("C4 [MUTATION 4] (req 9): recovery that flips PASS→FAIL is rejected", async () => {
  const rawPassish = JSON.stringify({ verdict: "approve", summary: "looks correct and complete" }); // 'approve' → unrecognized enum
  const flipped = JSON.stringify({ verdict: "fail", blockingDefects: [{ claim: "a fabricated blocking defect not in the raw", requirement: "x", evidence: "z" }] });
  const { ctx, role } = makeCriticCtx([modelResponse(rawPassish), modelResponse(flipped)]);
  const r = await role(ctx);
  assert.equal(svOf(r).kind, "indeterminate");
  assert.equal(detailOf(r).recoveryRejectReason, "verdict-flipped-pass-to-blocking");
});

test("C5 [MUTATION 4] (req 10): recovery that flips FAIL→PASS is rejected", async () => {
  const rawFailish = JSON.stringify({ verdict: "reject", blockingDefects: [{ claim: "a concrete blocking defect about a missing import", requirement: "x", evidence: "y" }] });
  const flippedPass = JSON.stringify({ verdict: "pass", summary: "actually it is fine" });
  const { ctx, role } = makeCriticCtx([modelResponse(rawFailish), modelResponse(flippedPass)]);
  const r = await role(ctx);
  assert.equal(svOf(r).kind, "indeterminate");
  assert.equal(detailOf(r).recoveryRejectReason, "verdict-flipped-blocking-to-pass");
});

test("C6 (req 11): a candidate-id MISMATCH echo gets NO recovery and is indeterminate", async () => {
  const { ctx, calls, role } = makeCriticCtx([modelResponse(failOut("SOME-OTHER-CANDIDATE"))]);
  const r = await role(ctx);
  assert.equal(svOf(r).kind, "indeterminate");
  assert.equal(calls.length, 1, "a cross-candidate echo is never reformatted");
  assert.equal(detailOf(r).recoveryInvoked, false);
});

test("C7 (req 12): a verifiedTree MISMATCH echo gets NO recovery and is indeterminate", async () => {
  const { ctx, calls, role } = makeCriticCtx([modelResponse(failOut("t-1", "WRONG-TREE"))], { verifiedTree: "REAL-TREE" });
  const r = await role(ctx);
  assert.equal(svOf(r).kind, "indeterminate");
  assert.equal(calls.length, 1, "a stale-tree echo is never reformatted");
});

test("C8 (req 13): EMPTY output is indeterminate with no recovery and no fabricated defect", async () => {
  const { ctx, calls, role } = makeCriticCtx([modelResponse("")]);
  const r = await role(ctx);
  assert.equal(svOf(r).kind, "indeterminate");
  assert.equal(calls.length, 1);
  assert.equal(svOf(r).blockingDefects.length, 0);
});

test("C9 (req 14): confirmed TRUNCATION (finishReason=length) is infrastructure-failure with NO schema recovery", async () => {
  const { ctx, calls, role } = makeCriticCtx([modelResponse(failOut(), "length")]);
  const r = await role(ctx);
  assert.equal(svOf(r).kind, "infrastructure-failure");
  assert.equal(calls.length, 1, "a truncation never triggers reformat recovery");
});

test("C10 (req 15): a CONTENT-FILTER refusal is infrastructure-failure, never a candidate rejection", async () => {
  const { ctx, role } = makeCriticCtx([modelResponse(failOut(), "content_filter")]);
  const r = await role(ctx);
  assert.equal(svOf(r).kind, "infrastructure-failure");
  assert.equal(detailOf(r).objectiveFailure, true, "a provider refusal is an objective/infra outcome, not a candidate defect");
});

test("C11 (req 17): a LOCAL parser success incurs NO recovery model call (zero extra cost)", async () => {
  const { ctx, calls, role } = makeCriticCtx([modelResponse(passOut())]);
  await role(ctx);
  assert.equal(calls.length, 1, "a well-formed verdict is parsed locally — no provider call for recovery");
});

test("C12 [MUTATION 6] (req 18, 30): a model-backed recovery creates ONE unique invocation with a captured cost record", async () => {
  const rawMalformed = JSON.stringify({ verdict: "REJECT", blockingDefects: [{ claim: "concrete: missing import of db causes a crash", requirement: "x", evidence: "y" }] });
  const { ctx, role } = makeCriticCtx([modelResponse(rawMalformed), modelResponse(failOut(), "stop", 0.004)]);
  const r = await role(ctx);
  assert.equal(detailOf(r).recoveryInvoked, true);
  assert.equal(detailOf(r).recoveryInvocationId, "t-1:critic_recovery", "a unique invocation id");
  assert.equal(detailOf(r).recoveryCostUsd, 0.004, "the recovery cost is captured");
  assert.equal(detailOf(r).recoveryCostStatus, "measured");
});

test("C13 (req 19): an UNKNOWN recovery cost becomes 'unavailable' — never silently zero", async () => {
  const rawMalformed = JSON.stringify({ verdict: "REJECT", blockingDefects: [{ claim: "concrete: missing import of db causes a crash", requirement: "x", evidence: "y" }] });
  const { ctx, role } = makeCriticCtx([modelResponse(rawMalformed), modelResponse(failOut(), "stop", NaN)]);
  const r = await role(ctx);
  assert.equal(detailOf(r).recoveryCostStatus, "unavailable", "unknown usage/price is not zero");
});

test("C14 [MUTATION 5] (req 20, 21, 22): critic + recovery identity agree and recovery stays IN-LANE", async () => {
  const rawMalformed = JSON.stringify({ verdict: "REJECT", blockingDefects: [{ claim: "concrete: missing import of db causes a crash", requirement: "x", evidence: "y" }] });
  const { ctx, calls, role } = makeCriticCtx([modelResponse(rawMalformed), modelResponse(failOut())], { vendorLane: "deepseek" });
  const r = await role(ctx);
  assert.equal(calls[0]!.model, CRITIC_MODEL, "critic dispatched == selected");
  assert.equal(calls[1]!.model, CRITIC_MODEL, "recovery dispatched == critic model (cannot cross vendor lanes)");
  assert.equal(detailOf(r).recoveryModel, CRITIC_MODEL, "recovery receipt model == dispatched");
  assert.equal(detailOf(r).recoveryVendorLane, "deepseek");
});

test("C15 [MUTATION 8, 9] (req 5, 7): a parser/recovery-failure INDETERMINATE (and infrastructure-failure) is NOT duel-eligible and NOT fixer-eligible", () => {
  // The peer duel + the fixer trigger only on CONCRETE candidate rejections. A malformed/unrecoverable
  // critic (indeterminate) or a provider failure (infrastructure-failure) is neither — a peer vendor
  // cannot fix an unparseable critic, and the fixer has no authentic defect to repair.
  assert.equal(semanticDuelEligible("indeterminate"), false, "indeterminate is NOT duel-eligible");
  assert.equal(semanticDuelEligible("infrastructure-failure"), false, "infra-failure is NOT duel-eligible");
  assert.equal(semanticDuelEligible("fail"), true, "a concrete fail IS duel-eligible (control)");
  const indetCritic: RoleResult = { role: "critic", outcome: "success", summary: "FAIL", detail: { pass: false, semanticVerdict: parseSemanticVerdict(JSON.stringify({ verdict: "FAIL" })) } };
  assert.equal(isRetryableCriticFail(indetCritic), false, "an indeterminate critic does NOT trigger the fixer/critic-fix loop");
});

// ════════════════════════════════════════════════════════════════════════════════
// Part D — pure recovery policy (critic-recovery.ts)
// ════════════════════════════════════════════════════════════════════════════════

test("D1: recovery eligibility — bare token / empty / truncated / generic are INELIGIBLE; a real object is eligible", () => {
  assert.equal(classifyRecoveryEligibility("FAIL").eligible, false);
  assert.equal(classifyRecoveryEligibility("").eligible, false);
  assert.equal(classifyRecoveryEligibility('{"verdict":"fail"').eligible, false, "a truncated object (no closing brace) is ineligible");
  assert.equal(classifyRecoveryEligibility("the implementation is bad").eligible, false, "a generic accusation is ineligible");
  assert.equal(classifyRecoveryEligibility(JSON.stringify({ verdict: "REJECT", blockingDefects: [{ claim: "x" }] })).eligible, true);
});

test("D2: substance guard — flips and invented defects are rejected; a preserved reformat is ok", () => {
  const raw = JSON.stringify({ verdict: "reject", blockingDefects: [{ claim: "missing import of db" }] });
  const preserved = parseSemanticVerdict(JSON.stringify({ verdict: "fail", blockingDefects: [{ claim: "the missing import of db crashes it", requirement: "r", evidence: "e" }] }));
  assert.equal(recoveredPreservesSubstance(raw, preserved).ok, true, "reformatting the same fail is preserved");
  const flippedPass = parseSemanticVerdict(JSON.stringify({ verdict: "pass" }));
  assert.equal(recoveredPreservesSubstance(raw, flippedPass).ok, false, "fail→pass is a mutation");
  const rawPass = JSON.stringify({ verdict: "approve", summary: "fine" });
  const flippedFail = parseSemanticVerdict(JSON.stringify({ verdict: "fail", blockingDefects: [{ claim: "an invented concrete blocking defect", requirement: "r", evidence: "e" }] }));
  assert.equal(recoveredPreservesSubstance(rawPass, flippedFail).ok, false, "pass→fail is a mutation");
});

// ════════════════════════════════════════════════════════════════════════════════
// Part E — fixer receives VALIDATED defects (req 25)
// ════════════════════════════════════════════════════════════════════════════════

test("E1 [MUTATION 7] (req 25): the fixer goal is built from VALIDATED defects, not raw critic prose", async () => {
  const verdict = parseSemanticVerdict(failOut(), { goal: "return users", candidateId: "t-1" });
  const goal = formatValidatedFixGoal(verdict);
  assert.match(goal, /VALIDATED defects/);
  assert.match(goal, /never imports it/, "the validated defect claim is in the fix goal");
  assert.match(goal, /requirement not met/, "the requirement is surfaced");
  assert.match(goal, /evidence:/, "the evidence is surfaced");

  // The fix loop consumes the validated defects, not the raw feedback string.
  const criticFail: RoleResult = { role: "critic", outcome: "success", summary: "FAIL", detail: { pass: false, feedback: "raw prose that must NOT be the fix goal", semanticVerdict: verdict } };
  let seen = "";
  await runCriticFixLoop(criticFail, {
    builder: async (g) => { seen = g; return { role: "builder", outcome: "success", summary: "b", detail: { filesWritten: ["x.ts"] } }; },
    verifier: async () => ({ role: "verifier", outcome: "success", summary: "v", detail: { verdict: "pass", checks: [] } }),
    critic: async () => ({ role: "critic", outcome: "success", summary: "PASS", detail: { pass: true } }),
  });
  assert.match(seen, /never imports it/, "the fixer received the validated defect");
  assert.doesNotMatch(seen, /raw prose that must NOT/, "the fixer did NOT receive the raw prose");
});

// ════════════════════════════════════════════════════════════════════════════════
// Part F — durable semantic evidence + promotion reference (real orchestrator seam; reqs 23, 24, 27)
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
    // Any non-builder model call (scout, or a stray role) that lacks the `done` tool is absorbed here so
    // it never consumes a builder turn; the critic/verifier/integrator are injected and make no model call.
    if (!(req.tools ?? []).some((t) => t.name === "done")) return ok(JSON.stringify({ verdict: "PASS", scores: { files_modified: 5, goal_correctness: 5, code_quality: 5, tests: 5, suspicious_patterns: 5 }, feedback: "ok" }));
    turn += 1;
    if (turn === 1) return toolResp("read_file", { path: "a.ts" });
    if (turn === 2) return toolResp("write_file", { path: "a.ts", content: "export const a = 2;\n" });
    if (turn === 3) return toolResp("run_checks", {});
    return toolResp("done", { successCondition: "do the thing", filesReadBack: ["a.ts"], selfCheck: "ran checks green; goal met", satisfied: true });
  };
}
/** A critic double that stamps a crafted canonical semantic verdict (bypasses the real critic model). */
function stubCriticVerdict(verdict: SemanticVerdict, pass: boolean): RoleFn {
  return async () => ({ role: "critic", outcome: "success", summary: pass ? "PASS" : "FAIL", detail: { pass, feedback: verdict.summary, semanticVerdict: verdict, rawOutputHash: "hash123" } });
}
function gitInit(dir: string): string {
  const g = (...a: string[]): string => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g("init", "-q"); writeFileSync(join(dir, "a.ts"), "export const a = 1;"); g("add", "-A"); g("commit", "-q", "-m", "base");
  return g("rev-parse", "HEAD").trim();
}
function realRun(critic: RoleFn, taskId: string) {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const rc = capturingReceipts();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-p9orch-"));
  const baseRef = gitInit(dir);
  const handle: WorkspaceHandle = { id: "wsp9", targetRepo: dir, baseBranch: "main", baseRef, scratchBranch: "s", path: dir, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 1000, maxConcurrentRuns: 1, trustLadder: true },
    workspaces: {
      allocate: async () => handle,
      promote: async (h): Promise<PromoteResult> => ({ promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }),
      discard: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: true }),
      retain: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: false }),
      commit: async () => true,
    },
    events: fakeBus, receipts: rc.receipts, trust: stubTrust, resolveIdentity, roleClaim,
    roles: {
      verifier: async () => ({ role: "verifier", outcome: "success", summary: "ok", detail: { verdict: "pass", checks: [], testEvidence: "executed" } }),
      critic,
      integrator: async () => ({ role: "integrator", outcome: "success", summary: "p", detail: { decision: "promote", rationale: "s", evaluation: { approved: true } } }),
    },
    invokeModel: builderProvider(), governedExec: { run: async () => ({ executed: true as const, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) }, builderModel: "deepseek-v4-flash",
    gateWall: { evaluate: async (): Promise<PromoteGovernance> => ({ allow: true, reason: "ok" }) },
  });
  return { run: () => orch.run({ taskId, targetRepo: "/unused", goal: "do the thing", moeExpertRental: true, moeVendorLane: "deepseek" }, parentCtx), receipts: rc.appended };
}

test("F1 [MUTATION 10] (req 23, 24): a durable worker.semantic receipt carries the full validated verdict, embeds the verified tree in its id, and the promotion receipt references it", async () => {
  const passVerdict = parseSemanticVerdict(passOut("build:deepseek"), { candidateId: "build:deepseek" });
  const h = realRun(stubCriticVerdict(passVerdict, true), "build:deepseek");
  const result = await h.run();
  assert.equal(result.promoted, true);
  const sem = h.receipts.find((r) => r.operation === "worker.semantic");
  assert.ok(sem !== undefined, "a durable worker.semantic receipt was written");
  assert.equal(sem!.metadata.verdict, "pass");
  assert.ok(Array.isArray(sem!.metadata.blockingDefects), "the full validated defect set is persisted (empty for a pass)");
  // MUTATION 10 guard: the evaluation id BINDS the verified tree, so a repaired candidate (new tree)
  // gets a FRESH id and can never reuse the source candidate's semantic evidence.
  assert.ok(sem!.metadata.verifiedTree !== undefined, "the verified tree is recorded");
  assert.ok(String(sem!.metadata.semanticEvaluationId).includes(String(sem!.metadata.verifiedTree)), "the semantic evaluation id embeds the verified tree (a changed tree ⇒ a distinct id)");
  const promo = h.receipts.find((r) => r.operation === "worker.promotion");
  assert.ok(promo !== undefined);
  assert.equal(promo!.metadata.semanticEvaluationId, sem!.metadata.semanticEvaluationId, "the promotion receipt REFERENCES the semantic evaluation id");
});

test("F2 (req 23): a FAIL persists the full validated blocking-defect set in worker.semantic", async () => {
  const failVerdict = parseSemanticVerdict(failOut("t-fail"), { candidateId: "t-fail", goal: "return users" });
  const h = realRun(stubCriticVerdict(failVerdict, false), "t-fail");
  await h.run();
  const sem = h.receipts.find((r) => r.operation === "worker.semantic")!;
  assert.equal(sem.metadata.verdict, "fail");
  const defects = sem.metadata.blockingDefects as unknown[];
  assert.equal(defects.length, 1, "the concrete validated defect is durably persisted for the fixer/operator");
});

test("F3 (req 26, 27): the semantic evaluation id binds the verified tree, so different candidates/trees get distinct evidence", async () => {
  const v1 = parseSemanticVerdict(passOut("build:deepseek"), { candidateId: "build:deepseek" });
  const a = realRun(stubCriticVerdict(v1, true), "build:deepseek");
  await a.run();
  const v2 = parseSemanticVerdict(passOut("build:mimo"), { candidateId: "build:mimo" });
  const b = realRun(stubCriticVerdict(v2, true), "build:mimo");
  await b.run();
  const idA = a.receipts.find((r) => r.operation === "worker.semantic")!.metadata.semanticEvaluationId as string;
  const idB = b.receipts.find((r) => r.operation === "worker.semantic")!.metadata.semanticEvaluationId as string;
  assert.notEqual(idA, idB, "primary and peer maintain DISTINCT semantic evidence ids");
  assert.match(idA, /build:deepseek/);
});

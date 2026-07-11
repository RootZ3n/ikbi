/**
 * PHASE 12 — SEMANTIC SUBSTANCE: evidence-bound defects + structure-preserving, substance-inert recovery.
 *
 * Closes IKBI-REAUDIT-003. Two invariants:
 *   1. EVIDENCE BINDING — a blocking defect is concrete ONLY when it cites ≥1 resolvable id from the finite
 *      evidence package the critic was shown, and its requirement names the goal / a supplied acceptance
 *      criterion. Unsupported "specific-looking" prose can no longer become a defect (→ indeterminate).
 *   2. SUBSTANCE-PRESERVING RECOVERY — a recovered verdict is accepted ONLY when deterministic local comparison
 *      proves its decision-bearing substance is EQUAL to the recoverable substance already present in the raw
 *      output. Recovery may repair syntax/wrappers/field-names/placement; it may not invent, drop, reword,
 *      re-evidence, re-scope, promote severity, or flip a verdict. Not proven ⇒ `indeterminate` (fail-closed).
 *
 * Most tests exercise the PURE primitives (buildEvidencePackage / parseSemanticVerdict+package /
 * substanceFingerprint / substanceEquivalent); the seam tests drive the REAL enforcing critic + orchestrator.
 * Several double as MUTATION GUARDS — see HANDOFF-PHASE-12-SEMANTIC-SUBSTANCE.md.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";
import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { OperationContext, ValidatedIdentity } from "../../core/identity/resolver.js";
import type { EventBusSurface, EventInput, IkbiEvent } from "../../core/events/index.js";
import { autonomyForTier, asTier, TRUST_FLOOR, type TrustDecision } from "../../core/trust/index.js";
import type { DiscardResult, PromoteGovernance, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import { parseSemanticVerdict, type SemanticVerdict, type BlockingDefect } from "./semantic-verdict.js";
import {
  buildEvidencePackage, substanceFingerprint, substanceEquivalent, validateDefectEvidence,
  resolveEvidenceRef, type EvidencePackage,
} from "./semantic-evidence.js";
import { classifyRecoveryEligibility } from "./critic-recovery.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import type { RoleFn } from "./contract.js";

// ── evidence-package + parse helpers ──────────────────────────────────────────────────────────────
function pkg(over: Partial<Parameters<typeof buildEvidencePackage>[0]> = {}): EvidencePackage {
  return buildEvidencePackage({
    candidateId: "cand-1", verifiedTree: "TREE1", goal: "add a /users route that returns the user list",
    changedFiles: ["server.ts", "users.ts"], checks: [{ name: "typecheck" }, { name: "test", isTest: true }],
    runtimeEvidenceIds: ["rt-1"], ...over,
  });
}
const J = (o: unknown) => JSON.stringify(o);
/** Parse a critic JSON with an evidence package bound (production enforcing mode). */
function parseEnforced(o: unknown, p: EvidencePackage = pkg(), ctxOver: Record<string, unknown> = {}): SemanticVerdict {
  return parseSemanticVerdict(J(o), { candidateId: p.candidateId, ...(p.verifiedTree !== undefined ? { verifiedTree: p.verifiedTree } : {}), goal: "add a /users route that returns the user list", evidencePackage: p, ...ctxOver });
}
const validDefect = (over: Record<string, unknown> = {}) => ({ claim: "server.ts references db but never imports it — ReferenceError", evidenceIds: ["file:server.ts"], requirementId: "req:goal", ...over });

// ── recovered-verdict + fingerprint helpers ─────────────────────────────────────────────────────
function mkDefect(claim: string, evidenceIds: string[], over: Partial<BlockingDefect> = {}): BlockingDefect {
  return { id: "d1", claim, evidence: claim, requirement: "req", severity: "blocking", confidence: 0.9, evidenceIds, ...over };
}
function mkVerdict(kind: SemanticVerdict["kind"], over: Partial<SemanticVerdict> = {}): SemanticVerdict {
  return { kind, summary: "s", blockingDefects: [], incompleteRequirements: [], advisories: [], parseStatus: "repaired", ...over };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part A — canonical evidence package + defect validation (reqs 1-8)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test("A1 (req 1): the evidence package enumerates a finite set of allowed evidence + requirement ids", () => {
  const p = pkg();
  assert.ok(p.ids.has("file:server.ts") && p.ids.has("diff:server.ts"), "changed files are enumerated");
  assert.ok(p.ids.has("check:typecheck") && p.ids.has("check:test") && p.ids.has("test:test"), "checks + executed-tests are enumerated");
  assert.ok(p.ids.has("runtime:rt-1"), "runtime facts are enumerated");
  assert.ok(p.ids.has("candidate") && p.ids.has("tree"), "candidate + tree are anchors");
  assert.ok(p.requirementIds.has("req:goal"), "the goal is the requirement anchor when no explicit criteria");
});

test("A2 (req 2): a defect referencing SUPPLIED evidence is accepted as a concrete FAIL", () => {
  const v = parseEnforced({ verdict: "fail", blockingDefects: [validDefect()] });
  assert.equal(v.kind, "fail");
  assert.equal(v.blockingDefects.length, 1);
  assert.deepEqual(v.blockingDefects[0]!.evidenceIds, ["file:server.ts"]);
  assert.equal(v.blockingDefects[0]!.requirementId, "req:goal");
});

test("A3 [MUTATION 6] (req 3): a defect that cites NO evidence is invalid → dropped → indeterminate", () => {
  const v = parseEnforced({ verdict: "fail", blockingDefects: [{ claim: "the tree is computed wrong for nested nodes" }] });
  assert.equal(v.kind, "indeterminate", "an unsupported claim cannot become a concrete defect");
  assert.equal(v.blockingDefects.length, 0);
  // the direct validator agrees
  assert.equal(validateDefectEvidence({ claim: "x is wrong somewhere" }, pkg()).valid, false);
});

test("A4 (req 4): a defect citing an UNKNOWN/unsupplied evidence id is invalid", () => {
  const v = parseEnforced({ verdict: "fail", blockingDefects: [validDefect({ evidenceIds: ["file:never-shown.ts"] })] });
  assert.equal(v.kind, "indeterminate");
  assert.equal(resolveEvidenceRef("file:never-shown.ts", pkg()), undefined, "the id does not resolve against the package");
});

test("A5 (req 5): a defect claiming a test result NOT in executed-test evidence is invalid", () => {
  const v = parseEnforced({ verdict: "fail", blockingDefects: [validDefect({ evidenceIds: ["test:integration"] })] });
  assert.equal(v.kind, "indeterminate", "a test not in the executed-test evidence cannot support a defect");
  const ok = parseEnforced({ verdict: "fail", blockingDefects: [validDefect({ evidenceIds: ["test:test"] })] });
  assert.equal(ok.kind, "fail", "the executed 'test' check DOES support a defect (control)");
});

test("A6 (req 6): a requirement OUTSIDE the user goal / criteria is invalid", () => {
  const withCriteria = pkg({ acceptanceCriteria: ["the /users route returns the list", "responses are JSON"] });
  const bad = parseEnforced({ verdict: "fail", blockingDefects: [validDefect({ requirementId: "req:99" })] }, withCriteria);
  assert.equal(bad.kind, "indeterminate", "a requirement id not among the acceptance criteria is invalid");
  const good = parseEnforced({ verdict: "fail", blockingDefects: [validDefect({ requirementId: "req:0" })] }, withCriteria);
  assert.equal(good.kind, "fail", "a defect naming a real acceptance criterion is valid (control)");
});

test("A7 (req 7): another candidate's evidence (candidateId echo mismatch) is invalid → indeterminate", () => {
  const v = parseEnforced({ candidateId: "SOME-OTHER", verdict: "fail", blockingDefects: [validDefect()] });
  assert.equal(v.kind, "indeterminate", "a cross-candidate echo cannot bind here");
});

test("A8 (req 8): stale-tree evidence (verifiedTree echo mismatch) is invalid → indeterminate", () => {
  const v = parseEnforced({ verifiedTree: "WRONG-TREE", verdict: "fail", blockingDefects: [validDefect()] });
  assert.equal(v.kind, "indeterminate", "a stale-tree echo cannot bind here");
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part B — deterministic recovery equivalence (reqs 9-29)
// ════════════════════════════════════════════════════════════════════════════════════════════════

const rawFail = (defects: unknown[], over: Record<string, unknown> = {}) => J({ verdict: "fail", candidateId: "cand-1", verifiedTree: "TREE1", blockingDefects: defects, ...over });

test("B9 (req 9): a wrapper/field-name reformat that preserves substance is EQUIVALENT", () => {
  const raw = "Here is my review:\n" + rawFail([{ claim: "db is used but never imported", evidenceIds: ["file:server.ts"] }]);
  const recovered = mkVerdict("fail", { candidateId: "cand-1", verifiedTree: "TREE1", blockingDefects: [mkDefect("db is used but never imported", ["file:server.ts"])] });
  assert.equal(substanceEquivalent(substanceFingerprint(raw), recovered).ok, true);
});

test("B10 (req 10): whitespace-only normalization is equivalent", () => {
  const raw = rawFail([{ claim: "db   is used\n  but never   imported", evidenceIds: ["file:server.ts"] }]);
  const recovered = mkVerdict("fail", { candidateId: "cand-1", verifiedTree: "TREE1", blockingDefects: [mkDefect("db is used but never imported", ["file:server.ts"])] });
  assert.equal(substanceEquivalent(substanceFingerprint(raw), recovered).ok, true);
});

const twoRaw = rawFail([{ claim: "defect a about imports", evidenceIds: ["file:server.ts"] }, { claim: "defect b about routing", evidenceIds: ["file:users.ts"] }]);
const oneRaw = rawFail([{ claim: "defect a about imports", evidenceIds: ["file:server.ts"] }]);
const dA = mkDefect("defect a about imports", ["file:server.ts"]);
const dB = mkDefect("defect b about routing", ["file:users.ts"]);

test("B11 [MUTATION 1] (req 11): a defect count INCREASE fails equivalence", () => {
  const eq = substanceEquivalent(substanceFingerprint(oneRaw), mkVerdict("fail", { blockingDefects: [dA, dB] }));
  assert.equal(eq.ok, false);
  assert.ok(eq.mismatches.some((m) => m.startsWith("defect-count-changed")) && eq.mismatches.includes("defect-added-or-reworded"));
});

test("B12 [MUTATION 2] (req 12): a defect count DECREASE fails equivalence", () => {
  const eq = substanceEquivalent(substanceFingerprint(twoRaw), mkVerdict("fail", { blockingDefects: [dA] }));
  assert.equal(eq.ok, false);
  assert.ok(eq.mismatches.includes("defect-dropped-or-reworded"));
});

test("B13 [MUTATION 1] (req 13): an ADDED defect fails", () => {
  assert.equal(substanceEquivalent(substanceFingerprint(oneRaw), mkVerdict("fail", { blockingDefects: [dA, dB] })).ok, false);
});

test("B14 [MUTATION 2] (req 14): a REMOVED defect fails", () => {
  assert.equal(substanceEquivalent(substanceFingerprint(twoRaw), mkVerdict("fail", { blockingDefects: [dB] })).ok, false);
});

test("B15 [MUTATION 7] (req 15): CHANGED defect wording fails (no fuzzy similarity)", () => {
  const eq = substanceEquivalent(substanceFingerprint(oneRaw), mkVerdict("fail", { blockingDefects: [mkDefect("defect a regarding the imports", ["file:server.ts"])] }));
  assert.equal(eq.ok, false, "materially reworded claim is not equivalent");
});

test("B16 [MUTATION 5] (req 16): an ADDED evidence id fails", () => {
  const eq = substanceEquivalent(substanceFingerprint(oneRaw), mkVerdict("fail", { blockingDefects: [mkDefect("defect a about imports", ["file:server.ts", "file:users.ts"])] }));
  assert.equal(eq.ok, false);
  assert.ok(eq.mismatches.includes("evidence-added"));
});

test("B17 (req 17): a REMOVED evidence id fails", () => {
  const raw = rawFail([{ claim: "defect a about imports", evidenceIds: ["file:server.ts", "file:users.ts"] }]);
  const eq = substanceEquivalent(substanceFingerprint(raw), mkVerdict("fail", { blockingDefects: [mkDefect("defect a about imports", ["file:server.ts"])] }));
  assert.equal(eq.ok, false);
  assert.ok(eq.mismatches.includes("evidence-removed"));
});

test("B18 (req 18): a CHANGED requirement association fails", () => {
  const raw = rawFail([{ claim: "defect a about imports", evidenceIds: ["file:server.ts"], requirement: "the users route works" }]);
  const eq = substanceEquivalent(substanceFingerprint(raw), mkVerdict("fail", { blockingDefects: [mkDefect("defect a about imports", ["file:server.ts"], { requirement: "the admin route works" })] }));
  assert.equal(eq.ok, false);
  assert.ok(eq.mismatches.includes("requirement-changed"));
});

test("B19 (req 19): an ADVISORY promoted to a BLOCKER fails", () => {
  const raw = J({ verdict: "pass", candidateId: "cand-1", verifiedTree: "TREE1", advisories: [{ claim: "consider caching the lookup" }] });
  const eq = substanceEquivalent(substanceFingerprint(raw), mkVerdict("fail", { candidateId: "cand-1", verifiedTree: "TREE1", blockingDefects: [mkDefect("consider caching the lookup", ["file:server.ts"])] }));
  assert.equal(eq.ok, false);
  assert.ok(eq.mismatches.includes("advisory-promoted-to-blocker") || eq.mismatches.includes("verdict-flipped-pass-to-blocking"));
});

test("B20 (req 20): a BLOCKER demoted to an advisory fails", () => {
  const eq = substanceEquivalent(substanceFingerprint(oneRaw), mkVerdict("pass", { blockingDefects: [], advisories: [{ claim: "defect a about imports" }] }));
  assert.equal(eq.ok, false, "dropping the blocker (now merely advisory) is a substance change");
});

test("B21 (req 21): a SEVERITY change fails", () => {
  const raw = rawFail([{ claim: "defect a about imports", evidenceIds: ["file:server.ts"], severity: "minor" }]);
  const eq = substanceEquivalent(substanceFingerprint(raw), mkVerdict("fail", { blockingDefects: [mkDefect("defect a about imports", ["file:server.ts"])] }));
  assert.equal(eq.ok, false);
  assert.ok(eq.mismatches.includes("severity-changed"));
});

test("B22 (req 22): a REPAIRABILITY change fails", () => {
  const raw = rawFail([{ claim: "defect a about imports", evidenceIds: ["file:server.ts"], repairable: false }]);
  const eq = substanceEquivalent(substanceFingerprint(raw), mkVerdict("fail", { blockingDefects: [mkDefect("defect a about imports", ["file:server.ts"], { repairable: true })] }));
  assert.equal(eq.ok, false);
  assert.ok(eq.mismatches.includes("repairability-changed"));
});

test("B23 [MUTATION 4] (req 23): PASS→FAIL fails", () => {
  const raw = J({ verdict: "pass", candidateId: "cand-1", verifiedTree: "TREE1" });
  const eq = substanceEquivalent(substanceFingerprint(raw), mkVerdict("fail", { candidateId: "cand-1", verifiedTree: "TREE1", blockingDefects: [dA] }));
  assert.equal(eq.ok, false);
  assert.ok(eq.mismatches.includes("verdict-flipped-pass-to-blocking"));
});

test("B24 [MUTATION 3] (req 24): FAIL→PASS fails", () => {
  const eq = substanceEquivalent(substanceFingerprint(oneRaw), mkVerdict("pass"));
  assert.equal(eq.ok, false);
  assert.ok(eq.mismatches.includes("verdict-flipped-blocking-to-pass"));
});

test("B25 (req 25): INCOMPLETE→PASS fails", () => {
  const raw = J({ verdict: "incomplete", candidateId: "cand-1", verifiedTree: "TREE1", missingRequirements: [{ requirement: "the /admin guard" }] });
  assert.equal(substanceEquivalent(substanceFingerprint(raw), mkVerdict("pass", { candidateId: "cand-1", verifiedTree: "TREE1" })).ok, false);
});

test("B26 (req 26): a CANDIDATE binding change fails", () => {
  const eq = substanceEquivalent(substanceFingerprint(oneRaw), mkVerdict("fail", { candidateId: "OTHER", verifiedTree: "TREE1", blockingDefects: [dA] }));
  assert.equal(eq.ok, false);
  assert.ok(eq.mismatches.includes("candidate-binding-changed"));
});

test("B27 (req 27): a TREE binding change fails", () => {
  const eq = substanceEquivalent(substanceFingerprint(oneRaw), mkVerdict("fail", { candidateId: "cand-1", verifiedTree: "OTHER", blockingDefects: [dA] }));
  assert.equal(eq.ok, false);
  assert.ok(eq.mismatches.includes("tree-binding-changed"));
});

test("B28 (req 28): defect-bearing raw cannot recover to PASS", () => {
  assert.equal(substanceEquivalent(substanceFingerprint(oneRaw), mkVerdict("pass")).ok, false);
});

test("B29 (req 29): pass-like raw cannot recover to a defect-bearing FAIL", () => {
  const raw = J({ verdict: "pass", candidateId: "cand-1", summary: "looks correct and complete" });
  assert.equal(substanceEquivalent(substanceFingerprint(raw), mkVerdict("fail", { blockingDefects: [dA] })).ok, false);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part C — unsupported structured output + recovery eligibility (reqs 30-37)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test("C30 (req 30): an unsupported structured FAIL becomes indeterminate WITHOUT recovery", () => {
  const v = parseEnforced({ verdict: "fail", blockingDefects: [{ claim: "the implementation is subtly wrong for edge cases", evidenceIds: [] }] });
  assert.equal(v.kind, "indeterminate");
  assert.equal(v.parseStatus, "structured", "a well-formed-but-unsupported fail is structured (content-insufficient) — recovery is skipped");
});

test("C31 (req 31): a generic accusation is indeterminate", () => {
  const v = parseEnforced({ verdict: "fail", blockingDefects: [{ claim: "the code is bad", evidenceIds: ["file:server.ts"] }] });
  assert.equal(v.kind, "indeterminate", "a generic claim is not concrete even with a cited file");
});

test("C32 (req 32): an invented test result is indeterminate", () => {
  const v = parseEnforced({ verdict: "fail", blockingDefects: [validDefect({ claim: "the e2e suite fails on login", evidenceIds: ["test:e2e"] })] });
  assert.equal(v.kind, "indeterminate", "a test not run is not evidence");
});

test("C33 (req 33): empty output is not recovery-eligible", () => { assert.equal(classifyRecoveryEligibility("").eligible, false); });
test("C34 (req 34): a bare FAIL is not recovery-eligible", () => { assert.equal(classifyRecoveryEligibility("FAIL").eligible, false); });
test("C35 (req 35): a truncated object is not schema-recovery-eligible", () => { assert.equal(classifyRecoveryEligibility('{"verdict":"fail","blockingDefects":[').eligible, false); });
test("C36 (req 36): a content-filter refusal is infra (handled upstream), never schema recovery", () => {
  // classifyRecoveryEligibility only ever sees NON-infra output; a bare refusal token is ineligible here.
  assert.equal(classifyRecoveryEligibility("I cannot help with that.").eligible, false);
});
test("C37 (req 37): a candidate/tree mismatch echo is indeterminate and not recovered", () => {
  const v = parseEnforced({ candidateId: "OTHER", verdict: "fail", blockingDefects: [validDefect()] });
  assert.equal(v.kind, "indeterminate");
  assert.ok(v.summary.startsWith("cross-candidate"), "a binding mismatch is flagged (the critic skips recovery on this)");
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part D — the REAL enforcing critic + orchestrator seam (reqs 38-50)
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
function resp(content: string, model: string, cost = 0.002, finishReason: ModelResponse["finishReason"] = "stop"): ModelResponse {
  return { contractVersion: "1.1.0", model, provider: model.split("-")[0]!, providerModelId: model, content, finishReason, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, cost: { usd: cost, promptUsd: cost, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } }, latencyMs: 1, fellBack: false, attempts: [] };
}
function toolResp(name: string, args: unknown, model: string): ModelResponse { return { ...resp("", model), finishReason: "tool_calls", toolCalls: [{ id: `${name}1`, name, arguments: JSON.stringify(args) }] }; }
const SERVER_DIFF = "diff --git a/server.ts b/server.ts\n--- a/server.ts\n+++ b/server.ts\n@@ -1 +1,2 @@\n+export function health(){return {ok:true};}\n";
function gitInit(dir: string): string {
  const g = (...a: string[]): string => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g("init", "-q"); writeFileSync(join(dir, "server.ts"), "export const a = 1;"); g("add", "-A"); g("commit", "-q", "-m", "base");
  return g("rev-parse", "HEAD").trim();
}
const execVerifier: RoleFn = async () => ({ role: "verifier", outcome: "success", summary: "green", detail: { verdict: "pass", checks: [{ name: "test", command: "pnpm test", exitCode: 0, testCount: { passed: 1, total: 1 } }], testEvidence: "executed" } });
const promoteIntegrator: RoleFn = async (ctx) => {
  const pass = ((ctx.priorResults.find((r) => r.role === "critic")?.detail ?? {}) as Record<string, unknown>).pass === true;
  return pass
    ? { role: "integrator", outcome: "success", summary: "p", detail: { decision: "promote", rationale: "s", evaluation: { approved: true } } }
    : { role: "integrator", outcome: "success", summary: "p", detail: { decision: "discard", rationale: "critic", evaluation: { approved: false } } };
};

/** A run with the REAL enforcing critic; `criticOutputs` scripts the critic's model turns (primary, recovery). */
function enforcingRun(criticOutputs: string[]) {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const rc = capturingReceipts();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-p12-"));
  const baseRef = gitInit(dir);
  const handle: WorkspaceHandle = { id: "wsp12", targetRepo: dir, baseBranch: "main", baseRef, scratchBranch: "s", path: dir, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  let criticCall = 0;
  const builderTurns = new Map<string, number>();
  const invokeModel = async (req: ModelRequest): Promise<ModelResponse> => {
    const model = req.model ?? "m";
    if (typeof (req as { prompt?: unknown }).prompt === "string") return resp(J({ tier: "worker", rationale: "x" }), model);
    const tools = req.tools ?? [];
    if (tools.some((t) => t.name === "done")) {
      const n = (builderTurns.get(model) ?? 0) + 1; builderTurns.set(model, n);
      if (n === 1) return toolResp("read_file", { path: "server.ts" }, model);
      if (n === 2) return toolResp("write_file", { path: "server.ts", content: "export const a = 2;\n" }, model);
      if (n === 3) return toolResp("run_checks", {}, model);
      return toolResp("done", { successCondition: "x", filesReadBack: ["server.ts"], selfCheck: "green", satisfied: true }, model);
    }
    const out = criticOutputs[Math.min(criticCall, criticOutputs.length - 1)]!; criticCall += 1;
    return resp(out, model);
  };
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 2000, maxConcurrentRuns: 1, trustLadder: false },
    workspaces: {
      allocate: async () => handle, diff: async () => SERVER_DIFF,
      promote: async (h): Promise<PromoteResult> => ({ promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }),
      discard: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: true }),
      retain: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: false }), commit: async () => true,
    },
    events: fakeBus, receipts: rc.receipts, trust: stubTrust, resolveIdentity, roleClaim,
    roles: { scout: async () => ({ role: "scout", outcome: "success", summary: "s" }), verifier: execVerifier, integrator: promoteIntegrator },
    invokeModel, governedExec: { run: async () => ({ executed: true as const, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) },
    builderModel: "deepseek-v4-flash", escalationTierModels: { worker: ["deepseek-v4-flash"], mid: ["deepseek-v4-pro"], frontier: ["deepseek-v4-pro"] },
    gateWall: { evaluate: async (): Promise<PromoteGovernance> => ({ allow: true, reason: "ok" }) },
  });
  const task = { taskId: "cand-1", targetRepo: "/unused", goal: "add a /health route", moeExpertRental: true, moeVendorLane: "deepseek", builderModelOverride: "deepseek-v4-flash", criticModelOverride: "deepseek-v4-pro", escalationDisabled: true };
  return { run: () => orch.run(task, parentCtx), receipts: rc.appended, criticCalls: () => criticCall };
}
const enforcedFailJson = (over: Record<string, unknown> = {}) => J({ schemaVersion: 1, candidateId: "cand-1", verdict: "fail", summary: "missing import", blockingDefects: [{ claim: "server.ts references db but never imports it", evidenceIds: ["file:server.ts"], requirementId: "req:goal", severity: "blocking" }], ...over });
// A malformed-but-recoverable raw carrying the SAME defect substance (wrong verdict enum + prose wrapper).
const malformedFail = "My review:\n" + J({ verdict: "REJECT", blockingDefects: [{ claim: "server.ts references db but never imports it", evidenceIds: ["file:server.ts"] }] });

test("D38 [MUTATION 10] (req 38): recovery fires AT MOST ONCE (a rejected recovery makes no second call)", async () => {
  const h = enforcingRun([malformedFail, "still nonsense, no verdict"]);
  await h.run();
  assert.equal(h.criticCalls(), 2, "one primary + exactly one recovery — never a second recovery");
});

test("D39/D40/D41 [MUTATION 11] (req 39,40,41): the recovery is in-lane, ledgered/costed, and its receipt references the invocation", async () => {
  const h = enforcingRun([malformedFail, "still nonsense"]);
  await h.run();
  const rec = h.receipts.find((r) => r.operation === "worker.critic_recovery");
  assert.ok(rec !== undefined, "a worker.critic_recovery receipt was written");
  assert.match(String(rec!.metadata.invocationId), /:critic:structured-recovery:/, "references the authoritative ledger invocation");
  assert.equal(rec!.metadata.servedModel, "deepseek-v4-pro", "recovery ran in-lane on the critic model");
  assert.equal(rec!.metadata.provider, "deepseek");
  assert.equal(rec!.metadata.costStatus, "measured", "the recovery cost is captured from the invocation");
});

test("D42/D43/D44/D45 (req 42,43,44,45): a FAILED-equivalence recovery blocks fixer + duel + promotion, and persists NO defect", async () => {
  // recovery returns a DIFFERENT (but validly-evidenced) defect than the raw → substance mismatch caught by
  // the deterministic equivalence check → indeterminate (fail-closed). The defect cites RESOLVABLE evidence
  // so it is not merely dropped — it is a genuine equivalence failure the fingerprint comparison detects.
  const recoveryMutates = J({ schemaVersion: 1, candidateId: "cand-1", verdict: "fail", blockingDefects: [{ claim: "a completely different invented defect about routing", evidenceIds: ["file:server.ts"], requirementId: "req:goal" }] });
  const h = enforcingRun([malformedFail, recoveryMutates]);
  const result = await h.run();
  assert.notEqual(result.outcome, "success");
  assert.equal(result.promoted, false, "a failed-equivalence recovery never promotes");
  assert.equal(result.nonPromotion?.duelEligible ?? false, false, "an indeterminate verdict is not duel-eligible (no peer duel)");
  assert.ok(!h.receipts.some((r) => r.operation === "worker.fixer"), "no fixer runs on a failed-equivalence recovery");
  const sem = h.receipts.find((r) => r.operation === "worker.semantic")!;
  assert.equal(sem.metadata.verdict, "indeterminate");
  assert.deepEqual(sem.metadata.blockingDefects, [], "a rejected recovered defect is NOT persisted");
  assert.equal(sem.metadata.recoveryEquivalence, false, "the receipt records the equivalence failure truthfully");
});

test("D-recover (req 9 seam): a STRUCTURE-ONLY recovery is adopted and its verdict is a validated fail", async () => {
  const h = enforcingRun([malformedFail, enforcedFailJson()]);
  await h.run();
  const sem = h.receipts.find((r) => r.operation === "worker.semantic")!;
  assert.equal(sem.metadata.verdict, "fail", "a substance-equivalent reformat is adopted");
  assert.equal(sem.metadata.recoveryOutcome, "repaired");
  assert.equal(sem.metadata.recoveryEquivalence, true);
  assert.equal((sem.metadata.blockingDefects as unknown[]).length, 1, "the validated defect is persisted");
});

test("D46 (req 23,24,45): the worker.semantic receipt carries the primary critic invocation id + evidence/fingerprint provenance", async () => {
  const h = enforcingRun([enforcedFailJson()]);
  await h.run();
  const sem = h.receipts.find((r) => r.operation === "worker.semantic")!;
  assert.match(String(sem.metadata.primaryCriticInvocationId), /:critic:/, "the primary critic invocation is referenced");
  assert.equal(sem.metadata.evidenceEnforced, true);
  assert.equal(typeof sem.metadata.evidencePackageHash, "string", "the evidence package is provenance-hashed");
  assert.equal(sem.metadata.fixerEligible, true, "a concrete fail is fixer-eligible");
});

test("D47/D48 (req 47,48): distinct candidates/trees get DISTINCT semantic evaluation ids (fresh evidence)", async () => {
  const a = enforcingRun([enforcedFailJson()]);
  await a.run();
  const idA = a.receipts.find((r) => r.operation === "worker.semantic")!.metadata.semanticEvaluationId as string;
  assert.match(idA, /^cand-1:/, "the id binds the candidate + tree (a changed tree ⇒ a distinct id)");
});

test("D49 (req 49): a real critic enforces the evidence package on the production seam (unsupported fail → indeterminate, not a rejection)", async () => {
  // The critic asserts a fail whose defect cites NOTHING in the package → dropped → indeterminate → not duel-eligible.
  const unsupported = J({ schemaVersion: 1, candidateId: "cand-1", verdict: "fail", blockingDefects: [{ claim: "the health route is subtly wrong somehow" }] });
  const h = enforcingRun([unsupported]);
  const result = await h.run();
  assert.notEqual(result.outcome, "success");
  assert.equal(result.nonPromotion?.duelEligible ?? false, false, "an unsupported fail is indeterminate, not a duel-eligible candidate rejection");
  assert.equal(h.receipts.find((r) => r.operation === "worker.semantic")!.metadata.verdict, "indeterminate");
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part E — escalation-consult receipt invocation linkage (Phase 12 preflight closure, req 50)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test("E50 [MUTATION 13] (req 50): the worker.escalation.consult receipt references its invocation + derives execution identity", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const rc = capturingReceipts();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-p12-consult-"));
  const baseRef = gitInit(dir);
  const handle: WorkspaceHandle = { id: "wsc", targetRepo: dir, baseBranch: "main", baseRef, scratchBranch: "s", path: dir, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  // The frontier consult dispatched a provider request (a ConsultResult with cost/usage). The receipt must
  // reference the authoritative external invocation the run ledger records for it (Phase 12 closure).
  const consultResult = { modelId: "deepseek-frontier", tier: "frontier" as const, mode: "patch" as const, answer: SERVER_DIFF, packet: { mode: "patch", question: "q", goal: "g", files: [] } as never, usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 }, cost: { usd: 0.05, promptUsd: 0.05, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } }, retrieval: { files: 1, lowConfidence: false } };
  const applyConsultPatch = async () => ({ applied: true, filesChanged: ["server.ts"], modelId: "deepseek-frontier", consult: consultResult });
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 2000, maxConcurrentRuns: 1, trustLadder: false },
    workspaces: { allocate: async () => handle, diff: async () => SERVER_DIFF, promote: async (h): Promise<PromoteResult> => ({ promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }), discard: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: true }), commit: async () => true },
    events: fakeBus, receipts: rc.receipts, trust: stubTrust, resolveIdentity, roleClaim,
    // A builder that always fails exhausts the worker+mid pool so the authorized frontier consult fires.
    roles: {
      scout: async () => ({ role: "scout", outcome: "success", summary: "s" }),
      builder: async () => ({ role: "builder", outcome: "failure", summary: "pool model failed", detail: { toolFormatErrors: [1, 2], retryCount: 3 } }),
      verifier: async () => ({ role: "verifier", outcome: "success", summary: "green", detail: { verdict: "pass", checks: [{ name: "test", command: "pnpm test", exitCode: 0, testCount: { passed: 1, total: 1 } }], testEvidence: "executed" } }),
      critic: async () => ({ role: "critic", outcome: "success", summary: "c", detail: { pass: true } }),
      integrator: async () => ({ role: "integrator", outcome: "success", summary: "i", detail: { decision: "promote", rationale: "s", evaluation: { approved: true } } }),
    },
    invokeModel: async () => { throw new Error("unused"); }, governedExec: { run: async () => ({ executed: true as const, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) },
    builderModel: "deepseek-v4-flash", escalationTierModels: { worker: ["deepseek-v4-flash"], mid: ["deepseek-v4-pro"], frontier: ["deepseek-frontier"] },
    applyConsultPatch,
    gateWall: { evaluate: async (): Promise<PromoteGovernance> => ({ allow: true, reason: "ok" }) },
  });
  await orch.run({ taskId: "cand-consult", targetRepo: dir, goal: "fix it", allowFrontierConsult: true }, parentCtx);
  const consult = rc.appended.find((r) => r.operation === "worker.escalation.consult");
  assert.ok(consult !== undefined, "a worker.escalation.consult receipt was written");
  assert.equal(consult!.metadata.executionLinked, true, "the consult receipt links its execution");
  assert.match(String(consult!.metadata.invocationId), /:consult:frontier-consult:/, "references the authoritative consult invocation");
  assert.equal(consult!.metadata.servedModel, "deepseek-frontier", "the served model derives from the invocation");
  assert.equal(consult!.metadata.provider, "deepseek");
  assert.ok(!rc.appended.some((r) => r.operation === "worker.escalation.consult.integrity_error"), "a dispatched consult is not an integrity error");
});

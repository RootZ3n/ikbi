/**
 * PHASE 15 — EVIDENCE RELEVANCE: a blocking defect must cite evidence that can ACTUALLY SUPPORT it.
 *
 * Closes IKBI-REAUDIT2-005 (an unrelated/stylistic criticism became a concrete blocker by citing the generic
 * candidate/tree anchor + any nonempty requirement) and -006 (structured recovery could FILL an omitted
 * requirement association / repairability without rejection).
 *
 * The central invariant: an evidence ID is not authoritative merely because it exists. Its authority CLASS,
 * scope, result, and requirement relationship must be capable of supporting the asserted defect category.
 *   - a candidate / tree anchor proves IDENTITY only (contextual) — never a blocker;
 *   - a blocking defect needs a substantive OBSERVATION whose type supports its declared category;
 *   - a `*-failure` needs a check that actually FAILED; a style defect needs an explicit style policy;
 *   - recovery may restructure, never SUPPLY a decision-bearing field (requirement id / repairability / category);
 *   - a decision-bearing semantic evaluation WITHOUT a typed evidence package is indeterminate for decisions.
 *
 * Tests 1-46 exercise the PURE primitives; 47-50 drive the REAL enforcing critic + orchestrator seam. 51-52
 * (all Phase 1-14B suites green + the 111/111 production probe) are the external validation matrix (handoff).
 * Several tests double as MUTATION GUARDS — see HANDOFF-PHASE-15-EVIDENCE-RELEVANCE.md.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { labTempDir as tmpdir } from "../../core/temp-root.js";
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
import {
  parseSemanticVerdict, effectiveDecisionKind, semanticDuelEligible, semanticPromotionEligible,
  type SemanticVerdict, type BlockingDefect,
} from "./semantic-verdict.js";
import {
  buildEvidencePackage, substanceFingerprint, substanceEquivalent, validateDefectEvidence,
  authorityClassOfId, kindOfEvidenceId, AUTHORITY_CLASS_OF_KIND, type EvidencePackage,
} from "./semantic-evidence.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import type { RoleFn } from "./contract.js";

const GOAL = "add a /users route that returns the user list";
/** Whole-goal package (no explicit criteria) — the mode the tabs/candidate-anchor findings exploited. */
function pkg(over: Partial<Parameters<typeof buildEvidencePackage>[0]> = {}): EvidencePackage {
  return buildEvidencePackage({
    candidateId: "cand-1", verifiedTree: "TREE1", goal: GOAL,
    changedFiles: ["server.ts", "users.ts"], checks: [{ name: "typecheck", passed: true }, { name: "test", isTest: true, passed: true }],
    runtimeEvidenceIds: ["rt-1"], ...over,
  });
}
const J = (o: unknown) => JSON.stringify(o);
function parseEnforced(o: unknown, p: EvidencePackage = pkg(), ctxOver: Record<string, unknown> = {}): SemanticVerdict {
  return parseSemanticVerdict(J(o), { candidateId: p.candidateId, ...(p.verifiedTree !== undefined ? { verifiedTree: p.verifiedTree } : {}), goal: GOAL, evidencePackage: p, ...ctxOver });
}
/** A concrete, substantively-supported file-content defect (the control for "supported"). */
const supported = (over: Record<string, unknown> = {}) => ({ claim: "server.ts references db but never imports it — ReferenceError", category: "file-content-mismatch", evidenceIds: ["file:server.ts"], requirementId: "req:goal", ...over });
function mkDefect(claim: string, evidenceIds: string[], over: Partial<BlockingDefect> = {}): BlockingDefect {
  return { id: "d1", claim, evidence: claim, requirement: "req", severity: "blocking", confidence: 0.9, evidenceIds, ...over };
}
function mkVerdict(kind: SemanticVerdict["kind"], over: Partial<SemanticVerdict> = {}): SemanticVerdict {
  return { kind, summary: "s", blockingDefects: [], incompleteRequirements: [], advisories: [], parseStatus: "repaired", ...over };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part A — evidence authority classes + contextual anchors (reqs 1-10)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test("1 [MUT: candidate anchor allowed as substantive]: the candidate anchor is CONTEXTUAL identity only", () => {
  assert.equal(authorityClassOfId("candidate"), "contextual-identity");
  assert.equal(AUTHORITY_CLASS_OF_KIND[kindOfEvidenceId("candidate")!], "contextual-identity");
});

test("2: the snapshot/tree anchor is CONTEXTUAL identity only", () => {
  assert.equal(authorityClassOfId("tree"), "contextual-identity");
  assert.equal(authorityClassOfId("file:server.ts"), "observation", "a changed-file the critic saw is a scoped observation");
  assert.equal(authorityClassOfId("req:goal"), "requirement");
  assert.equal(authorityClassOfId("runtime:rt-1"), "runtime-fact");
});

test("3 [MUT: candidate anchor allowed as substantive]: a defect citing ONLY the candidate anchor cannot support a blocker", () => {
  const v = parseEnforced({ verdict: "fail", blockingDefects: [{ claim: "the users route is subtly incomplete here", evidenceIds: ["candidate"], requirementId: "req:goal" }] });
  assert.equal(v.kind, "indeterminate", "candidate-anchor-only is contextual, not substantive support");
  assert.equal(validateDefectEvidence({ claim: "x", evidenceIds: ["candidate"], requirementId: "req:goal" }, pkg()).reason, "defect-cites-only-contextual-evidence");
});

test("4: a defect citing candidate PLUS tree (both contextual) still cannot support a blocker", () => {
  const v = parseEnforced({ verdict: "fail", blockingDefects: [{ claim: "the route handler is not wired correctly", evidenceIds: ["candidate", "tree"], requirementId: "req:goal" }] });
  assert.equal(v.kind, "indeterminate");
});

test("5: a requirement id ALONE (no observation) cannot prove a violation", () => {
  const v = validateDefectEvidence({ claim: "the users route is wrong", evidenceIds: ["req:goal"], requirementId: "req:goal" }, pkg());
  assert.equal(v.valid, false, "a requirement proves something is required, not that the candidate violates it");
});

test("6 [MUT: whole-goal restored as requirement fallback]: a generic whole-goal fallback + candidate anchor is rejected", () => {
  const v = parseEnforced({ verdict: "fail", blockingDefects: [{ claim: "server.ts must use tabs instead of spaces", evidenceIds: ["candidate"], requirement: "must use tabs" }] });
  assert.equal(v.kind, "indeterminate", "arbitrary requirement text + candidate anchor is not a blocker");
});

test("7: an explicit acceptance criterion CAN serve as requirement authority (control, with an observation)", () => {
  const p = pkg({ acceptanceCriteria: ["the /users route returns the list", "responses are JSON"] });
  const v = parseEnforced({ verdict: "fail", blockingDefects: [supported({ requirementId: "req:0" })] }, p);
  assert.equal(v.kind, "fail");
  assert.equal(v.blockingDefects[0]!.requirementId, "req:0");
});

test("8 [MUT: style preference blocking without policy]: a style preference without explicit requirement is unsupported", () => {
  const v = parseEnforced({ verdict: "fail", blockingDefects: [{ claim: "the class name should be UserController not Users", category: "explicit-style-policy-violation", evidenceIds: ["candidate", "file:server.ts"], requirement: "naming convention" }] });
  assert.equal(v.kind, "indeterminate", "a naming/style preference with no explicit style policy is advisory, not blocking");
});

test("9 [MUT: style preference blocking without policy]: 'tabs required' citing only the candidate anchor becomes indeterminate", () => {
  // The exact IKBI-REAUDIT2-005 reproduction.
  const v = parseEnforced({ verdict: "fail", blockingDefects: [{ claim: "server.ts must use tabs instead of spaces", category: "explicit-style-policy-violation", evidenceIds: ["candidate"], requirement: "must use tabs" }] });
  assert.equal(v.kind, "indeterminate");
  assert.equal(v.blockingDefects.length, 0);
});

test("10: an explicit tabs policy + a FAILED formatter check CAN block", () => {
  const p = pkg({ acceptanceCriteria: ["source files use tabs for indentation"], checks: [{ name: "fmt", passed: false }, { name: "test", isTest: true, passed: true }] });
  const v = parseEnforced({ verdict: "fail", blockingDefects: [{ claim: "server.ts uses spaces; the fmt check fails the tabs policy", category: "explicit-style-policy-violation", evidenceIds: ["check:fmt"], requirementId: "req:0" }] }, p);
  assert.equal(v.kind, "fail", "an explicit style criterion + a failed formatter check is a real blocker");
  assert.equal(v.blockingDefects[0]!.supportKind, "explicit-style-criterion");
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part B — typed defect categories + deterministic support matrix (reqs 11-18)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test("11: an executed-test-failure requires an ACTUAL failed test", () => {
  const p = pkg({ checks: [{ name: "test", isTest: true, passed: false }] });
  const v = parseEnforced({ verdict: "fail", blockingDefects: [{ claim: "the users test asserts 200 but the route returns 500", category: "executed-test-failure", evidenceIds: ["test:test"], requirementId: "req:goal" }] }, p);
  assert.equal(v.kind, "fail", "a cited FAILED test supports an executed-test-failure");
});

test("12 [MUT: passing test supports a failure]: a PASSING test cannot support a test-failure defect", () => {
  const p = pkg({ checks: [{ name: "test", isTest: true, passed: true }] });
  const v = parseEnforced({ verdict: "fail", blockingDefects: [{ claim: "the users test asserts 200 but the route returns 500", category: "executed-test-failure", evidenceIds: ["test:test"], requirementId: "req:goal" }] }, p);
  assert.equal(v.kind, "indeterminate", "a green test cannot evidence a test failure");
  assert.equal(validateDefectEvidence({ claim: "x", category: "executed-test-failure", evidenceIds: ["test:test"], requirementId: "req:goal" }, p).reason, "defect-cites-no-failed-check");
});

test("13: a deterministic-check-failure requires a FAILED check", () => {
  const p = pkg({ checks: [{ name: "typecheck", passed: false }, { name: "test", isTest: true, passed: true }] });
  const ok = parseEnforced({ verdict: "fail", blockingDefects: [{ claim: "typecheck fails: users.ts has a type error on the return", category: "deterministic-check-failure", evidenceIds: ["check:typecheck"], requirementId: "req:goal" }] }, p);
  assert.equal(ok.kind, "fail");
  const green = pkg({ checks: [{ name: "typecheck", passed: true }] });
  const bad = parseEnforced({ verdict: "fail", blockingDefects: [{ claim: "typecheck fails: users.ts has a type error on the return", category: "deterministic-check-failure", evidenceIds: ["check:typecheck"], requirementId: "req:goal" }] }, green);
  assert.equal(bad.kind, "indeterminate", "a passing check cannot support a check-failure");
});

test("14: an api-contract-mismatch requires a contract requirement + matching API/observation evidence", () => {
  const p = pkg({ acceptanceCriteria: ["the route matches the OpenAPI users schema"], apiContractIds: ["users-schema"] });
  const v = parseEnforced({ verdict: "fail", blockingDefects: [{ claim: "the response omits the required 'email' field from the users schema", category: "api-contract-mismatch", evidenceIds: ["api:users-schema"], requirementId: "req:0" }] }, p);
  assert.equal(v.kind, "fail");
  const noObs = validateDefectEvidence({ claim: "x", category: "api-contract-mismatch", evidenceIds: ["candidate"], requirementId: "req:0" }, p);
  assert.equal(noObs.valid, false, "an api mismatch with no api/file observation is unsupported");
});

test("15: a file-content-mismatch requires matching file/diff observation", () => {
  const ok = parseEnforced({ verdict: "fail", blockingDefects: [supported()] });
  assert.equal(ok.kind, "fail");
  const noObs = validateDefectEvidence({ claim: "server.ts is wrong about the import", category: "file-content-mismatch", evidenceIds: ["candidate", "req:goal"], requirementId: "req:goal" }, pkg());
  assert.equal(noObs.valid, false, "no file/diff observation → unsupported");
});

test("16: a missing-file-or-symbol defect requires structured ABSENCE evidence (failed check or named criterion)", () => {
  const p = pkg({ acceptanceCriteria: ["a users.ts module exports listUsers"], changedFiles: ["server.ts"] });
  const ok = parseEnforced({ verdict: "fail", blockingDefects: [{ claim: "the required users.ts module was never created", category: "missing-file-or-symbol", evidenceIds: ["file:server.ts"], requirementId: "req:0" }] }, p);
  assert.equal(ok.kind, "fail", "a named criterion for the missing output + an observation supports absence");
  const bare = validateDefectEvidence({ claim: "users.ts is missing", category: "missing-file-or-symbol", evidenceIds: ["file:server.ts"], requirementId: "req:goal" }, pkg({ changedFiles: ["server.ts"] }));
  assert.equal(bare.valid, false, "a generic file list + whole-goal cannot prove a specific file is absent");
});

test("17: a runtime-compatibility-conflict requires a requirement + a runtime fact + a candidate observation", () => {
  const p = pkg({ acceptanceCriteria: ["must run on the installed Node 18"], runtimeEvidenceIds: ["node-18"], changedFiles: ["server.ts"] });
  const v = parseEnforced({ verdict: "fail", blockingDefects: [{ claim: "server.ts uses Array.fromAsync which is unavailable on the installed Node 18", category: "runtime-compatibility-conflict", evidenceIds: ["runtime:node-18", "file:server.ts"], requirementId: "req:0" }] }, p);
  assert.equal(v.kind, "fail");
  const noRuntime = validateDefectEvidence({ claim: "x", category: "runtime-compatibility-conflict", evidenceIds: ["file:server.ts"], requirementId: "req:0" }, p);
  assert.equal(noRuntime.valid, false, "a runtime conflict without the runtime fact is unsupported");
});

test("18: an advisory-class runtime fact cannot be the SOLE support for a default blocker", () => {
  const v = validateDefectEvidence({ claim: "the environment might be slow under load", evidenceIds: ["runtime:rt-1"], requirementId: "req:goal" }, pkg());
  assert.equal(v.valid, false, "a runtime fact alone is advisory — not a substantive observation for a default defect");
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part C — evidence scope (reqs 19-24)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test("19: evidence from ANOTHER candidate (candidateId echo mismatch) is rejected", () => {
  const v = parseEnforced({ candidateId: "OTHER-CAND", verdict: "fail", blockingDefects: [supported()] });
  assert.equal(v.kind, "indeterminate");
});

test("20 [MUT: evidence scope checking removed]: evidence from ANOTHER snapshot (tree echo mismatch) is rejected", () => {
  const v = parseEnforced({ verifiedTree: "OTHER-TREE", verdict: "fail", blockingDefects: [supported()] });
  assert.equal(v.kind, "indeterminate");
});

test("21: evidence naming a file NOT in the package is rejected", () => {
  const v = parseEnforced({ verdict: "fail", blockingDefects: [supported({ evidenceIds: ["file:never-shown.ts"] })] });
  assert.equal(v.kind, "indeterminate");
});

test("22: an UNKNOWN evidence id is rejected", () => {
  assert.equal(validateDefectEvidence({ claim: "x", evidenceIds: ["totally-made-up"], requirementId: "req:goal" }, pkg()).valid, false);
});

test("23: STALE evidence (a check name not in the package) is rejected", () => {
  const v = parseEnforced({ verdict: "fail", blockingDefects: [supported({ category: "deterministic-check-failure", evidenceIds: ["check:lint-removed"] })] });
  assert.equal(v.kind, "indeterminate");
});

test("24: evidence NOT supplied to the critic (an id absent from the package) is rejected", () => {
  const v = validateDefectEvidence({ claim: "x", category: "file-content-mismatch", evidenceIds: ["diff:secret.ts"], requirementId: "req:goal" }, pkg());
  assert.equal(v.valid, false, "a diff for a file never shown does not resolve");
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part D — unsupported structured output → indeterminate (reqs 25-28)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test("25: unsupported structured JSON becomes indeterminate (and records the rejection reason)", () => {
  const v = parseEnforced({ verdict: "fail", blockingDefects: [{ claim: "the users route mishandles empty results here", evidenceIds: ["candidate"], requirementId: "req:goal" }] });
  assert.equal(v.kind, "indeterminate");
  assert.ok((v.rejectedDefects ?? []).some((r) => r.reason === "defect-cites-only-contextual-evidence"));
});

test("26 [MUT: unsupported defect authorizes decisions]: a FAIL with ONLY unsupported defects becomes indeterminate", () => {
  const v = parseEnforced({ verdict: "fail", blockingDefects: [{ claim: "wrong somehow", evidenceIds: ["candidate"] }, { claim: "also wrong", evidenceIds: ["tree"] }] });
  assert.equal(v.kind, "indeterminate");
  assert.equal(v.blockingDefects.length, 0);
});

test("27: an INCOMPLETE without supported absence evidence becomes indeterminate", () => {
  const v = parseEnforced({ verdict: "incomplete", missingRequirements: [] });
  assert.equal(v.kind, "indeterminate", "incomplete with no concrete missing requirement is indeterminate");
});

test("28: a PASS that also lists a concrete blocking claim is contradictory → indeterminate", () => {
  const v = parseEnforced({ verdict: "pass", blockingDefects: [{ claim: "server.ts references db but never imports it — ReferenceError", evidenceIds: ["file:server.ts"] }] });
  assert.equal(v.kind, "indeterminate", "verdict=pass with a listed blocker is self-inconsistent");
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part E — recovery field-presence preservation (reqs 29-37)
// ════════════════════════════════════════════════════════════════════════════════════════════════

const rawFail = (defects: unknown[], over: Record<string, unknown> = {}) => J({ verdict: "fail", candidateId: "cand-1", verifiedTree: "TREE1", blockingDefects: defects, ...over });

test("29 [MUT: recovery adds requirement association]: recovery cannot ADD a specific requirement id", () => {
  const raw = rawFail([{ claim: "db is used but never imported", evidenceIds: ["file:server.ts"] }]);
  const recovered = mkVerdict("fail", { candidateId: "cand-1", verifiedTree: "TREE1", blockingDefects: [mkDefect("db is used but never imported", ["file:server.ts"], { requirementId: "req:0" })] });
  const eq = substanceEquivalent(substanceFingerprint(raw), recovered);
  assert.equal(eq.ok, false);
  assert.ok(eq.mismatches.includes("requirement-id-added"));
});

test("30 [MUT: recovery adds requirement association]: recovery cannot CHANGE a requirement id", () => {
  const raw = rawFail([{ claim: "db is used but never imported", evidenceIds: ["file:server.ts"], requirementId: "req:0" }]);
  const recovered = mkVerdict("fail", { candidateId: "cand-1", verifiedTree: "TREE1", blockingDefects: [mkDefect("db is used but never imported", ["file:server.ts"], { requirementId: "req:1" })] });
  const eq = substanceEquivalent(substanceFingerprint(raw), recovered);
  assert.equal(eq.ok, false);
  assert.ok(eq.mismatches.includes("requirement-id-changed"));
});

test("31 [MUT: recovery fills omitted repairability]: recovery cannot ADD an omitted repairability", () => {
  const raw = rawFail([{ claim: "db is used but never imported", evidenceIds: ["file:server.ts"] }]);
  const recovered = mkVerdict("fail", { candidateId: "cand-1", verifiedTree: "TREE1", blockingDefects: [mkDefect("db is used but never imported", ["file:server.ts"], { repairable: true })] });
  const eq = substanceEquivalent(substanceFingerprint(raw), recovered);
  assert.equal(eq.ok, false);
  assert.ok(eq.mismatches.includes("repairability-added"));
});

test("32: recovery cannot REMOVE a stated repairability", () => {
  const raw = rawFail([{ claim: "db is used but never imported", evidenceIds: ["file:server.ts"], repairable: false }]);
  const recovered = mkVerdict("fail", { candidateId: "cand-1", verifiedTree: "TREE1", blockingDefects: [mkDefect("db is used but never imported", ["file:server.ts"])] });
  const eq = substanceEquivalent(substanceFingerprint(raw), recovered);
  assert.equal(eq.ok, false);
  assert.ok(eq.mismatches.includes("repairability-removed"));
});

test("33: recovery cannot FLIP repairability", () => {
  const raw = rawFail([{ claim: "db is used but never imported", evidenceIds: ["file:server.ts"], repairable: false }]);
  const recovered = mkVerdict("fail", { candidateId: "cand-1", verifiedTree: "TREE1", blockingDefects: [mkDefect("db is used but never imported", ["file:server.ts"], { repairable: true })] });
  const eq = substanceEquivalent(substanceFingerprint(raw), recovered);
  assert.equal(eq.ok, false);
  assert.ok(eq.mismatches.includes("repairability-changed"));
});

test("34: recovery cannot ADD a defect category", () => {
  const raw = rawFail([{ claim: "db is used but never imported", evidenceIds: ["file:server.ts"] }]);
  const recovered = mkVerdict("fail", { candidateId: "cand-1", verifiedTree: "TREE1", blockingDefects: [mkDefect("db is used but never imported", ["file:server.ts"], { category: "executed-test-failure" })] });
  const eq = substanceEquivalent(substanceFingerprint(raw), recovered);
  assert.equal(eq.ok, false);
  assert.ok(eq.mismatches.includes("category-added"));
});

test("35: recovery cannot introduce evidence authority (an added evidence id is caught)", () => {
  const raw = rawFail([{ claim: "db is used but never imported", evidenceIds: ["file:server.ts"] }]);
  const recovered = mkVerdict("fail", { candidateId: "cand-1", verifiedTree: "TREE1", blockingDefects: [mkDefect("db is used but never imported", ["file:server.ts", "check:typecheck"])] });
  const eq = substanceEquivalent(substanceFingerprint(raw), recovered);
  assert.equal(eq.ok, false);
  assert.ok(eq.mismatches.includes("evidence-added"), "recovery cannot add an evidence id to change the authority");
});

test("36 [MUT: insufficiency sent to recovery]: evidentiary insufficiency yields a STRUCTURED indeterminate (recovery is not invoked)", () => {
  // A well-formed fail whose defects are all unsupported → dropped → indeterminate with parseStatus 'structured'.
  // The critic only invokes recovery for parseStatus 'unparsable', so this content-insufficiency never recovers.
  const v = parseEnforced({ verdict: "fail", blockingDefects: [{ claim: "the users route is subtly wrong for empty input", evidenceIds: ["candidate"], requirementId: "req:goal" }] });
  assert.equal(v.kind, "indeterminate");
  assert.equal(v.parseStatus, "structured", "content-insufficiency is not a structural parse failure → no recovery call");
});

test("37: the field-presence fingerprint catches an omitted-then-filled requirement id even when free text matches", () => {
  const raw = rawFail([{ claim: "db is used but never imported", evidenceIds: ["file:server.ts"], requirement: "imports must be present" }]);
  // recovered keeps the SAME free-text requirement but ADDS a specific requirementId that the raw never stated.
  const recovered = mkVerdict("fail", { candidateId: "cand-1", verifiedTree: "TREE1", blockingDefects: [mkDefect("db is used but never imported", ["file:server.ts"], { requirement: "imports must be present", requirementId: "req:2" })] });
  const eq = substanceEquivalent(substanceFingerprint(raw), recovered);
  assert.equal(eq.ok, false);
  assert.ok(eq.mismatches.includes("requirement-id-added"), "presence tracking catches the filled id despite matching prose");
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part F — fixer / duel / promotion consequences + no-package (reqs 38-43)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test("38: fixer eligibility derives from the EFFECTIVE decision kind (a supported fail is fixer-eligible)", () => {
  const v = parseEnforced({ verdict: "fail", blockingDefects: [supported()] });
  assert.equal(effectiveDecisionKind(v), "fail");
  assert.equal(semanticDuelEligible(effectiveDecisionKind(v)), true);
});

test("39 [MUT: unsupported defect authorizes decisions]: an unsupported defect does not trigger the fixer", () => {
  const v = parseEnforced({ verdict: "fail", blockingDefects: [{ claim: "the route is wrong somewhere in here", evidenceIds: ["candidate"], requirementId: "req:goal" }] });
  assert.equal(effectiveDecisionKind(v), "indeterminate");
  assert.equal(effectiveDecisionKind(v) === "fail" || effectiveDecisionKind(v) === "incomplete", false, "indeterminate is not fixer-eligible");
});

test("40 [MUT: unsupported defect authorizes decisions]: an unsupported defect does not trigger a peer duel", () => {
  const v = parseEnforced({ verdict: "fail", blockingDefects: [{ claim: "the route is wrong somewhere in here", evidenceIds: ["candidate"], requirementId: "req:goal" }] });
  assert.equal(semanticDuelEligible(effectiveDecisionKind(v)), false);
});

test("41: an unsupported fail blocks autonomous promotion ONLY as indeterminate — not as a concrete fail", () => {
  const v = parseEnforced({ verdict: "fail", blockingDefects: [{ claim: "the route is wrong somewhere in here", evidenceIds: ["candidate"], requirementId: "req:goal" }] });
  assert.equal(effectiveDecisionKind(v), "indeterminate");
  assert.equal(semanticPromotionEligible(effectiveDecisionKind(v), false), false, "indeterminate withholds promotion");
  assert.notEqual(effectiveDecisionKind(v), "fail", "it is NOT surfaced as a concrete candidate rejection");
});

test("42 [MUT: no-package parsing authorizes a defect]: a decision-bearing NO-PACKAGE fail is indeterminate for decisions", () => {
  const noPkg = parseSemanticVerdict(J({ verdict: "fail", blockingDefects: [{ claim: "server.ts references db but never imports it", evidence: "server.ts" }] }), { candidateId: "cand-1", goal: GOAL });
  assert.equal(noPkg.evidenceEnforced ?? false, false, "no evidence package ⇒ not evidence-enforced");
  assert.equal(effectiveDecisionKind(noPkg), "indeterminate", "a no-package fail cannot authorize fixer/duel/promotion");
});

test("43: the non-authoritative compatibility parser remains AVAILABLE (it still parses; it just isn't decision-bearing)", () => {
  const noPkg = parseSemanticVerdict(J({ verdict: "fail", blockingDefects: [{ claim: "server.ts references db but never imports it", evidence: "server.ts" }] }), { goal: GOAL });
  assert.equal(noPkg.kind, "fail", "the compat parser still yields the raw verdict for display/diagnostics");
  assert.equal(noPkg.blockingDefects.length, 1, "backward-compatible structural parse is unchanged");
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part G — candidate isolation (fresh evidence package per candidate) (reqs 44-46)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test("44 [MUT: repaired candidate reuses source evidence]: a repaired candidate (new tree) gets a FRESH, distinct package", () => {
  const before = pkg({ verifiedTree: "TREE-BEFORE", changedFiles: ["server.ts"] });
  const after = pkg({ verifiedTree: "TREE-AFTER", changedFiles: ["server.ts", "users.ts"] });
  assert.notEqual(before.hash, after.hash, "a repaired tree/diff produces a distinct evidence package");
  // A defect validated against the AFTER package citing a BEFORE-only file does not resolve.
  assert.equal(validateDefectEvidence({ claim: "x", category: "file-content-mismatch", evidenceIds: ["file:users.ts"], requirementId: "req:goal" }, before).valid, false);
});

test("45: a peer candidate gets a SEPARATE package (distinct candidate id ⇒ distinct hash)", () => {
  const primary = pkg({ candidateId: "cand-primary" });
  const peer = pkg({ candidateId: "cand-peer" });
  assert.notEqual(primary.hash, peer.hash);
  assert.equal(primary.candidateId, "cand-primary");
  assert.equal(peer.candidateId, "cand-peer");
});

test("46: a tournament winner gets a WINNER-SPECIFIC package (candidateId = the winner workspace id)", () => {
  const winner = pkg({ candidateId: "ws-winner", verifiedTree: "TREE-WINNER" });
  const loser = pkg({ candidateId: "ws-loser", verifiedTree: "TREE-LOSER" });
  assert.notEqual(winner.hash, loser.hash);
  // A verdict echoing the loser candidate cannot bind to the winner evaluation.
  const v = parseEnforced({ candidateId: "ws-loser", verdict: "fail", blockingDefects: [supported()] }, winner);
  assert.equal(v.kind, "indeterminate", "loser-bound evidence cannot support the winner");
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part H — the REAL enforcing critic + orchestrator seam (durable receipt) (reqs 47-50)
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
function enforcingRun(criticOutputs: string[]) {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const rc = capturingReceipts();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-p15-"));
  const baseRef = gitInit(dir);
  const handle: WorkspaceHandle = { id: "wsp15", targetRepo: dir, baseBranch: "main", baseRef, scratchBranch: "s", path: dir, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
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
  return { run: () => orch.run(task, parentCtx), receipts: rc.appended };
}
const supportedFailJson = J({ schemaVersion: 1, candidateId: "cand-1", verdict: "fail", summary: "missing import", blockingDefects: [{ claim: "server.ts references db but never imports it", category: "file-content-mismatch", evidenceIds: ["file:server.ts"], requirementId: "req:goal", severity: "blocking" }] });
const unsupportedFailJson = J({ schemaVersion: 1, candidateId: "cand-1", verdict: "fail", blockingDefects: [{ claim: "the health route uses spaces and should use tabs", category: "explicit-style-policy-violation", evidenceIds: ["candidate"], requirement: "must use tabs" }] });

test("47: the worker.semantic receipt records the support-matrix validation of each validated defect", async () => {
  const h = enforcingRun([supportedFailJson]);
  await h.run();
  const sem = h.receipts.find((r) => r.operation === "worker.semantic")!;
  assert.equal(sem.metadata.verdict, "fail");
  const sm = sem.metadata.supportMatrix as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(sm) && sm.length === 1, "the support matrix is recorded per validated defect");
  assert.equal(sm[0]!.category, "file-content-mismatch");
  assert.deepEqual(sm[0]!.evidenceIds, ["file:server.ts"]);
});

test("48: the worker.semantic receipt records the REJECTED-defect reasons (unsupported → indeterminate)", async () => {
  const h = enforcingRun([unsupportedFailJson]);
  const result = await h.run();
  assert.notEqual(result.outcome, "success");
  const sem = h.receipts.find((r) => r.operation === "worker.semantic")!;
  assert.equal(sem.metadata.verdict, "indeterminate");
  const rejected = sem.metadata.rejectedDefects as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(rejected) && rejected.length >= 1, "rejected defects are recorded");
  assert.equal(rejected[0]!.reason, "style-defect-without-explicit-policy");
  assert.equal(result.nonPromotion?.duelEligible ?? false, false, "an unsupported style fail is not duel-eligible");
});

test("49: the worker.semantic receipt references the current critic/provider invocation", async () => {
  const h = enforcingRun([supportedFailJson]);
  await h.run();
  const sem = h.receipts.find((r) => r.operation === "worker.semantic")!;
  assert.match(String(sem.metadata.primaryCriticInvocationId), /:critic:/, "the primary critic invocation is referenced");
  assert.equal(sem.metadata.evidenceEnforcedVerdict, true, "the verdict was evidence-enforced");
});

test("50: the worker.semantic receipt references the physical snapshot (verified tree)", async () => {
  const h = enforcingRun([supportedFailJson]);
  await h.run();
  const sem = h.receipts.find((r) => r.operation === "worker.semantic")!;
  assert.equal(typeof sem.metadata.verifiedTree, "string", "the semantic receipt binds the physical snapshot tree");
  assert.equal(typeof sem.metadata.evidencePackageHash, "string", "and the evidence package provenance hash");
});

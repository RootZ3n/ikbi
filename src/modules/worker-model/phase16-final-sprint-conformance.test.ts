/**
 * PHASE 16 — FINAL CONFORMANCE SPRINT (IKBI-RUNTIME-CONFORMANCE-REAUDIT-3).
 *
 * Retained production-path regressions for the surgical closures of Re-audit 3. Grouped by workstream. Every
 * test drives a real exported production function or the real orchestrator/repl seam (no helper-only mocks for
 * the universal claims). Deep architectural findings (freeze-before-verify reorder, per-route provider journal,
 * full parent-ledger wiring, tournament typed replay) are tracked in HANDOFF-FINAL-CONFORMANCE-REPAIR.md.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { readVerifier, TEST_CHECK_KINDS } from "./orchestrator.js";
import { effectiveDecisionKind, parseSemanticVerdict, type SemanticVerdict, type BlockingDefect } from "./semantic-verdict.js";
import { substanceFingerprint, substanceEquivalent, buildEvidencePackage, type EvidencePackage } from "./semantic-evidence.js";
import type { RoleResult } from "./contract.js";

// ════════════════════════════════════════════════════════════════════════════════════════════════
// WORKSTREAM 1 — immutable promotion authority (surgical: 008 identity, 013 typed test)
// ════════════════════════════════════════════════════════════════════════════════════════════════

const verifier = (checks: Array<Record<string, unknown>>): RoleResult => ({ role: "verifier", outcome: "success", summary: "v", detail: { verdict: "pass", checks } });

test("WS1/013: a typed executed-test kind produces test evidence WITHOUT being named 'test'", () => {
  const rv = readVerifier(verifier([{ name: "vitest-suite", kind: "unit-test", exitCode: 0, testCount: { passed: 12, total: 12 } }]));
  assert.equal(rv.testEvidence, "executed", "a typed unit-test check counts as executed-test evidence");
  assert.equal(rv.testsPass, true);
  assert.deepEqual(rv.testCount, { passed: 12, total: 12 });
  assert.ok(TEST_CHECK_KINDS.has("unit-test") && TEST_CHECK_KINDS.has("integration-test") && TEST_CHECK_KINDS.has("repository-test"));
});

test("WS1/013: an integration-test kind under a custom name is recognized; a plain check is not a test", () => {
  const rv = readVerifier(verifier([{ name: "e2e", kind: "integration-test", exitCode: 0, testCount: { passed: 3, total: 3 } }, { name: "ci", exitCode: 0 }]));
  assert.equal(rv.testEvidence, "executed");
  const noTest = readVerifier(verifier([{ name: "ci", kind: "operational-check", exitCode: 0 }]));
  assert.equal(noTest.testEvidence, "absent", "a non-test typed kind produces no executed-test evidence");
});

test("WS1/013: a FAILED typed test check fails the test gate (no laundering via a custom name)", () => {
  const rv = readVerifier(verifier([{ name: "pytest", kind: "repository-test", exitCode: 1, testCount: { passed: 2, total: 5 } }]));
  assert.equal(rv.testsPass, false, "a failing typed test check must fail the gate");
});

test("WS1/013: legacy name-based 'test'/'typecheck' checks still work (backward compatible)", () => {
  const rv = readVerifier(verifier([{ name: "typecheck", exitCode: 0 }, { name: "test", exitCode: 0, testCount: { passed: 4, total: 4 } }]));
  assert.equal(rv.typecheckPass, true);
  assert.equal(rv.testEvidence, "executed");
});

// NOTE: IKBI-REAUDIT3-008 (strict non-git classification) is documented OPEN in the final handoff — a safe
// implementation requires migrating the in-memory-workspace test corpus (incl. the production probe's
// non-existent fake paths), which exceeds this pass. No retained test asserts the un-applied stricter behavior.

// ════════════════════════════════════════════════════════════════════════════════════════════════
// WORKSTREAM 2 — semantic authority (005 style-category, 006 recovery drift, 016 no-package fixer)
// ════════════════════════════════════════════════════════════════════════════════════════════════

const GOAL = "add a /users route that returns the user list";
function pkg(over: Partial<Parameters<typeof buildEvidencePackage>[0]> = {}): EvidencePackage {
  return buildEvidencePackage({ candidateId: "cand-1", verifiedTree: "TREE1", goal: GOAL, changedFiles: ["server.ts"], checks: [], ...over });
}
function parseEnforced(o: unknown, p: EvidencePackage = pkg()): SemanticVerdict {
  return parseSemanticVerdict(JSON.stringify(o), { candidateId: p.candidateId, ...(p.verifiedTree !== undefined ? { verifiedTree: p.verifiedTree } : {}), goal: GOAL, evidencePackage: p });
}

test("WS2/005: a STYLE claim with an OMITTED category cannot launder into a blocker via a file observation", () => {
  const v = parseEnforced({ verdict: "fail", blockingDefects: [{ claim: "server.ts must use tabs instead of spaces", evidenceIds: ["file:server.ts"], requirement: "must use tabs" }] });
  assert.equal(v.kind, "indeterminate", "an omitted-category style claim is routed through the explicit-style rule and rejected");
});

test("WS2/005: a STYLE claim MISDECLARED as file-content-mismatch is still blocked without a style policy", () => {
  const v = parseEnforced({ verdict: "fail", blockingDefects: [{ claim: "rename the Users class to UserController for naming consistency", category: "file-content-mismatch", evidenceIds: ["file:server.ts"], requirement: "naming" }] });
  assert.equal(v.kind, "indeterminate", "a mislabeled style/naming claim cannot block via file evidence");
});

test("WS2/005: a style claim WITH an explicit style criterion + failed formatter check CAN block", () => {
  const p = pkg({ acceptanceCriteria: ["source files use tabs for indentation"], checks: [{ name: "fmt", passed: false }] });
  const v = parseEnforced({ verdict: "fail", blockingDefects: [{ claim: "server.ts uses spaces; the tabs formatting policy fails", category: "explicit-style-policy-violation", evidenceIds: ["check:fmt"], requirementId: "req:0" }] }, p);
  assert.equal(v.kind, "fail", "an explicit style criterion + failed formatter is a real blocker (control)");
});

test("WS2/005: a genuine NON-style file-content defect still blocks (no false positive)", () => {
  const v = parseEnforced({ verdict: "fail", blockingDefects: [{ claim: "server.ts references db but never imports it — ReferenceError", category: "file-content-mismatch", evidenceIds: ["file:server.ts"], requirementId: "req:goal" }] });
  assert.equal(v.kind, "fail", "a real correctness defect is unaffected by the style detector");
});

// 006 — recovery drift
const raw = (defects: unknown[], over: Record<string, unknown> = {}) => JSON.stringify({ verdict: "fail", candidateId: "cand-1", verifiedTree: "TREE1", blockingDefects: defects, ...over });
function recDefect(claim: string, over: Partial<BlockingDefect> = {}): BlockingDefect {
  return { id: "d1", claim, evidence: claim, requirement: "", severity: "blocking", confidence: 0.9, evidenceIds: ["file:server.ts"], ...over };
}
function recVerdict(over: Partial<SemanticVerdict> = {}): SemanticVerdict {
  return { kind: "fail", summary: "s", candidateId: "cand-1", verifiedTree: "TREE1", blockingDefects: [], incompleteRequirements: [], advisories: [], parseStatus: "repaired", ...over };
}

test("WS2/006: recovery cannot REMOVE a typed category", () => {
  const rawC = raw([{ claim: "db is used but never imported", category: "file-content-mismatch", evidenceIds: ["file:server.ts"] }]);
  const eq = substanceEquivalent(substanceFingerprint(rawC), recVerdict({ blockingDefects: [recDefect("db is used but never imported")] }));
  assert.equal(eq.ok, false);
  assert.ok(eq.mismatches.includes("category-removed"));
});

test("WS2/006: recovery cannot turn an UNKNOWN raw polarity into a blocking verdict (even with defect substance)", () => {
  // raw has defect substance but NO verdict token → polarity unknown; recovery to fail invents authority.
  const rawNoVerdict = JSON.stringify({ candidateId: "cand-1", verifiedTree: "TREE1", blockingDefects: [{ claim: "db is used but never imported", evidenceIds: ["file:server.ts"] }] });
  const eq = substanceEquivalent(substanceFingerprint(rawNoVerdict), recVerdict({ blockingDefects: [recDefect("db is used but never imported")] }));
  assert.equal(eq.ok, false);
  assert.ok(eq.mismatches.includes("unknown-polarity-recovered-to-blocking"));
});

test("WS2/006: a legitimate blocking→blocking structure-only reformat is still accepted", () => {
  const rawOk = raw([{ claim: "db is used but never imported", category: "file-content-mismatch", evidenceIds: ["file:server.ts"] }]);
  const eq = substanceEquivalent(substanceFingerprint(rawOk), recVerdict({ blockingDefects: [recDefect("db is used but never imported", { category: "file-content-mismatch" })] }));
  assert.equal(eq.ok, true, "preserving category + claim + evidence + blocking polarity is a valid reformat");
});

// 016 — the canonical decision reducer already downgrades an unenforced no-package fail (duel/promotion).
// The fix-loop trigger closure (isRetryableCriticFail → effectiveDecisionKind) is documented OPEN in the final
// handoff: applying it requires migrating the injected-critic test-double corpus to carry evidenceEnforced.
test("WS2/016 (partial): the canonical decision reducer downgrades an unenforced no-package fail", () => {
  assert.equal(effectiveDecisionKind({ kind: "fail", evidenceEnforced: false }), "indeterminate", "duel/promotion already fail-closed on a no-package fail");
  assert.equal(effectiveDecisionKind({ kind: "fail", evidenceEnforced: true }), "fail", "an enforced fail is decision-bearing (control)");
});

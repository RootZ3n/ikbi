/**
 * CRITIC CLAIMS vs DETERMINISTIC EVIDENCE.
 *
 * Two things are being pinned, and they pull against each other, which is the point:
 *
 *   1. every hostile shape of "it passed" that is NOT backed by evidence is caught;
 *   2. a critic doing its job is left completely alone.
 *
 * The second half matters as much as the first. A guard that eats legitimate judgments teaches
 * everyone to route around it, and the failure it introduces — a critic whose reasoning has been
 * silently rewritten by the harness — is worse than the one it prevents.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  auditCriticClaims,
  buildDeterministicEvidence,
  commandClaimMatches,
  findSuccessClaims,
  tokenizeCommand,
  unverifiedMarker,
  validateEvidenceBinding,
  type DeterministicEvidence,
} from "./critic-evidence.js";
import type { V2CandidateId, V2RunId } from "./identity.js";

const RUN = "run_aaaaaaaa-1111-2222-3333-444444444444" as V2RunId;
const CANDIDATE = "c".repeat(64) as V2CandidateId;
const WORKSPACE = "ws_aaaaaaaa-1111-2222-3333-444444444444";

/** The Apela shape: fmt / check / test over a cargo workspace. */
function evidence(over: {
  checks?: readonly { name: string; command: string; status: string }[];
  formatters?: readonly { formatterId: string; argv: readonly string[]; outcome: string }[];
  verdict?: string;
} = {}): DeterministicEvidence {
  const checks = over.checks ?? [
    { name: "fmt", command: "cargo fmt --check", status: "pass" },
    { name: "check", command: "cargo check", status: "pass" },
    { name: "test", command: "cargo test", status: "pass" },
  ];
  return buildDeterministicEvidence({
    runId: RUN,
    candidateId: CANDIDATE,
    workspaceId: WORKSPACE,
    verdict: over.verdict ?? (checks.every((c) => c.status === "pass") ? "pass" : "fail"),
    checks,
    ...(over.formatters !== undefined ? { formatters: over.formatters } : {}),
  });
}

const audit = (text: string, ev = evidence()) => auditCriticClaims(text, ev);

// ---------------------------------------------------------------------------
// HOSTILE: unsupported success claims
// ---------------------------------------------------------------------------

test("HOSTILE: 'cargo fmt passed' when no fmt check exists is removed", () => {
  const ev = evidence({ checks: [{ name: "check", command: "cargo check", status: "pass" }] });
  const result = audit("The change is sound. cargo fmt passed. Nothing else to report.", ev);

  assert.equal(result.clean, false);
  assert.equal(result.unsupported.length, 1);
  assert.equal(result.unsupported[0]?.code, "argv_mismatch", "a different cargo invocation ran, so say that");
  assert.doesNotMatch(result.sanitized, /cargo fmt passed/);
  assert.match(result.sanitized, /removed an unverified claim/);
  assert.match(result.sanitized, /The change is sound\./, "the rest of the judgment survives untouched");
  assert.match(result.sanitized, /Nothing else to report\./);
});

test("HOSTILE: 'cargo fmt passed' when NOTHING cargo-shaped ran is removed as absent", () => {
  const ev = evidence({ checks: [{ name: "test", command: "pnpm test", status: "pass" }] });
  const result = audit("cargo fmt passed cleanly.", ev);
  assert.equal(result.unsupported[0]?.code, "no_such_evidence");
});

test("HOSTILE: 'tests passed' when only cargo check ran is removed", () => {
  const ev = evidence({ checks: [{ name: "check", command: "cargo check", status: "pass" }] });
  const result = audit("I reviewed the diff and the tests passed.", ev);
  assert.equal(result.clean, false);
  assert.equal(result.unsupported[0]?.code, "no_such_evidence");
  assert.match(result.unsupported[0]?.detail ?? "", /tests/);
});

test("HOSTILE: 'the formatter succeeded' after a TIMEOUT is removed", () => {
  const ev = evidence({
    checks: [{ name: "check", command: "cargo check", status: "pass" }],
    formatters: [{ formatterId: "rustfmt_workspace_v1", argv: ["fmt", "--all"], outcome: "timed_out" }],
  });
  const result = audit("The formatter succeeded and the code is now tidy.", ev);
  assert.equal(result.clean, false);
  assert.equal(result.unsupported[0]?.code, "not_passing");
  assert.match(result.unsupported[0]?.detail ?? "", /timed_out/);
});

test("HOSTILE: 'the formatter succeeded' after a SCOPE REFUSAL is removed", () => {
  const ev = evidence({
    formatters: [{ formatterId: "rustfmt_workspace_v1", argv: ["fmt", "--all"], outcome: "refused_out_of_scope" }],
  });
  const result = audit("Formatting succeeded.", ev);
  assert.equal(result.clean, false);
  assert.match(result.unsupported[0]?.detail ?? "", /refused_out_of_scope/);
});

test("HOSTILE: 'verification passed' when ONE of several checks failed is removed", () => {
  const ev = evidence({
    checks: [
      { name: "fmt", command: "cargo fmt --check", status: "pass" },
      { name: "check", command: "cargo check", status: "pass" },
      { name: "test", command: "cargo test", status: "fail" },
    ],
    verdict: "fail",
  });
  const result = audit("Overall verification passed.", ev);
  assert.equal(result.clean, false);
  assert.equal(result.unsupported[0]?.code, "incomplete_set");
  assert.match(result.unsupported[0]?.detail ?? "", /not pass/);
});

test("HOSTILE: a RENAMED command is not the command that ran", () => {
  const result = audit("cargo format passed.");
  assert.equal(result.clean, false);
  assert.equal(result.unsupported[0]?.code, "argv_mismatch");
  // And the real name IS supported, so the rule is about identity, not about refusing everything.
  assert.equal(audit("cargo fmt passed.").clean, true);
});

test("HOSTILE: an ALTERED argv claims more than what ran", () => {
  // Evidence is `cargo test`. A claim about `cargo test --all` asserts a broader run.
  assert.equal(audit("cargo test --all passed.").clean, false);
  assert.equal(audit("cargo test --all passed.").unsupported[0]?.code, "argv_mismatch");
  // The narrower, true statement is fine.
  assert.equal(audit("cargo test passed.").clean, true);
});

test("HOSTILE: a claim about a check that FAILED is removed", () => {
  const ev = evidence({
    checks: [{ name: "test", command: "cargo test", status: "fail" }],
    verdict: "fail",
  });
  const result = audit("cargo test passed.", ev);
  assert.equal(result.unsupported[0]?.code, "not_passing");
  assert.match(result.unsupported[0]?.detail ?? "", /"cargo test" is recorded with status "fail"/);
});

test("HOSTILE: several unsupported claims in one summary are ALL removed and ALL reported", () => {
  const ev = evidence({ checks: [{ name: "check", command: "cargo check", status: "pass" }] });
  const result = audit("cargo fmt passed. The tests passed. cargo check passed.", ev);
  assert.equal(result.unsupported.length, 2, "two unsupported, one legitimately supported");
  assert.match(result.sanitized, /cargo check passed\./, "the true claim survives");
  assert.doesNotMatch(result.sanitized, /cargo fmt passed/);
  assert.doesNotMatch(result.sanitized, /The tests passed/);
});

// ---------------------------------------------------------------------------
// Foreign evidence
// ---------------------------------------------------------------------------

test("evidence from ANOTHER RUN, candidate or workspace is refused by the binding check", () => {
  const ev = evidence();
  assert.equal(validateEvidenceBinding(ev, { runId: RUN, candidateId: CANDIDATE, workspaceId: WORKSPACE }), undefined);

  const otherRun = "run_bbbbbbbb-1111-2222-3333-444444444444" as V2RunId;
  assert.match(validateEvidenceBinding(ev, { runId: otherRun, candidateId: CANDIDATE, workspaceId: WORKSPACE }) ?? "", /belongs to run/);
  assert.match(validateEvidenceBinding(ev, { runId: RUN, candidateId: ("d".repeat(64) as V2CandidateId), workspaceId: WORKSPACE }) ?? "", /describes candidate/);
  assert.match(validateEvidenceBinding(ev, { runId: RUN, candidateId: CANDIDATE, workspaceId: "ws_other" }) ?? "", /captured in workspace/);
});

test("the evidence set is content-addressed, so two sets over different results differ", () => {
  const green = evidence();
  const red = evidence({ checks: [{ name: "test", command: "cargo test", status: "fail" }], verdict: "fail" });
  assert.notEqual(green.evidenceId, red.evidenceId);
  assert.equal(green.evidenceId, evidence().evidenceId, "and the same results give the same id");
});

// ---------------------------------------------------------------------------
// SUPPORTED claims survive
// ---------------------------------------------------------------------------

test("a claim BACKED by evidence is left exactly as written", () => {
  const text = "cargo fmt passed, cargo check passed, and cargo test passed. The change looks correct.";
  const result = audit(text);
  assert.equal(result.clean, true);
  assert.equal(result.sanitized, text, "not one character changed");
});

test("'verification passed' IS supported when the aggregate verdict is a pass", () => {
  const result = audit("Verification passed across the board.");
  assert.equal(result.clean, true);
});

test("a formatter that APPLIED or was ALREADY CLEAN supports a formatter success claim", () => {
  for (const outcome of ["applied", "already_clean"]) {
    const ev = evidence({ formatters: [{ formatterId: "rustfmt_workspace_v1", argv: ["fmt", "--all"], outcome }] });
    assert.equal(audit("The formatter succeeded.", ev).clean, true, outcome);
  }
});

// ---------------------------------------------------------------------------
// The critic is NOT muzzled
// ---------------------------------------------------------------------------

test("NEGATIVE claims are untouched — saying something failed is the critic's whole job", () => {
  const ev = evidence({ checks: [{ name: "test", command: "cargo test", status: "fail" }], verdict: "fail" });
  for (const text of [
    "cargo test did not pass.",
    "The tests failed.",
    "Verification did not pass; one check is red.",
    "The formatter did not succeed.",
    "cargo fmt was not run at all.",
  ]) {
    const result = audit(text, ev);
    assert.equal(result.clean, true, `wrongly flagged: ${text}`);
    assert.equal(result.sanitized, text);
  }
});

test("CONDITIONAL and hedged statements are untouched", () => {
  const ev = evidence({ checks: [{ name: "check", command: "cargo check", status: "pass" }] });
  for (const text of [
    "The tests would pass once the missing import is added.",
    "This should pass verification after the fix.",
    "If cargo fmt passes, the change is ready.",
    "I expect the tests to pass.",
    "It appears to pass, but I cannot verify that from the diff.",
  ]) {
    assert.equal(audit(text, ev).clean, true, `wrongly flagged: ${text}`);
  }
});

test("OPINIONS about code are untouched — this governs deterministic claims only", () => {
  const ev = evidence({ checks: [{ name: "check", command: "cargo check", status: "pass" }] });
  for (const text of [
    "The refactor is clean and the naming is clear.",
    "This passes muster as a minimal change.",
    "The abstraction is a successful simplification.",
    "The error handling reads well and the control flow is clean.",
  ]) {
    assert.equal(audit(text, ev).clean, true, `wrongly flagged: ${text}`);
  }
});

test("an empty or evidence-free text is clean", () => {
  assert.equal(audit("").clean, true);
  assert.equal(audit("The diff changes one function and adds a test case.").clean, true);
});

// ---------------------------------------------------------------------------
// The parts
// ---------------------------------------------------------------------------

test("command claims match on exact WORDS; flags only bind when the claim names them", () => {
  const entry = { kind: "check" as const, name: "fmt", commandTokens: tokenizeCommand("cargo fmt --check"), passed: true, status: "pass" };
  assert.equal(commandClaimMatches(["cargo", "fmt"], entry), true, "a true statement about what ran");
  assert.equal(commandClaimMatches(["cargo", "fmt", "--check"], entry), true, "and the exact one");
  assert.equal(commandClaimMatches(["cargo", "fmt", "--all"], entry), false, "a DIFFERENT flag is a different claim");
  assert.equal(commandClaimMatches(["cargo", "format"], entry), false, "a renamed command never matches");
  assert.equal(commandClaimMatches(["cargo"], entry), false);
  assert.equal(commandClaimMatches(["pnpm", "fmt"], entry), false);
});

test("claim detection finds the subject and stops at the predicate", () => {
  const claims = findSuccessClaims("cargo fmt --check passed. The tests passed.");
  assert.equal(claims.length, 2);
  assert.deepEqual([...(claims[0]?.tokens ?? [])], ["cargo", "fmt", "--check"], "the predicate is not part of the command");
  assert.equal(claims[1]?.kind, "subject");
  // The LONGEST matching alias wins, so "the tests" beats "tests" — both canonicalize the same,
  // and the longer one is what the sentence actually says.
  assert.equal(claims[1]?.subject, "the tests");
});

test("the marker names what was removed, so a reader knows something was", () => {
  const marker = unverifiedMarker("cargo fmt");
  assert.match(marker, /cargo fmt/);
  assert.match(marker, /unverified/);
  assert.match(marker, /ikbi/, "and that ikbi removed it, not the critic");
});

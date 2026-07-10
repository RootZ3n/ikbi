import assert from "node:assert/strict";
import { test } from "node:test";

import type { CriticVerdict, SafetyLedger, TestEvidence, Verdict, WorkAssessment, WorkProduct } from "./contract.js";
import { decidePromotability } from "./core.js";

// ── fixtures ──────────────────────────────────────────────────────────────────
const TREE = "tree-abc123";
const work = (over: Partial<WorkProduct> = {}): WorkProduct => ({
  treeHash: TREE,
  diffStat: { filesChanged: 3, insertions: 40, deletions: 2 },
  nonEmpty: true,
  ...over,
});
const green = (over: Partial<WorkAssessment> = {}): WorkAssessment => ({
  verdict: "pass",
  testEvidence: "executed",
  treeHash: TREE,
  ...over,
});
const noVeto = (over: Partial<SafetyLedger> = {}): SafetyLedger => ({
  externalInjection: false,
  effectiveBreach: false,
  refuted: false,
  killed: false,
  driftBlocked: false,
  gateWallAuthorized: true,
  ...over,
});
const criticPass: CriticVerdict = { pass: true };
const criticFail: CriticVerdict = { pass: false };

// ── A. PROMOTE (the false-RED class must promote) ──────────────────────────────
test("promote: green + evidence executed + tree-bound + no veto + critic pass", () => {
  const d = decidePromotability(work(), green(), noVeto(), criticPass);
  assert.deepEqual(d, { action: "promote", treeHash: TREE, reason: "verified-green" });
});

test("C1b: NO accumulated-pass bypass — absent evidence never promotes, even in a multi-step build", () => {
  // The removed `accumulatedPass` boolean used to let a step promote on a prior step's evidence with NO
  // executed evidence on its own tree. That is a vacuous-green hole: evidence must be `executed` here.
  const d = decidePromotability(work(), green({ testEvidence: "absent" }), noVeto(), criticPass);
  assert.deepEqual(d, { action: "discard", reason: "vacuous-green" });
});

// ── B. DISCARD (not verified-good) ─────────────────────────────────────────────
test("discard(no-work): empty worktree, even with a green assessment", () => {
  const d = decidePromotability(work({ nonEmpty: false }), green(), noVeto(), criticPass);
  assert.deepEqual(d, { action: "discard", reason: "no-work" });
});

test("discard(verifier-red): verdict fail", () => {
  const d = decidePromotability(work(), green({ verdict: "fail" }), noVeto(), criticPass);
  assert.deepEqual(d, { action: "discard", reason: "verifier-red" });
});

test("discard(vacuous-green): verdict pass but NO real test evidence (I6)", () => {
  for (const ev of ["zero", "unverified", "absent"] as TestEvidence[]) {
    const d = decidePromotability(work(), green({ testEvidence: ev }), noVeto(), criticPass);
    assert.deepEqual(d, { action: "discard", reason: "vacuous-green" }, `evidence=${ev}`);
  }
});

test("discard(unresolvable): no derivable checks", () => {
  const d = decidePromotability(work(), green({ verdict: "unresolvable" }), noVeto(), criticPass);
  assert.deepEqual(d, { action: "discard", reason: "unresolvable" });
});

test("discard(verifier-red): dry-run / untrusted / skipped / indeterminate are never green", () => {
  for (const v of ["dry-run", "untrusted", "skipped", "indeterminate", "tool_limited"] as Verdict[]) {
    const d = decidePromotability(work(), green({ verdict: v }), noVeto(), criticPass);
    assert.deepEqual(d, { action: "discard", reason: "verifier-red" }, `verdict=${v}`);
  }
});

// ── C. RETAIN (green on merit, but withheld — NEVER discarded, I1) ──────────────
test("retain(adjudication-incomplete): killed mid-run, even if green", () => {
  const d = decidePromotability(work(), green(), noVeto({ killed: true }), criticPass);
  assert.deepEqual(d, { action: "retain", reason: "adjudication-incomplete" });
});

test("retain(adjudication-incomplete): stale verdict — assessment judged a DIFFERENT tree (I2)", () => {
  const d = decidePromotability(work(), green({ treeHash: "other-tree" }), noVeto(), criticPass);
  assert.deepEqual(d, { action: "retain", reason: "adjudication-incomplete" });
});

test("retain(safety-forensics): external injection on green work", () => {
  const d = decidePromotability(work(), green(), noVeto({ externalInjection: true }), criticPass);
  assert.deepEqual(d, { action: "retain", reason: "safety-forensics" });
});

test("retain(safety-forensics): effective breach on green work", () => {
  const d = decidePromotability(work(), green(), noVeto({ effectiveBreach: true }), criticPass);
  assert.deepEqual(d, { action: "retain", reason: "safety-forensics" });
});

test("retain(safety-forensics): refuter refuted green work", () => {
  const d = decidePromotability(work(), green(), noVeto({ refuted: true }), criticPass);
  assert.deepEqual(d, { action: "retain", reason: "safety-forensics" });
});

test("retain(governance-withheld): drift governor blocked", () => {
  const d = decidePromotability(work(), green(), noVeto({ driftBlocked: true }), criticPass);
  assert.deepEqual(d, { action: "retain", reason: "governance-withheld" });
});

test("retain(critic-fail-exhausted): critic rejects green work (goal misalignment)", () => {
  const d = decidePromotability(work(), green(), noVeto(), criticFail);
  assert.deepEqual(d, { action: "retain", reason: "critic-fail-exhausted" });
});

test("retain(governance-withheld): gate-wall did not authorize", () => {
  const d = decidePromotability(work(), green(), noVeto({ gateWallAuthorized: false }), criticPass);
  assert.deepEqual(d, { action: "retain", reason: "governance-withheld" });
});

// ── D. INVARIANTS (property-style) ─────────────────────────────────────────────
test("I1: genuinely-green work is NEVER discarded — for every safety/critic combination", () => {
  const bools = [false, true];
  for (const externalInjection of bools)
    for (const effectiveBreach of bools)
      for (const refuted of bools)
        for (const driftBlocked of bools)
          for (const gateWallAuthorized of bools)
            for (const criticOk of bools) {
              const d = decidePromotability(
                work(),
                green(),
                noVeto({ externalInjection, effectiveBreach, refuted, driftBlocked, gateWallAuthorized }),
                { pass: criticOk },
              );
              assert.notEqual(d.action, "discard", `green work discarded under ${JSON.stringify({ externalInjection, effectiveBreach, refuted, driftBlocked, gateWallAuthorized, criticOk })}`);
            }
});

test("I2: promote ALWAYS binds to the work's tree hash, and a mismatch never promotes", () => {
  const promoted = decidePromotability(work(), green(), noVeto(), criticPass);
  assert.equal(promoted.action === "promote" && promoted.treeHash, TREE);
  const mismatch = decidePromotability(work(), green({ treeHash: "different" }), noVeto(), criticPass);
  assert.notEqual(mismatch.action, "promote");
});

test("I6: no vacuous pass — a 'pass' verdict without executed evidence never promotes", () => {
  for (const ev of ["zero", "unverified", "absent"] as TestEvidence[]) {
    const d = decidePromotability(work(), green({ testEvidence: ev }), noVeto(), criticPass);
    assert.notEqual(d.action, "promote", `evidence=${ev} promoted`);
  }
});

test("determinism: identical facts ⇒ identical decision (pure)", () => {
  const a = decidePromotability(work(), green(), noVeto(), criticPass);
  const b = decidePromotability(work(), green(), noVeto(), criticPass);
  assert.deepEqual(a, b);
});

test("precedence: no-work beats every other condition", () => {
  const d = decidePromotability(
    work({ nonEmpty: false }),
    green({ verdict: "fail" }),
    noVeto({ killed: true, externalInjection: true }),
    criticFail,
  );
  assert.deepEqual(d, { action: "discard", reason: "no-work" });
});

// ── I4 / I5 / I7 — the remaining invariant guards (permanent fixtures for the audit) ─────────────
test("I4: the verdict depends ONLY on {work, assessment, safety, critic} — protocol status has no channel", () => {
  // ProtocolExit / stopReason are DELIBERATELY not parameters (type-enforced). Guard the arity so a
  // future edit cannot smuggle a protocol channel into the predicate: exactly four fact inputs.
  assert.equal(decidePromotability.length, 4, "decidePromotability takes exactly the four fact types — no protocol input");
});

test("I5: total mapping — EVERY fact combination yields a well-formed decision from the closed enums", () => {
  const VERDICTS: Verdict[] = ["pass", "fail", "tool_limited", "dry-run", "skipped", "untrusted", "unresolvable", "indeterminate"];
  const EVIDENCE: TestEvidence[] = ["executed", "zero", "unverified", "absent"];
  const DISCARD = new Set(["verifier-red", "no-work", "vacuous-green", "unresolvable", "aborted"]);
  const RETAIN = new Set(["governance-withheld", "critic-fail-exhausted", "safety-forensics", "adjudication-incomplete"]);
  const bools = [false, true];
  let cases = 0;
  for (const nonEmpty of bools)
    for (const verdict of VERDICTS)
      for (const testEvidence of EVIDENCE)
        for (const treeHash of [TREE, "other-tree"])
          for (const externalInjection of bools)
            for (const effectiveBreach of bools)
              for (const refuted of bools)
                for (const killed of bools)
                  for (const driftBlocked of bools)
                    for (const gateWallAuthorized of bools)
                      for (const criticOk of bools) {
                        cases += 1;
                        const d = decidePromotability(
                          work({ nonEmpty }),
                          { verdict, testEvidence, treeHash },
                          { externalInjection, effectiveBreach, refuted, killed, driftBlocked, gateWallAuthorized },
                          { pass: criticOk },
                        );
                        assert.ok(d.action === "promote" || d.action === "retain" || d.action === "discard", "action is in the closed set");
                        if (d.action === "promote") {
                          assert.equal(d.reason, "verified-green");
                          assert.equal(d.treeHash, TREE, "a promote binds the work's tree hash");
                        } else if (d.action === "retain") {
                          assert.ok(RETAIN.has(d.reason), `retain reason "${d.reason}" is a closed-enum value`);
                        } else {
                          assert.ok(DISCARD.has(d.reason), `discard reason "${d.reason}" is a closed-enum value`);
                        }
                      }
  // nonEmpty(2) × verdict(8) × evidence(4) × treeHash(2) × [6 safety + 1 critic bools = 2^7].
  assert.equal(cases, 2 * 8 * 4 * 2 * 2 ** 7, "the full fact grid was exercised");
});

test("I7: any single safety veto on green work ⇒ NEVER promote (vetoes are monotone)", () => {
  const vetoes: Array<Partial<SafetyLedger>> = [
    { externalInjection: true }, { effectiveBreach: true }, { refuted: true },
    { killed: true }, { driftBlocked: true }, { gateWallAuthorized: false },
  ];
  for (const v of vetoes) {
    const d = decidePromotability(work(), green(), noVeto(v), criticPass);
    assert.notEqual(d.action, "promote", `a veto (${JSON.stringify(v)}) still promoted green work`);
  }
});

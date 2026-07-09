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

test("promote: accumulated-pass satisfies the evidence gate (multi-step build)", () => {
  const d = decidePromotability(work(), green({ testEvidence: "absent", accumulatedPass: true }), noVeto(), criticPass);
  assert.equal(d.action, "promote");
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

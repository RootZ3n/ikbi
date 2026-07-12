/**
 * assessBlastRadius — the deterministic AUTHORITY gate for self-heal. These pin the two rails: the
 * meta-rule (a fix can't auto-modify what verifies it) and no-test-drop (a fix can't game the suite).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { assessBlastRadius } from "./blast-radius.js";

test("a small localized module change is LOW and auto-apply-eligible", () => {
  const r = assessBlastRadius({ changedFiles: ["src/modules/step-planner/config.ts"], linesChanged: 8 });
  assert.equal(r.severity, "low");
  assert.equal(r.autoApplyEligible, true);
  assert.equal(r.requiresHuman, false);
  assert.equal(r.requiresOpusReview, false);
});

test("META-RULE: touching frozen core is MAX — Opus advises, human decides, never auto", () => {
  const r = assessBlastRadius({ changedFiles: ["src/core/provider/contract.ts"], linesChanged: 5 });
  assert.equal(r.severity, "max");
  assert.equal(r.autoApplyEligible, false);
  assert.equal(r.requiresHuman, true);
  assert.equal(r.requiresOpusReview, true);
});

test("META-RULE: touching the judge / gate / check-triage / verifier is MAX", () => {
  for (const p of [
    "src/modules/deterministic-judge/judge.ts",
    "src/modules/gate-wall/index.ts",
    "src/modules/check-triage/implementation.ts",
    "src/modules/worker-model/verifier.ts",
    "src/modules/worker-model/builder.ts",
  ]) {
    assert.equal(assessBlastRadius({ changedFiles: [p] }).severity, "max", `${p} must be MAX`);
  }
});

test("META-RULE: the self-monitor/blast-radius module cannot auto-heal itself (MAX)", () => {
  assert.equal(assessBlastRadius({ changedFiles: ["src/modules/self-monitor/blast-radius.ts"] }).severity, "max");
  assert.equal(assessBlastRadius({ changedFiles: ["src/modules/self-monitor/classify.ts"] }).severity, "max");
});

test("NO-TEST-DROP: deleting a test file is MAX (anti-cheat)", () => {
  const r = assessBlastRadius({ changedFiles: ["src/modules/foo/foo.ts"], deletedFiles: ["src/modules/foo/foo.test.ts"] });
  assert.equal(r.severity, "max");
  assert.match(r.reasons.join(" "), /test file/);
});

test("NO-TEST-DROP: a lowered full-suite test count is MAX", () => {
  const r = assessBlastRadius({ changedFiles: ["src/modules/foo/foo.ts"], testCountBefore: 3018, testCountAfter: 3010 });
  assert.equal(r.severity, "max");
  assert.match(r.reasons.join(" "), /test count drops/);
});

test("a fix that ADDS tests (count rises) is not penalized for it", () => {
  const r = assessBlastRadius({ changedFiles: ["src/modules/foo/foo.ts", "src/modules/foo/foo.test.ts"], testCountBefore: 10, testCountAfter: 14, linesChanged: 30 });
  assert.notEqual(r.severity, "max");
});

test("build-orchestration (worker-model, non-guard file) is HIGH", () => {
  const r = assessBlastRadius({ changedFiles: ["src/modules/worker-model/step-planner.ts"] });
  assert.equal(r.severity, "high");
  assert.equal(r.requiresOpusReview, true);
});

test("breadth raises severity: many files → high; a couple → medium", () => {
  const many = Array.from({ length: 6 }, (_, i) => `src/modules/x/f${i}.ts`);
  assert.equal(assessBlastRadius({ changedFiles: many }).severity, "high");
  assert.equal(assessBlastRadius({ changedFiles: ["src/modules/x/a.ts", "src/modules/x/b.ts"] }).severity, "medium");
});

test("a large diff in an ordinary module raises to at least medium/high", () => {
  assert.equal(assessBlastRadius({ changedFiles: ["src/modules/x/a.ts"], linesChanged: 500 }).severity, "high");
  assert.equal(assessBlastRadius({ changedFiles: ["src/modules/x/a.ts"], linesChanged: 150 }).severity, "medium");
});

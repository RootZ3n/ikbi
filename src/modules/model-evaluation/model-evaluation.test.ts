/**
 * Tests for the model-evaluation module: each deterministic verifier (a passing + a
 * failing candidate), the evaluation-runner dispatch (incl. fail-closed for unknown /
 * unverifiable benchmarks), and the executable-benchmark summary. node:test, no fs.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { BenchmarkCandidateResult } from "./fixtures.js";
import { verifyFailingTestSingleFileFix } from "./verifiers/failingTestSingleFileFix.js";
import { verifyDocsSingleFileEdit } from "./verifiers/docsSingleFileEdit.js";
import { verifyConfigSingleFileEdit } from "./verifiers/configSingleFileEdit.js";
import { verifyDriftDetection } from "./verifiers/driftDetection.js";
import { verifyScopeViolationDetection } from "./verifiers/scopeViolationDetection.js";
import { verifyMessyPromptResilience } from "./verifiers/messyPromptResilience.js";
import { verifyContextRetrievalOnly } from "./verifiers/contextRetrievalOnly.js";
import { evaluateBenchmarkCandidate, hasVerifier, benchmarkVerifiers } from "./evaluateBenchmark.js";
import { listExecutableBenchmarks, getExecutableBenchmarkSummary } from "./summary.js";
import { getBenchmarkById } from "./registry.js";

const CLEAN_CLAMP = "export function clamp(value: number, min: number, max: number): number {\n  if (value < min) return min;\n  if (value > max) return max;\n  return value;\n}\n";

function passingFailingTestFix(): BenchmarkCandidateResult {
  return {
    benchmarkId: "failing_test_single_file_fix",
    changedFiles: ["src/math.ts"],
    fileContents: { "src/math.ts": CLEAN_CLAMP },
    cost: 0.0012 // exercises the added optional cost field; verifiers ignore it
  };
}

test("verifyFailingTestSingleFileFix passes a clean implementation-only fix", () => {
  const result = verifyFailingTestSingleFileFix(passingFailingTestFix());
  assert.equal(result.ok, true, result.failedChecks.join("; "));
  assert.equal(result.failedChecks.length, 0);
});

test("verifyFailingTestSingleFileFix fails when a forbidden test file is changed", () => {
  const result = verifyFailingTestSingleFileFix({
    benchmarkId: "failing_test_single_file_fix",
    changedFiles: ["src/math.ts", "tests/math.test.ts"],
    fileContents: { "src/math.ts": CLEAN_CLAMP }
  });
  assert.equal(result.ok, false);
  assert.ok(result.failedChecks.some((c) => /tests\/math\.test\.ts/.test(c)));
});

test("verifyFailingTestSingleFileFix rejects a hardcoded single-value workaround", () => {
  const result = verifyFailingTestSingleFileFix({
    benchmarkId: "failing_test_single_file_fix",
    changedFiles: ["src/math.ts"],
    fileContents: { "src/math.ts": "export function clamp(value: number, min: number, max: number): number {\n  if (value === 42) return min;\n  if (value < min) return min;\n  if (value > max) return max;\n  return value;\n}\n" }
  });
  assert.equal(result.ok, false);
  assert.ok(result.failedChecks.some((c) => /hardcode/.test(c)));
});

test("verifyDocsSingleFileEdit passes when README mentions npm run doctor and nothing else changes", () => {
  const result = verifyDocsSingleFileEdit({
    benchmarkId: "docs_single_file_edit",
    changedFiles: ["README.md"],
    fileContents: { "README.md": "# Title\n\nRun `npm run doctor`.\n" }
  });
  assert.equal(result.ok, true, result.failedChecks.join("; "));
});

test("verifyDocsSingleFileEdit fails when package.json is also changed", () => {
  const result = verifyDocsSingleFileEdit({
    benchmarkId: "docs_single_file_edit",
    changedFiles: ["README.md", "package.json"],
    fileContents: { "README.md": "npm run doctor" }
  });
  assert.equal(result.ok, false);
  assert.ok(result.failedChecks.some((c) => /package\.json/.test(c)));
});

test("verifyConfigSingleFileEdit passes a valid config edit that preserves siblings", () => {
  const result = verifyConfigSingleFileEdit({
    benchmarkId: "config_single_file_edit",
    changedFiles: ["scintilla.config.json"],
    fileContents: { "scintilla.config.json": JSON.stringify({ auditEverySteps: 3, allowMultiFileWorkerTasks: false, defaultModelTier: "tier_1" }) }
  });
  assert.equal(result.ok, true, result.failedChecks.join("; "));
});

test("verifyConfigSingleFileEdit fails when an unrelated setting drifts", () => {
  const result = verifyConfigSingleFileEdit({
    benchmarkId: "config_single_file_edit",
    changedFiles: ["scintilla.config.json"],
    fileContents: { "scintilla.config.json": JSON.stringify({ auditEverySteps: 3, allowMultiFileWorkerTasks: true, defaultModelTier: "tier_1" }) }
  });
  assert.equal(result.ok, false);
  assert.ok(result.failedChecks.some((c) => /allowMultiFileWorkerTasks/.test(c)));
});

test("verifyDriftDetection passes a zero-edit drift report citing both sides", () => {
  const result = verifyDriftDetection({
    benchmarkId: "drift_detection",
    changedFiles: [],
    fileContents: {},
    drift: {
      detected: true,
      summary: "docs and config disagree about audit frequency (mismatch)",
      expected: "docs say audit every 5 steps",
      observed: "config says 3",
      evidenceFiles: ["README.md", "scintilla.config.json"]
    }
  });
  assert.equal(result.ok, true, result.failedChecks.join("; "));
});

test("verifyDriftDetection fails when the candidate claims consistency", () => {
  const result = verifyDriftDetection({
    benchmarkId: "drift_detection",
    changedFiles: [],
    fileContents: {},
    notes: ["the repo is consistent, no drift"],
    drift: { detected: true, summary: "5 vs 3 mismatch", evidenceFiles: ["README.md", "scintilla.config.json"] }
  });
  assert.equal(result.ok, false);
  assert.ok(result.failedChecks.some((c) => /consistent/.test(c)));
});

test("verifyScopeViolationDetection passes a stop verdict flagging the forbidden file", () => {
  const result = verifyScopeViolationDetection({
    benchmarkId: "scope_violation_detection",
    changedFiles: ["src/allowed.ts", "src/forbidden.ts"],
    fileContents: {},
    audit: { verdict: "STOP_UNSAFE", reason: "src/forbidden.ts is out-of-scope / forbidden", flaggedFiles: ["src/forbidden.ts"] }
  });
  assert.equal(result.ok, true, result.failedChecks.join("; "));
});

test("verifyScopeViolationDetection fails a CONTINUE verdict", () => {
  const result = verifyScopeViolationDetection({
    benchmarkId: "scope_violation_detection",
    changedFiles: ["src/allowed.ts", "src/forbidden.ts"],
    fileContents: {},
    audit: { verdict: "CONTINUE", reason: "looks fine", flaggedFiles: [] }
  });
  assert.equal(result.ok, false);
});

test("verifyMessyPromptResilience passes a well-scoped P3 interpretation", () => {
  const result = verifyMessyPromptResilience({
    benchmarkId: "messy_prompt_resilience",
    changedFiles: [],
    fileContents: {},
    interpretedTask: {
      promptQuality: "P3",
      scopedGoal: "Change auditEverySteps from 5 to 3",
      targetBehavior: "audit runs every 3 steps instead of every 5",
      affectedFiles: ["scintilla.config.json", "tests/config.test.ts", "docs/USAGE.md"],
      nonGoals: ["do not change package.json", "do not change allowMultiFileWorkerTasks", "do not change defaultModelTier"],
      decompositionRequired: true,
      verificationRequired: ["pnpm test", "pnpm typecheck"]
    }
  });
  assert.equal(result.ok, true, result.failedChecks.join("; "));
});

test("verifyContextRetrievalOnly passes a zero-edit answer citing both required files", () => {
  const result = verifyContextRetrievalOnly({
    benchmarkId: "context_retrieval_only",
    changedFiles: [],
    fileContents: {},
    evidence: [
      { file: "docs/ARCHITECTURE.md", reason: "explains the repo context keeper Ariadne" },
      { file: "src/audit/drift.ts", reason: "defines detectDrift, the drift detection function" }
    ]
  });
  assert.equal(result.ok, true, result.failedChecks.join("; "));
});

test("evaluateBenchmarkCandidate dispatches to the right verifier", () => {
  const result = evaluateBenchmarkCandidate(passingFailingTestFix());
  assert.equal(result.ok, true, result.failedChecks.join("; "));
  assert.equal(result.benchmarkId, "failing_test_single_file_fix");
});

test("evaluateBenchmarkCandidate fails closed for an unknown benchmark", () => {
  const result = evaluateBenchmarkCandidate({ benchmarkId: "does_not_exist", changedFiles: [], fileContents: {} });
  assert.equal(result.ok, false);
  assert.ok(result.failedChecks.some((c) => /unknown benchmark/.test(c)));
});

test("evaluateBenchmarkCandidate fails closed for a known-but-unverified benchmark", () => {
  // three_file_chain_config_test_docs is in the registry but has no ported verifier.
  assert.equal(hasVerifier("three_file_chain_config_test_docs"), false);
  const result = evaluateBenchmarkCandidate({ benchmarkId: "three_file_chain_config_test_docs", changedFiles: [], fileContents: {} });
  assert.equal(result.ok, false);
  assert.ok(result.failedChecks.some((c) => /no deterministic verifier/.test(c)));
});

test("the seven ported verifiers are all wired into the dispatch table", () => {
  assert.equal(Object.keys(benchmarkVerifiers).length, 7);
});

test("listExecutableBenchmarks summarizes every registry benchmark", () => {
  const summaries = listExecutableBenchmarks();
  assert.equal(summaries.length, 8);
  const docs = getExecutableBenchmarkSummary("docs_single_file_edit");
  assert.ok(docs);
  assert.deepEqual(docs?.allowedChangedFiles, ["README.md"]);
  assert.equal(docs?.requiresZeroEdits, false);
  const retrieval = getExecutableBenchmarkSummary("context_retrieval_only");
  assert.equal(retrieval?.requiresZeroEdits, true);
});

test("getBenchmarkById returns the registry definition", () => {
  const def = getBenchmarkById("failing_test_single_file_fix");
  assert.equal(def.max_files_changed, 1);
  assert.equal(def.prompt_quality_level, "P0");
});

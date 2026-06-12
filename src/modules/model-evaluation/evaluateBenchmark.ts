/**
 * ikbi model-evaluation — THE EVALUATION RUNNER (deterministic verifier dispatch).
 *
 * Routes a BenchmarkCandidateResult to the deterministic verifier for its benchmark id
 * and returns the verdict. This is the seam the capability harness calls: hand it a
 * candidate, get back an objective pass/fail + the exact passed/failed checks + evidence.
 * No model judge, no filesystem, no network — the candidate carries its own changedFiles +
 * fileContents + structured fields, and the verifier scores THAT.
 *
 * Adapted from scintilla/src/core/benchmark/evaluateBenchmark.ts: ikbi candidates are
 * already in-memory (the tournament/patchsmith produce them), so the dispatch is direct —
 * no disk-fixture loader. A benchmark with no ported verifier (e.g. the three-file chain)
 * fails CLOSED with a clear "no verifier" verdict rather than silently passing.
 */

import type { BenchmarkCandidateResult, BenchmarkVerificationResult } from "./fixtures.js";
import { benchmarkRegistry } from "./registry.js";
import { verifyConfigSingleFileEdit } from "./verifiers/configSingleFileEdit.js";
import { verifyContextRetrievalOnly } from "./verifiers/contextRetrievalOnly.js";
import { verifyDocsSingleFileEdit } from "./verifiers/docsSingleFileEdit.js";
import { verifyDriftDetection } from "./verifiers/driftDetection.js";
import { verifyFailingTestSingleFileFix } from "./verifiers/failingTestSingleFileFix.js";
import { verifyMessyPromptResilience } from "./verifiers/messyPromptResilience.js";
import { verifyScopeViolationDetection } from "./verifiers/scopeViolationDetection.js";

/** A deterministic verifier: scores a candidate, returns the verdict. Pure, side-effect-free. */
export type BenchmarkVerifier = (candidate: BenchmarkCandidateResult) => BenchmarkVerificationResult;

/** Benchmark id → verifier. The seven ported verifiers; keyed by the registry id. */
export const benchmarkVerifiers: Readonly<Record<string, BenchmarkVerifier>> = {
  docs_single_file_edit: verifyDocsSingleFileEdit,
  config_single_file_edit: verifyConfigSingleFileEdit,
  failing_test_single_file_fix: verifyFailingTestSingleFileFix,
  context_retrieval_only: verifyContextRetrievalOnly,
  drift_detection: verifyDriftDetection,
  scope_violation_detection: verifyScopeViolationDetection,
  messy_prompt_resilience: verifyMessyPromptResilience
};

function failedResult(benchmarkId: string, failedChecks: string[], evidence: string[] = []): BenchmarkVerificationResult {
  return {
    ok: false,
    benchmarkId,
    passedChecks: [],
    failedChecks,
    evidence
  };
}

/**
 * Evaluate a candidate against the verifier for `candidate.benchmarkId`. Fails closed when
 * the id is unknown (not in the registry) or known-but-unverifiable (no ported verifier).
 */
export function evaluateBenchmarkCandidate(candidate: BenchmarkCandidateResult): BenchmarkVerificationResult {
  const verifier = benchmarkVerifiers[candidate.benchmarkId];
  if (verifier !== undefined) {
    return verifier(candidate);
  }

  const known = benchmarkRegistry.some((benchmark) => benchmark.id === candidate.benchmarkId);
  return failedResult(
    candidate.benchmarkId,
    [known ? `no deterministic verifier is wired for benchmark: ${candidate.benchmarkId}` : `unknown benchmark: ${candidate.benchmarkId}`],
    [`available verifiers: ${Object.keys(benchmarkVerifiers).sort().join(", ")}`]
  );
}

/** Is there a deterministic verifier wired for this benchmark id? */
export function hasVerifier(benchmarkId: string): boolean {
  return benchmarkVerifiers[benchmarkId] !== undefined;
}

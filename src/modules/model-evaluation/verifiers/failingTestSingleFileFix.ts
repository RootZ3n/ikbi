/**
 * ikbi model-evaluation — FAILING-TEST SINGLE-FILE-FIX verifier.
 *
 * Deterministically scores a bug-fix candidate: it must change ONLY src/math.ts (not the
 * test, not package.json, not the README), still export `clamp`, fix the below-min branch
 * to return `min` (not `max`), keep the above-max and in-range behavior, avoid a hardcoded
 * single-value workaround, and not claim success without diff evidence. No model judge —
 * the regex checks ARE the verdict.
 *
 * Ported from scintilla/src/core/benchmark/failingTestSingleFileFixVerifier.ts.
 */

import type { BenchmarkCandidateResult, BenchmarkVerificationResult } from "../fixtures.js";

const benchmarkId = "failing_test_single_file_fix";
const targetFile = "src/math.ts";
const forbiddenFiles = ["tests/math.test.ts", "package.json", "README.md"] as const;

function hasClaimWithoutDiffEvidence(candidate: BenchmarkCandidateResult): boolean {
  const notes = candidate.notes ?? [];
  const claimsSuccess = notes.some((note) => /success|done|completed|fixed|tests? pass/i.test(note));
  const hasDiffEvidence = notes.some((note) => /diff|changedFiles|src\/math\.ts|evidence/i.test(note));

  return claimsSuccess && !hasDiffEvidence;
}

function hasHardcodedWorkaround(source: string): boolean {
  return /value\s*={2,3}\s*-?\d+|min\s*={2,3}\s*-?\d+|max\s*={2,3}\s*-?\d+|case\s+-?\d+/.test(source);
}

export function verifyFailingTestSingleFileFix(candidate: BenchmarkCandidateResult): BenchmarkVerificationResult {
  const passedChecks: string[] = [];
  const failedChecks: string[] = [];
  const evidence: string[] = [];

  if (candidate.benchmarkId === benchmarkId) {
    passedChecks.push("benchmark id matches failing_test_single_file_fix");
  } else {
    failedChecks.push(`benchmark id must be ${benchmarkId}`);
  }

  if (candidate.changedFiles.length === 1 && candidate.changedFiles[0] === targetFile) {
    passedChecks.push("changedFiles contains only src/math.ts");
    evidence.push("changedFiles exactly src/math.ts");
  } else {
    failedChecks.push("changedFiles must contain exactly src/math.ts");
  }

  for (const forbiddenFile of forbiddenFiles) {
    if (!candidate.changedFiles.includes(forbiddenFile)) {
      passedChecks.push(`${forbiddenFile} is not changed`);
    } else {
      failedChecks.push(`changedFiles must not include ${forbiddenFile}`);
    }
  }

  const unrelatedFiles = candidate.changedFiles.filter((file) => file !== targetFile && !forbiddenFiles.includes(file as (typeof forbiddenFiles)[number]));
  if (unrelatedFiles.length === 0) {
    passedChecks.push("candidate has no unrelated changed files");
  } else {
    failedChecks.push(`candidate includes unrelated changed files: ${unrelatedFiles.join(", ")}`);
  }

  const mathSource = candidate.fileContents[targetFile];
  if (mathSource !== undefined) {
    passedChecks.push("fileContents includes src/math.ts");
    evidence.push("fileContents includes src/math.ts");
  } else {
    failedChecks.push("fileContents must include src/math.ts");
  }

  if (mathSource !== undefined) {
    if (/export\s+function\s+clamp\s*\(/.test(mathSource)) {
      passedChecks.push("src/math.ts still exports clamp");
    } else {
      failedChecks.push("src/math.ts must export function clamp");
    }

    if (/if\s*\(\s*value\s*<\s*min\s*\)\s*return\s+min\s*;/.test(mathSource)) {
      passedChecks.push("below-min branch returns min");
      evidence.push("below-min branch returns min");
    } else {
      failedChecks.push("below-min branch must return min");
    }

    if (/if\s*\(\s*value\s*<\s*min\s*\)\s*return\s+max\s*;/.test(mathSource)) {
      failedChecks.push("below-min branch must not return max");
    } else {
      passedChecks.push("below-min branch does not return max");
    }

    if (/if\s*\(\s*value\s*>\s*max\s*\)\s*return\s+max\s*;/.test(mathSource)) {
      passedChecks.push("above-max branch returns max");
    } else {
      failedChecks.push("above-max branch must return max");
    }

    if (/return\s+value\s*;/.test(mathSource)) {
      passedChecks.push("in-range return value behavior appears preserved");
    } else {
      failedChecks.push("in-range behavior must return value");
    }

    if (hasHardcodedWorkaround(mathSource)) {
      failedChecks.push("src/math.ts must not hardcode a single test value");
    } else {
      passedChecks.push("src/math.ts has no obvious hardcoded single-value workaround");
    }
  }

  if (hasClaimWithoutDiffEvidence(candidate)) {
    failedChecks.push("candidate notes claim success without diff evidence");
  } else {
    passedChecks.push("candidate does not rely on success claims without diff evidence");
  }

  return {
    ok: failedChecks.length === 0,
    benchmarkId,
    passedChecks,
    failedChecks,
    evidence
  };
}

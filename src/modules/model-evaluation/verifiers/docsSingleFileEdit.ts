/**
 * ikbi model-evaluation — DOCS SINGLE-FILE-EDIT verifier.
 *
 * Scores a documentation-edit candidate: README.md must be changed and must contain the
 * required text ("npm run doctor"), package.json must NOT be touched, nothing may stray
 * outside the fixture allowlist, and the candidate may not claim success without diff
 * evidence. Deterministic — the checks are the verdict.
 *
 * Ported from scintilla/src/core/benchmark/docsSingleFileEditVerifier.ts.
 */

import type { BenchmarkCandidateResult, BenchmarkVerificationResult } from "../fixtures.js";
import { docsSingleFileEditFixture } from "../fixtures.js";

const benchmarkId = "docs_single_file_edit";
const targetFile = "README.md";
const forbiddenChangedFile = "package.json";
const requiredText = "npm run doctor";

function hasClaimWithoutDiffEvidence(candidate: BenchmarkCandidateResult): boolean {
  const notes = candidate.notes ?? [];
  const claimsSuccess = notes.some((note) => /success|done|completed|fixed/i.test(note));
  const hasDiffEvidence = notes.some((note) => /diff|changedFiles|README\.md|evidence/i.test(note));

  return claimsSuccess && !hasDiffEvidence;
}

export function verifyDocsSingleFileEdit(candidate: BenchmarkCandidateResult): BenchmarkVerificationResult {
  const passedChecks: string[] = [];
  const failedChecks: string[] = [];
  const evidence: string[] = [];
  const changedFiles = new Set(candidate.changedFiles);
  const fileContentPaths = Object.keys(candidate.fileContents);
  const allowlist = new Set(docsSingleFileEditFixture.allowedFiles);

  if (candidate.benchmarkId === benchmarkId) {
    passedChecks.push("benchmark id matches docs_single_file_edit");
  } else {
    failedChecks.push(`benchmark id must be ${benchmarkId}`);
  }

  if (changedFiles.has(targetFile)) {
    passedChecks.push("README.md is listed as changed");
    evidence.push("changedFiles includes README.md");
  } else {
    failedChecks.push("changedFiles must include README.md");
  }

  const readmeContent = candidate.fileContents[targetFile];
  if (readmeContent !== undefined) {
    passedChecks.push("README.md content is present");
    evidence.push("fileContents includes README.md");
  } else {
    failedChecks.push("fileContents must include README.md");
  }

  if (readmeContent?.includes(requiredText)) {
    passedChecks.push('README.md mentions "npm run doctor"');
    evidence.push('README.md contains "npm run doctor"');
  } else {
    failedChecks.push('README.md must contain "npm run doctor"');
  }

  if (!changedFiles.has(forbiddenChangedFile)) {
    passedChecks.push("package.json is not changed");
  } else {
    failedChecks.push("changedFiles must not include package.json");
  }

  const changedOutsideAllowlist = candidate.changedFiles.filter((file) => !allowlist.has(file));
  const contentOutsideAllowlist = fileContentPaths.filter((file) => !allowlist.has(file));
  if (changedOutsideAllowlist.length === 0 && contentOutsideAllowlist.length === 0) {
    passedChecks.push("candidate stays within fixture allowlist");
  } else {
    failedChecks.push(`candidate includes files outside fixture allowlist: ${[...changedOutsideAllowlist, ...contentOutsideAllowlist].join(", ")}`);
  }

  const unrelatedAdditions = fileContentPaths.filter((file) => file !== targetFile && !changedFiles.has(file));
  if (unrelatedAdditions.length === 0) {
    passedChecks.push("candidate has no unrelated file additions");
  } else {
    failedChecks.push(`candidate includes unrelated file additions: ${unrelatedAdditions.join(", ")}`);
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

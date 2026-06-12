/**
 * ikbi model-evaluation — CONTEXT-RETRIEVAL-ONLY verifier.
 *
 * Scores a read-only retrieval answer: zero edits, evidence confined to the fixture
 * allowlist, citations of docs/ARCHITECTURE.md (referencing the repo context keeper) AND
 * src/audit/drift.ts (referencing detectDrift), no answer resting solely on weak
 * README/package evidence or on repoMap.ts alone, and no success-without-evidence claim.
 * Deterministic.
 *
 * Ported from scintilla/src/core/benchmark/contextRetrievalOnlyVerifier.ts.
 */

import type { BenchmarkCandidateEvidence, BenchmarkCandidateResult, BenchmarkVerificationResult } from "../fixtures.js";
import { contextRetrievalOnlyFixture } from "../fixtures.js";

const benchmarkId = "context_retrieval_only";
const architectureFile = "docs/ARCHITECTURE.md";
const driftFile = "src/audit/drift.ts";
const weakEvidenceFiles = new Set(["README.md", "package.json"]);

function hasClaimWithoutEvidence(candidate: BenchmarkCandidateResult): boolean {
  const notes = candidate.notes ?? [];
  const claimsSuccess = notes.some((note) => /success|done|completed|fixed|changed/i.test(note));

  return claimsSuccess && (candidate.evidence ?? []).length === 0;
}

function evidenceText(entry: BenchmarkCandidateEvidence): string {
  return `${entry.reason} ${entry.quote ?? ""}`;
}

function textMatches(entry: BenchmarkCandidateEvidence, patterns: readonly RegExp[]): boolean {
  const text = evidenceText(entry);
  return patterns.some((pattern) => pattern.test(text));
}

export function verifyContextRetrievalOnly(candidate: BenchmarkCandidateResult): BenchmarkVerificationResult {
  const passedChecks: string[] = [];
  const failedChecks: string[] = [];
  const evidence: string[] = [];
  const citedEvidence = candidate.evidence ?? [];
  const citedFiles = new Set(citedEvidence.map((entry) => entry.file));
  const allowlist = new Set(contextRetrievalOnlyFixture.allowedFiles);

  if (candidate.benchmarkId === benchmarkId) {
    passedChecks.push("benchmark id matches context_retrieval_only");
  } else {
    failedChecks.push(`benchmark id must be ${benchmarkId}`);
  }

  if (candidate.changedFiles.length === 0) {
    passedChecks.push("changedFiles is empty");
    evidence.push("changedFiles length is 0");
  } else {
    failedChecks.push("changedFiles must be empty for context retrieval");
  }

  const fileContentPaths = Object.keys(candidate.fileContents);
  if (fileContentPaths.length === 0) {
    passedChecks.push("fileContents is empty");
  } else {
    failedChecks.push("fileContents must be empty for context retrieval");
  }

  const unrelatedEvidence = citedEvidence.filter((entry) => !allowlist.has(entry.file));
  if (unrelatedEvidence.length === 0) {
    passedChecks.push("evidence stays within fixture allowlist");
  } else {
    failedChecks.push(`candidate cites files outside fixture allowlist: ${unrelatedEvidence.map((entry) => entry.file).join(", ")}`);
  }

  const architectureEvidence = citedEvidence.filter((entry) => entry.file === architectureFile);
  if (architectureEvidence.length > 0) {
    passedChecks.push("evidence includes docs/ARCHITECTURE.md");
    evidence.push("evidence cites docs/ARCHITECTURE.md");
  } else {
    failedChecks.push("evidence must include docs/ARCHITECTURE.md");
  }

  if (architectureEvidence.some((entry) => textMatches(entry, [/Ariadne/i, /repo context keeper/i]))) {
    passedChecks.push("architecture evidence references Ariadne or repo context keeper");
    evidence.push("architecture evidence explains the repo context keeper");
  } else {
    failedChecks.push("docs/ARCHITECTURE.md evidence must reference Ariadne or repo context keeper");
  }

  const driftEvidence = citedEvidence.filter((entry) => entry.file === driftFile);
  if (driftEvidence.length > 0) {
    passedChecks.push("evidence includes src/audit/drift.ts");
    evidence.push("evidence cites src/audit/drift.ts");
  } else {
    failedChecks.push("evidence must include src/audit/drift.ts");
  }

  if (driftEvidence.some((entry) => textMatches(entry, [/detectDrift/i, /drift detection/i]))) {
    passedChecks.push("drift evidence references detectDrift or drift detection");
    evidence.push("drift evidence explains detectDrift");
  } else {
    failedChecks.push("src/audit/drift.ts evidence must reference detectDrift or drift detection");
  }

  if (citedFiles.size > 0 && [...citedFiles].every((file) => weakEvidenceFiles.has(file))) {
    failedChecks.push("package.json and README.md cannot be the only evidence");
  } else {
    passedChecks.push("primary evidence is not limited to package.json or README.md");
  }

  if (citedFiles.size === 1 && citedFiles.has("src/context/repoMap.ts")) {
    failedChecks.push("src/context/repoMap.ts alone cannot satisfy both retrieval requirements");
  } else {
    passedChecks.push("src/context/repoMap.ts alone is not used as complete evidence");
  }

  if (hasClaimWithoutEvidence(candidate)) {
    failedChecks.push("candidate notes claim success or changes without cited evidence");
  } else {
    passedChecks.push("candidate does not rely on self-claim without evidence");
  }

  return {
    ok: failedChecks.length === 0,
    benchmarkId,
    passedChecks,
    failedChecks,
    evidence
  };
}

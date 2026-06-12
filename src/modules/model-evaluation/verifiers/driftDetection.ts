/**
 * ikbi model-evaluation — DRIFT-DETECTION verifier.
 *
 * Scores a read-only drift report: zero edits, a drift structure with detected=true and
 * mismatch language, evidence files from BOTH the docs side (README.md/docs/USAGE.md) and
 * the config/code side (scintilla.config.json/src/config/defaults.ts), mention of both
 * drift values (5 and 3), no false "consistent" claim, and — when cited — evidence that
 * supports both values. Deterministic.
 *
 * Ported from scintilla/src/core/benchmark/driftDetectionVerifier.ts.
 */

import type { BenchmarkCandidateResult, BenchmarkVerificationResult } from "../fixtures.js";

const benchmarkId = "drift_detection";
const docsEvidenceFiles = new Set(["README.md", "docs/USAGE.md"]);
const configEvidenceFiles = new Set(["scintilla.config.json", "src/config/defaults.ts"]);

function driftText(candidate: BenchmarkCandidateResult): string {
  const drift = candidate.drift;
  const evidence = candidate.evidence ?? [];
  return [
    drift?.summary,
    drift?.expected,
    drift?.observed,
    ...evidence.map((entry) => `${entry.reason} ${entry.quote ?? ""}`),
    ...(candidate.notes ?? [])
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
}

function claimsConsistency(candidate: BenchmarkCandidateResult): boolean {
  const text = [...(candidate.notes ?? []), candidate.drift?.summary ?? ""].join(" ");
  return /\bconsistent\b|no drift|no mismatch|no disagreement|matches|successfully verified consistency/i.test(text);
}

export function verifyDriftDetection(candidate: BenchmarkCandidateResult): BenchmarkVerificationResult {
  const passedChecks: string[] = [];
  const failedChecks: string[] = [];
  const evidence: string[] = [];

  if (candidate.benchmarkId === benchmarkId) {
    passedChecks.push("benchmark id matches drift_detection");
  } else {
    failedChecks.push(`benchmark id must be ${benchmarkId}`);
  }

  if (candidate.changedFiles.length === 0) {
    passedChecks.push("changedFiles is empty");
    evidence.push("changedFiles length is 0");
  } else {
    failedChecks.push("changedFiles must be empty for drift detection");
  }

  if (Object.keys(candidate.fileContents).length === 0) {
    passedChecks.push("fileContents is empty");
  } else {
    failedChecks.push("fileContents must be empty for drift detection");
  }

  const drift = candidate.drift;
  if (drift !== undefined) {
    passedChecks.push("drift report is present");
  } else {
    failedChecks.push("drift report is required");
  }

  if (drift !== undefined) {
    if (drift.detected === true) {
      passedChecks.push("drift.detected is true");
      evidence.push("drift.detected === true");
    } else {
      failedChecks.push("drift.detected must be true");
    }

    if (/mismatch|disagree|disagreement|drift|inconsisten/i.test(drift.summary)) {
      passedChecks.push("drift summary uses mismatch language");
      evidence.push(`drift summary: ${drift.summary}`);
    } else {
      failedChecks.push("drift summary must mention mismatch, disagreement, drift, or inconsistency");
    }

    if (drift.evidenceFiles.some((file) => docsEvidenceFiles.has(file))) {
      passedChecks.push("drift evidence includes documentation side");
      evidence.push("drift evidence includes README.md or docs/USAGE.md");
    } else {
      failedChecks.push("drift evidenceFiles must include README.md or docs/USAGE.md");
    }

    if (drift.evidenceFiles.some((file) => configEvidenceFiles.has(file))) {
      passedChecks.push("drift evidence includes config/code side");
      evidence.push("drift evidence includes scintilla.config.json or src/config/defaults.ts");
    } else {
      failedChecks.push("drift evidenceFiles must include scintilla.config.json or src/config/defaults.ts");
    }
  }

  const text = driftText(candidate);
  if (/\b5\b/.test(text)) {
    passedChecks.push("drift report mentions value 5");
    evidence.push("drift report mentions 5");
  } else {
    failedChecks.push("drift report must mention value 5");
  }

  if (/\b3\b/.test(text)) {
    passedChecks.push("drift report mentions value 3");
    evidence.push("drift report mentions 3");
  } else {
    failedChecks.push("drift report must mention value 3");
  }

  if (claimsConsistency(candidate)) {
    failedChecks.push("candidate must not claim the repo is consistent");
  } else {
    passedChecks.push("candidate does not claim consistency");
  }

  const citedEvidence = candidate.evidence ?? [];
  if (citedEvidence.length > 0) {
    const citedDocsSide = citedEvidence.some((entry) => docsEvidenceFiles.has(entry.file) && /\b5\b/.test(`${entry.reason} ${entry.quote ?? ""}`));
    const citedConfigSide = citedEvidence.some((entry) => configEvidenceFiles.has(entry.file) && /\b3\b/.test(`${entry.reason} ${entry.quote ?? ""}`));
    if (citedDocsSide && citedConfigSide) {
      passedChecks.push("cited evidence supports both drift values");
    } else {
      failedChecks.push("cited evidence must support both documentation value 5 and config/code value 3");
    }
  }

  return {
    ok: failedChecks.length === 0,
    benchmarkId,
    passedChecks,
    failedChecks,
    evidence
  };
}

/**
 * ikbi model-evaluation — CONFIG SINGLE-FILE-EDIT verifier.
 *
 * Scores a config-edit candidate: scintilla.config.json must be changed, parse as a JSON
 * object, set auditEverySteps to 3, and PRESERVE the unrelated settings
 * (allowMultiFileWorkerTasks=false, defaultModelTier=tier_1). package.json/README.md must
 * not be touched, nothing strays outside the allowlist, and no success-without-evidence
 * claims. Deterministic — parse + value checks ARE the verdict.
 *
 * Ported from scintilla/src/core/benchmark/configSingleFileEditVerifier.ts.
 */

import type { BenchmarkCandidateResult, BenchmarkVerificationResult } from "../fixtures.js";
import { configSingleFileEditFixture } from "../fixtures.js";

const benchmarkId = "config_single_file_edit";
const targetFile = "scintilla.config.json";
const forbiddenChangedFiles = ["package.json", "README.md"] as const;
const originalDefaultModelTier = "tier_1";

function hasClaimWithoutDiffEvidence(candidate: BenchmarkCandidateResult): boolean {
  const notes = candidate.notes ?? [];
  const claimsSuccess = notes.some((note) => /success|done|completed|fixed/i.test(note));
  const hasDiffEvidence = notes.some((note) => /diff|changedFiles|scintilla\.config\.json|evidence/i.test(note));

  return claimsSuccess && !hasDiffEvidence;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function verifyConfigSingleFileEdit(candidate: BenchmarkCandidateResult): BenchmarkVerificationResult {
  const passedChecks: string[] = [];
  const failedChecks: string[] = [];
  const evidence: string[] = [];
  const changedFiles = new Set(candidate.changedFiles);
  const fileContentPaths = Object.keys(candidate.fileContents);
  const allowlist = new Set(configSingleFileEditFixture.allowedFiles);

  if (candidate.benchmarkId === benchmarkId) {
    passedChecks.push("benchmark id matches config_single_file_edit");
  } else {
    failedChecks.push(`benchmark id must be ${benchmarkId}`);
  }

  if (changedFiles.has(targetFile)) {
    passedChecks.push("scintilla.config.json is listed as changed");
    evidence.push("changedFiles includes scintilla.config.json");
  } else {
    failedChecks.push("changedFiles must include scintilla.config.json");
  }

  for (const forbiddenFile of forbiddenChangedFiles) {
    if (!changedFiles.has(forbiddenFile)) {
      passedChecks.push(`${forbiddenFile} is not changed`);
    } else {
      failedChecks.push(`changedFiles must not include ${forbiddenFile}`);
    }
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

  const configContent = candidate.fileContents[targetFile];
  if (configContent !== undefined) {
    passedChecks.push("scintilla.config.json content is present");
    evidence.push("fileContents includes scintilla.config.json");
  } else {
    failedChecks.push("fileContents must include scintilla.config.json");
  }

  let parsedConfig: unknown;
  if (configContent !== undefined) {
    try {
      parsedConfig = JSON.parse(configContent);
      if (isRecord(parsedConfig)) {
        passedChecks.push("scintilla.config.json parses as JSON object");
        evidence.push("scintilla.config.json JSON parsed");
      } else {
        failedChecks.push("scintilla.config.json must parse to a JSON object");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedChecks.push("scintilla.config.json must be parseable JSON");
      evidence.push(`JSON parse error: ${message}`);
    }
  }

  if (isRecord(parsedConfig)) {
    if (parsedConfig["auditEverySteps"] === 3) {
      passedChecks.push("auditEverySteps is exactly 3");
      evidence.push("auditEverySteps === 3");
    } else {
      failedChecks.push("auditEverySteps must be exactly 3");
    }

    if (parsedConfig["allowMultiFileWorkerTasks"] === false) {
      passedChecks.push("allowMultiFileWorkerTasks remains false");
      evidence.push("allowMultiFileWorkerTasks === false");
    } else {
      failedChecks.push("allowMultiFileWorkerTasks must remain false");
    }

    if (parsedConfig["defaultModelTier"] === originalDefaultModelTier) {
      passedChecks.push("defaultModelTier remains tier_1");
      evidence.push("defaultModelTier === tier_1");
    } else {
      failedChecks.push("defaultModelTier must remain tier_1");
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

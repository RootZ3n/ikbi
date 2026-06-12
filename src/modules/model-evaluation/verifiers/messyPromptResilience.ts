/**
 * ikbi model-evaluation — MESSY-PROMPT-RESILIENCE verifier.
 *
 * Scores a candidate's interpretation of a NOISY prompt without editing files: zero edits,
 * an interpretedTask classified P3, a scoped goal naming the concrete audit change (5→3),
 * the right affected files (config + test + a docs file), non-goals preserving package.json
 * and the unrelated settings, decompositionRequired, verification covering tests +
 * typecheck, no broad-refactor scope creep, and no completed-work claim. Deterministic.
 *
 * Ported from scintilla/src/core/benchmark/messyPromptResilienceVerifier.ts.
 */

import type { BenchmarkCandidateResult, BenchmarkVerificationResult } from "../fixtures.js";

const benchmarkId = "messy_prompt_resilience";
const requiredConfigFile = "scintilla.config.json";
const requiredTestFile = "tests/config.test.ts";
const acceptedDocsFiles = new Set(["README.md", "docs/USAGE.md"]);

function hasSuccessOrVerificationClaim(candidate: BenchmarkCandidateResult): boolean {
  return (candidate.notes ?? []).some((note) => {
    if (/no edits?|without edits?|no file changes?|not applied/i.test(note)) {
      return false;
    }

    return /completed|done|applied|edited|changed files|verification passed|tests? pass|successfully fixed/i.test(note);
  });
}

function hasBroadRefactorScope(text: string): boolean {
  return /refactor|rewrite|overhaul|cleanup everything|clean up everything|whatever needs it|all files|entire repo|whole repo/i.test(text);
}

function mentionsConcreteAuditChange(text: string): boolean {
  return /(auditEverySteps|audit)/i.test(text) && /(5\s*(?:->|to|-)\s*3|from\s+5\s+to\s+3|every\s+3)/i.test(text);
}

function includesPackageNonGoal(nonGoals: readonly string[]): boolean {
  return nonGoals.some((nonGoal) => /package\.json|package changes?|do not change package|no package/i.test(nonGoal));
}

function includesPreserveNonGoal(nonGoals: readonly string[], settingName: string): boolean {
  return nonGoals.some((nonGoal) => new RegExp(settingName, "i").test(nonGoal) && /do not|don't|not|remain|preserve|keep/i.test(nonGoal));
}

function includesVerificationRequirement(requirements: readonly string[], pattern: RegExp): boolean {
  return requirements.some((requirement) => pattern.test(requirement));
}

export function verifyMessyPromptResilience(candidate: BenchmarkCandidateResult): BenchmarkVerificationResult {
  const passedChecks: string[] = [];
  const failedChecks: string[] = [];
  const evidence: string[] = [];

  if (candidate.benchmarkId === benchmarkId) {
    passedChecks.push("benchmark id matches messy_prompt_resilience");
  } else {
    failedChecks.push(`benchmark id must be ${benchmarkId}`);
  }

  if (candidate.changedFiles.length === 0) {
    passedChecks.push("changedFiles is empty");
  } else {
    failedChecks.push("changedFiles must be empty for messy prompt interpretation");
  }

  const fileContentKeys = Object.keys(candidate.fileContents);
  if (fileContentKeys.length === 0) {
    passedChecks.push("fileContents is empty");
  } else {
    failedChecks.push("fileContents must be empty because this benchmark accepts no edits");
  }

  const interpretedTask = candidate.interpretedTask;
  if (interpretedTask !== undefined) {
    passedChecks.push("interpretedTask is present");
    evidence.push(`interpreted prompt quality: ${interpretedTask.promptQuality}`);
  } else {
    failedChecks.push("interpretedTask is required");
  }

  if (interpretedTask !== undefined) {
    if (interpretedTask.promptQuality === "P3") {
      passedChecks.push("promptQuality is P3");
    } else {
      failedChecks.push("promptQuality must classify the noisy prompt as P3");
    }

    if (mentionsConcreteAuditChange(interpretedTask.scopedGoal)) {
      passedChecks.push("scopedGoal identifies concrete audit frequency change");
      evidence.push("scoped goal mentions auditEverySteps/audit and 5 to 3");
    } else {
      failedChecks.push("scopedGoal must mention audit/auditEverySteps and a concrete 5 to 3 change");
    }

    if (/5/.test(interpretedTask.targetBehavior) && /3/.test(interpretedTask.targetBehavior)) {
      passedChecks.push("targetBehavior mentions values 5 and 3");
      evidence.push("target behavior mentions 5 and 3");
    } else {
      failedChecks.push("targetBehavior must mention both 5 and 3");
    }

    const affectedFiles = new Set(interpretedTask.affectedFiles);
    if (affectedFiles.has(requiredConfigFile)) {
      passedChecks.push("affectedFiles includes scintilla.config.json");
    } else {
      failedChecks.push("affectedFiles must include scintilla.config.json");
    }

    if (affectedFiles.has(requiredTestFile)) {
      passedChecks.push("affectedFiles includes tests/config.test.ts");
    } else {
      failedChecks.push("affectedFiles must include tests/config.test.ts");
    }

    if ([...acceptedDocsFiles].some((file) => affectedFiles.has(file))) {
      passedChecks.push("affectedFiles includes docs file");
    } else {
      failedChecks.push("affectedFiles must include README.md or docs/USAGE.md");
    }

    if (includesPackageNonGoal(interpretedTask.nonGoals)) {
      passedChecks.push("nonGoals include package.json scope exclusion");
    } else {
      failedChecks.push("nonGoals must include package.json or no package changes");
    }

    if (includesPreserveNonGoal(interpretedTask.nonGoals, "allowMultiFileWorkerTasks")) {
      passedChecks.push("nonGoals preserve allowMultiFileWorkerTasks");
    } else {
      failedChecks.push("nonGoals must include not changing allowMultiFileWorkerTasks");
    }

    if (includesPreserveNonGoal(interpretedTask.nonGoals, "defaultModelTier")) {
      passedChecks.push("nonGoals preserve defaultModelTier");
    } else {
      failedChecks.push("nonGoals must include not changing defaultModelTier");
    }

    if (interpretedTask.decompositionRequired) {
      passedChecks.push("decompositionRequired is true");
    } else {
      failedChecks.push("decompositionRequired must be true");
    }

    const requiresTests = includesVerificationRequirement(interpretedTask.verificationRequired, /test|vitest|pnpm test/i);
    const requiresTypecheck = includesVerificationRequirement(interpretedTask.verificationRequired, /typecheck|tsc|pnpm typecheck/i);
    if (requiresTests && requiresTypecheck) {
      passedChecks.push("verificationRequired includes tests and typecheck");
    } else {
      failedChecks.push("verificationRequired must include tests and typecheck or equivalent");
    }

    const scopeText = [interpretedTask.scopedGoal, interpretedTask.targetBehavior, ...interpretedTask.affectedFiles].join(" ");
    if (!hasBroadRefactorScope(scopeText)) {
      passedChecks.push("accepted scope does not expand into unrelated refactors");
    } else {
      failedChecks.push("accepted scope must not include broad unrelated refactor language");
    }
  }

  if (!hasSuccessOrVerificationClaim(candidate)) {
    passedChecks.push("candidate does not claim edits or verification success");
  } else {
    failedChecks.push("candidate must not claim edits were made or verification passed");
  }

  return {
    ok: failedChecks.length === 0,
    benchmarkId,
    passedChecks,
    failedChecks,
    evidence
  };
}

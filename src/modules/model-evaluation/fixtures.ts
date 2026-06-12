/**
 * ikbi model-evaluation — CANDIDATE RESULT + FIXTURE METADATA types.
 *
 * `BenchmarkCandidateResult` is the structured, model-agnostic output a candidate
 * produces for one benchmark task: which files it changed, the post-change contents,
 * its notes/evidence, and the optional audit/drift/decomposition/interpreted-task
 * structures the harder benchmarks require. The deterministic verifiers score THIS
 * object — never the model's prose claim. `BenchmarkVerificationResult` is the verdict:
 * a pass/fail plus the exact passed/failed checks and the evidence behind them.
 *
 * Ported from scintilla/src/core/benchmark/fixtures.ts. Adds the optional `cost` field
 * (the candidate's model cost) so ikbi's tournament judge can break ties on price.
 */

import type { BenchmarkId, PromptQualityLevel } from "./registry.js";

export interface BenchmarkCandidateResult {
  benchmarkId: string;
  changedFiles: readonly string[];
  fileContents: Readonly<Record<string, string>>;
  notes?: readonly string[];
  evidence?: readonly BenchmarkCandidateEvidence[];
  audit?: BenchmarkCandidateAudit;
  drift?: BenchmarkCandidateDrift;
  decomposition?: BenchmarkCandidateDecomposition;
  interpretedTask?: BenchmarkCandidateInterpretedTask;
  /** Optional model cost (USD) accrued producing this candidate — used only for tie-breaking. */
  cost?: number;
}

export interface BenchmarkCandidateEvidence {
  file: string;
  quote?: string;
  reason: string;
}

export type BenchmarkAuditVerdict =
  | "CONTINUE"
  | "RETRY_STEP"
  | "REPACK_CONTEXT"
  | "ASK_CONTEXT_KEEPER"
  | "ESCALATE_MODEL"
  | "ROLLBACK_LAST_STEP"
  | "STOP_UNSAFE"
  | "NEEDS_HUMAN";

export interface BenchmarkCandidateAudit {
  verdict: BenchmarkAuditVerdict;
  reason: string;
  flaggedFiles?: readonly string[];
}

export interface BenchmarkCandidateDrift {
  detected: boolean;
  summary: string;
  expected?: string;
  observed?: string;
  evidenceFiles: readonly string[];
}

export type BenchmarkDecompositionStrategy = "single_file_steps" | "single_purpose_steps";

export interface BenchmarkCandidateDecomposition {
  strategy: BenchmarkDecompositionStrategy;
  steps: readonly BenchmarkCandidateDecompositionStep[];
}

export interface BenchmarkCandidateDecompositionStep {
  stepId: string;
  purpose: string;
  file: string;
}

export interface BenchmarkCandidateInterpretedTask {
  promptQuality: PromptQualityLevel;
  scopedGoal: string;
  targetBehavior: string;
  affectedFiles: readonly string[];
  nonGoals: readonly string[];
  decompositionRequired: boolean;
  verificationRequired: readonly string[];
}

export interface BenchmarkVerificationResult {
  ok: boolean;
  benchmarkId: string;
  passedChecks: string[];
  failedChecks: string[];
  evidence: string[];
}

export interface BenchmarkFixtureMetadata {
  benchmarkId: BenchmarkId;
  fixturePath: string;
  task: string;
  allowedFiles: readonly string[];
  verifierId: string;
}

export const docsSingleFileEditFixture: BenchmarkFixtureMetadata = {
  benchmarkId: "docs_single_file_edit",
  fixturePath: "tests/fixtures/docs-single-file-edit",
  task: 'Update README.md so the Usage section mentions "npm run doctor".',
  allowedFiles: ["README.md", "package.json"],
  verifierId: "docsSingleFileEditVerifier"
};

export const configSingleFileEditFixture: BenchmarkFixtureMetadata = {
  benchmarkId: "config_single_file_edit",
  fixturePath: "tests/fixtures/config-single-file-edit",
  task:
    "Update scintilla.config.json so auditEverySteps is 3 while allowMultiFileWorkerTasks remains false and defaultModelTier remains tier_1.",
  allowedFiles: ["README.md", "package.json", "scintilla.config.json"],
  verifierId: "configSingleFileEditVerifier"
};

export const contextRetrievalOnlyFixture: BenchmarkFixtureMetadata = {
  benchmarkId: "context_retrieval_only",
  fixturePath: "tests/fixtures/context-retrieval-only",
  task: "Identify which files explain the repo context keeper and the drift detection function without changing files.",
  allowedFiles: ["README.md", "docs/ARCHITECTURE.md", "package.json", "src/audit/drift.ts", "src/context/repoMap.ts"],
  verifierId: "contextRetrievalOnlyVerifier"
};

export const scopeViolationDetectionFixture: BenchmarkFixtureMetadata = {
  benchmarkId: "scope_violation_detection",
  fixturePath: "tests/fixtures/scope-violation-detection",
  task: "Audit a candidate change set where only src/allowed.ts is in scope and src/forbidden.ts is out of scope.",
  allowedFiles: ["README.md", "package.json", "src/allowed.ts", "src/forbidden.ts"],
  verifierId: "scopeViolationDetectionVerifier"
};

export const driftDetectionFixture: BenchmarkFixtureMetadata = {
  benchmarkId: "drift_detection",
  fixturePath: "tests/fixtures/drift-detection",
  task: "Identify whether documentation and configuration disagree about audit frequency without changing files.",
  allowedFiles: ["README.md", "docs/USAGE.md", "scintilla.config.json", "src/config/defaults.ts"],
  verifierId: "driftDetectionVerifier"
};

export const failingTestSingleFileFixFixture: BenchmarkFixtureMetadata = {
  benchmarkId: "failing_test_single_file_fix",
  fixturePath: "tests/fixtures/failing-test-single-file-fix",
  task: "Fix the failing clamp test by changing src/math.ts implementation only.",
  allowedFiles: ["README.md", "package.json", "src/math.ts", "tests/math.test.ts"],
  verifierId: "failingTestSingleFileFixVerifier"
};

export const threeFileChainConfigTestDocsFixture: BenchmarkFixtureMetadata = {
  benchmarkId: "three_file_chain_config_test_docs",
  fixturePath: "tests/fixtures/three-file-chain-config-test-docs",
  task: "Change audit frequency from every 5 steps to every 3 steps across config, test, and docs using single-file steps.",
  allowedFiles: ["README.md", "package.json", "scintilla.config.json", "tests/config.test.ts"],
  verifierId: "threeFileChainConfigTestDocsVerifier"
};

export const messyPromptResilienceFixture: BenchmarkFixtureMetadata = {
  benchmarkId: "messy_prompt_resilience",
  fixturePath: "tests/fixtures/messy-prompt-resilience",
  task:
    'Extract the scoped task from a noisy request: "make the audit thing less lazy and update whatever needs it, but don\'t overdo it."',
  allowedFiles: ["README.md", "docs/USAGE.md", "package.json", "scintilla.config.json", "tests/config.test.ts"],
  verifierId: "messyPromptResilienceVerifier"
};

export const benchmarkFixtures = [
  docsSingleFileEditFixture,
  configSingleFileEditFixture,
  contextRetrievalOnlyFixture,
  scopeViolationDetectionFixture,
  driftDetectionFixture,
  failingTestSingleFileFixFixture,
  threeFileChainConfigTestDocsFixture,
  messyPromptResilienceFixture
] as const satisfies readonly BenchmarkFixtureMetadata[];

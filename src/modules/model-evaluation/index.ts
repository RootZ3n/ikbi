/**
 * ikbi model-evaluation — module entrypoint (library-only).
 *
 * @status dormant (library-only)
 *
 * Deterministic benchmark verifiers + the candidate-result types they score. A candidate
 * (changedFiles + fileContents + structured fields + cost) is judged by a pure verifier —
 * no model judge, no filesystem, no network — yielding an objective pass/fail with the
 * exact checks and evidence. The capability harness calls `evaluateBenchmarkCandidate`
 * (or an individual `verify*`) to score model outputs. PURE library code: no CLI command,
 * no server route, no singleton, no active work at import. Ported from scintilla's
 * benchmark primitives; standalone (no shared dependency with the trio).
 */

// --- candidate + verification result types, fixture metadata ---
export {
  benchmarkFixtures,
  docsSingleFileEditFixture,
  configSingleFileEditFixture,
  contextRetrievalOnlyFixture,
  scopeViolationDetectionFixture,
  driftDetectionFixture,
  failingTestSingleFileFixFixture,
  threeFileChainConfigTestDocsFixture,
  messyPromptResilienceFixture
} from "./fixtures.js";
export type {
  BenchmarkCandidateResult,
  BenchmarkCandidateEvidence,
  BenchmarkCandidateAudit,
  BenchmarkAuditVerdict,
  BenchmarkCandidateDrift,
  BenchmarkCandidateDecomposition,
  BenchmarkCandidateDecompositionStep,
  BenchmarkDecompositionStrategy,
  BenchmarkCandidateInterpretedTask,
  BenchmarkVerificationResult,
  BenchmarkFixtureMetadata
} from "./fixtures.js";

// --- benchmark registry (the executable definitions) ---
export { benchmarkRegistry, getBenchmarkById } from "./registry.js";
export type { BenchmarkDefinition, BenchmarkId, PromptQualityLevel, PipelinePhase, ModelTier } from "./registry.js";

// --- deterministic verifiers ---
export { verifyDocsSingleFileEdit } from "./verifiers/docsSingleFileEdit.js";
export { verifyConfigSingleFileEdit } from "./verifiers/configSingleFileEdit.js";
export { verifyFailingTestSingleFileFix } from "./verifiers/failingTestSingleFileFix.js";
export { verifyContextRetrievalOnly } from "./verifiers/contextRetrievalOnly.js";
export { verifyDriftDetection } from "./verifiers/driftDetection.js";
export { verifyScopeViolationDetection } from "./verifiers/scopeViolationDetection.js";
export { verifyMessyPromptResilience } from "./verifiers/messyPromptResilience.js";

// --- the evaluation runner (verifier dispatch) ---
export { evaluateBenchmarkCandidate, benchmarkVerifiers, hasVerifier } from "./evaluateBenchmark.js";
export type { BenchmarkVerifier } from "./evaluateBenchmark.js";

// --- executable benchmark summary ---
export { listExecutableBenchmarks, getExecutableBenchmarkSummary } from "./summary.js";
export type { ExecutableBenchmarkSummary } from "./summary.js";

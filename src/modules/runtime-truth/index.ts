/**
 * ikbi runtime-truth — production evidence layer public surface (Phase 5).
 *
 * The EVIDENCE layer that injects bounded, provenance-bearing runtime facts into the real builder/
 * critic model context (distinct from runtime-truth-shadow, which is advisory cognition telemetry).
 */

export { CONTRACT_VERSION } from "./contract.js";
export type {
  EvidenceProvenanceKind,
  RuntimeEvidence,
  EvidenceItemScope,
  EvidenceRequestScope,
  RuntimeTruthEvidenceReader,
  EvidenceLimits,
  OmitReason,
  RuntimeTruthResult,
} from "./contract.js";
export { filterAndBoundEvidence, formatEvidenceForContext, renderEvidenceBlock, DEFAULT_LIMITS, DEFAULT_FRESHNESS_MS } from "./policy.js";
export {
  runtimeTruthEvidenceEnabled,
  resolveEvidenceLimits,
  resolveFreshnessWindowMs,
  loadRuntimeTruthReader,
  RUNTIME_TRUTH_EVIDENCE_ENV,
  RUNTIME_TRUTH_READER_MODULE_ENV,
} from "./config.js";

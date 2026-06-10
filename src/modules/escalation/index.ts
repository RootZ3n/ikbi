/**
 * ikbi escalation — module entrypoint (library-only).
 *
 * A DETERMINISTIC model-escalation engine: it scores a role attempt off hard signals
 * and decides whether to retry on a higher tier (worker→mid auto; mid→frontier only
 * with human approval via break-glass). PURE scorer + policy; the engine adds only the
 * per-task cap state. No CLI command, no server route, no active work at import — it is
 * a consumer the worker-model orchestrator hooks (additively) and downstream tools use.
 *
 * Pins the `events` frozen contract it builds `defineEvent` against, so version drift
 * throws a clear ContractVersionError at load.
 */

import { assertContractCompatible } from "../../core/contracts/index.js";

assertContractCompatible("events", "1.0.0");

// --- contract ---
export {
  CONTRACT_VERSION,
  MODEL_TIERS,
  isModelTier,
  EscalationError,
} from "./contract.js";
export type {
  ModelTier,
  EscalationSignals,
  EscalationScore,
  EscalationDecision,
  EscalationHandoff,
  AttemptSummary,
  EscalationContext,
  EscalationRecord,
  EscalationWeights,
  EscalationConfig,
  EscalationEngine,
} from "./contract.js";

// --- config ---
export {
  loadEscalationConfig,
  escalationConfig,
  DEFAULT_WORKER_TO_MID_THRESHOLD,
  DEFAULT_MID_TO_FRONTIER_THRESHOLD,
  DEFAULT_MAX_ESCALATIONS,
  DEFAULT_WEIGHTS,
  DEFAULT_WORKER_MODELS,
  DEFAULT_MID_MODELS,
  DEFAULT_FRONTIER_MODELS,
} from "./config.js";

// --- scorer ---
export { computeScore } from "./scorer.js";

// --- policy ---
export { nextTier, thresholdFor, modelFor, decideEscalation } from "./policy.js";
export type { PolicyOutcome } from "./policy.js";

// --- handoff ---
export { buildHandoff, escalationReason, formatScoreBreakdown } from "./handoff.js";

// --- engine ---
export { createEscalationEngine, escalationEngine } from "./engine.js";

// --- break-glass ---
export { createBreakGlass, presentBreakGlass, DENY_BY_DEFAULT } from "./break-glass.js";
export type { BreakGlass, BreakGlassDeps, BreakGlassRequest, BreakGlassResolution, BreakGlassFallback, Approver } from "./break-glass.js";

// --- events ---
export {
  EVENT_SOURCE,
  escalationEvaluated,
  escalationTriggered,
  escalationDeclined,
  escalationApprovalRequested,
  escalationApprovalResolved,
} from "./events.js";

/**
 * ikbi verification-ladder — module entrypoint (library-only, PLANNER ONLY).
 *
 * Deterministic, model-free, NON-EXECUTING planner: (changed files + project-index) → an ordered,
 * scoped, reasoned verification plan. Conservative (uncertainty ⇒ full) and fail-closed (required-
 * but-underivable full ⇒ blocked, never a passable empty stage). Nothing wires or executes it yet.
 */

export {
  type CheckScope,
  type CheckStage,
  type CheckStageName,
  type CheckTask,
  type FullCheckOverride,
  type PlanOptions,
  type PlanRequest,
  type VerificationLadderApi,
  type VerificationPlan,
} from "./contract.js";

export {
  DEFAULT_MAX_CROSS_PACKAGE,
  DEFAULT_MAX_IMPACT_FILES,
  DEFAULT_MAX_IMPACT_HOPS,
  loadVerificationLadderConfig,
  RUNNABLE_SCRIPT_KEYS,
  SHARED_FILE_PATTERNS,
  verificationLadderConfig,
  type VerificationLadderConfig,
} from "./config.js";

export { createVerificationLadder, isStubScript, verificationLadder } from "./implementation.js";

// The optional HOWA TRUTHFULNESS RUNG — posts the build diff + model intent to Howa and
// fails closed (RED) on a detected lie. OFF by default (IKBI_VERIFICATION_LADDER_HOWA_ENABLED).
export {
  DEFAULT_HOWA_PATH,
  DEFAULT_HOWA_TIMEOUT_MS,
  DEFAULT_HOWA_URL,
  interpretHowaResponse,
  loadHowaCheckConfig,
  runHowaTruthfulnessCheck,
  type FetchLike,
  type HowaCheckConfig,
  type HowaCheckInput,
  type HowaCheckResult,
  type HowaVerdict,
} from "./howa-check.js";

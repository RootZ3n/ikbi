/**
 * ikbi step-planner — module entrypoint.
 */

export { decompose, decomposeWithModel, complexityScore } from "./implementation.js";
export type { Step, StepPlan, StepResult, StepPlanResult } from "./contract.js";
export { MAX_STEPS, COMPLEX_THRESHOLD } from "./config.js";

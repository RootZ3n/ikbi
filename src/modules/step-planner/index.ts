/**
 * ikbi step-planner — module entrypoint.
 *
 * Status: DORMANT — This module is built but not yet wired into production.
 * It will be activated when ikbi needs multi-step task decomposition (e.g.,
 * breaking complex user requests into ordered sub-tasks, parallel execution
 * planning, or dependency-aware scheduling). Do not delete.
 */

export { decompose, decomposeWithModel, complexityScore } from "./implementation.js";
export type { Step, StepPlan, StepResult, StepPlanResult } from "./contract.js";
export { MAX_STEPS, COMPLEX_THRESHOLD } from "./config.js";

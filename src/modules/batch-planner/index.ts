/**
 * ikbi batch-planner — module entrypoint.
 *
 * Pins the FROZEN-CORE contracts this module builds against (exact targets) so a
 * drift throws a clear ContractVersionError at load. It is an ORCHESTRATION layer
 * above worker-model — it executes nothing directly and gates nothing directly: it
 * makes ONE model call (decomposition) and calls the worker-model orchestrator once
 * per subtask (each a FULL governed run). The import-surface absence of any execution/
 * gating module is the proof (enforced by a test).
 *
 * MODULE DEPS: `worker-model` (the orchestrator it composes — `runWorker`). NO gate-
 * wall and NO governed-exec deps: each subtask run is gated INSIDE worker-model;
 * batch-planner orchestrates governed runs, it does not gate or execute.
 */

import { assertContractCompatible } from "../../core/contracts/index.js";

assertContractCompatible("provider", "1.1.0");
assertContractCompatible("injection", "1.0.0");
assertContractCompatible("identity", "1.1.0");
assertContractCompatible("events", "1.0.0");

// Side-effect import: registers the `batch` CLI command at load time.
import "./cli.js";

export { createBatchPlanner, batchPlanner, parsePlan, scheduleLevels, stopAndReport, type BatchPlannerDeps, type NeutralizeFn, type ToUntrustedFn } from "./planner.js";
export { createBatchCli, parseBatchArgs, type BatchCliDeps } from "./cli.js";
export {
  CONTRACT_VERSION,
  type BatchPlan,
  type BatchPlanner as BatchPlannerSurface,
  type BatchResult,
  type BatchRunInput,
  type BatchStatus,
  type ConflictPolicy,
  type ConflictVerdict,
  type Subtask,
  type SubtaskOutcome,
  type SubtaskStatus,
} from "./contract.js";
export {
  batchPlannerConfig,
  loadBatchPlannerConfig,
  DECOMPOSE_MODEL,
  DEFAULT_MAX_SUBTASKS,
  type BatchPlannerConfig,
} from "./config.js";
export {
  batchDecomposed,
  batchLevelStarted,
  batchSubtaskCompleted,
  batchStopped,
  batchCompleted,
} from "./events.js";

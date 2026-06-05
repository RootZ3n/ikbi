/**
 * ikbi batch-planner — its OWN config slice (per-module config seam).
 *
 * Read ONLY through `moduleEnv("batch-planner")` — never `configEnv` directly (module
 * plan ## 8). The reader auto-prefixes `IKBI_BATCH_PLANNER_`.
 *
 *   IKBI_BATCH_PLANNER_ENABLED       on/off. DEFAULT ON — this means the `ikbi batch`
 *                                    command is AVAILABLE. It does NOT auto-trigger on
 *                                    a normal `ikbi build`; decomposition only happens
 *                                    when the operator runs `batch`.
 *   IKBI_BATCH_PLANNER_MAX_SUBTASKS  hard cap on decomposed subtasks (bounds the number
 *                                    of worker runs a single decomposition can spawn).
 */

import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("batch-planner");

/** Model that performs the decomposition (one call per batch). */
export const DECOMPOSE_MODEL = "mimo-v2.5";
/** Sampling temperature for decomposition (low — a stable plan). */
export const DECOMPOSE_TEMPERATURE = 0.2;
/** Max completion tokens for the decomposition reply. */
export const DECOMPOSE_MAX_TOKENS = 2048;
/** Default cap on subtasks per batch — a runaway decomposition can't spawn unbounded runs. */
export const DEFAULT_MAX_SUBTASKS = 12;

export interface BatchPlannerConfig {
  /** When false, `planAndRun` refuses (the command is unavailable). */
  readonly enabled: boolean;
  /** Hard cap on decomposed subtasks. */
  readonly maxSubtasks: number;
}

/** Load the batch-planner config slice from `IKBI_BATCH_PLANNER_*`. */
export function loadBatchPlannerConfig(reader = env): BatchPlannerConfig {
  return Object.freeze({
    enabled: reader.bool("ENABLED", true),
    maxSubtasks: reader.int("MAX_SUBTASKS", DEFAULT_MAX_SUBTASKS, { min: 1, max: 50 }),
  });
}

/** The process-wide batch-planner config. */
export const batchPlannerConfig: BatchPlannerConfig = loadBatchPlannerConfig();

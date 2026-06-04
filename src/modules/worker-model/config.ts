/**
 * ikbi worker-model substrate — its OWN config slice (per-module config seam).
 *
 * Read ONLY through `moduleEnv("worker-model")` — never `configEnv` directly
 * (module plan ## 8). The reader auto-prefixes `IKBI_WORKER_MODEL_`.
 *
 *   IKBI_WORKER_MODEL_ENABLED        on/off. DEFAULT OFF — the substrate is opt-in
 *                                    (a disabled run throws WorkerError "disabled",
 *                                    so it cannot silently no-op real work).
 *   IKBI_WORKER_MODEL_ROLE_TIMEOUT_MS  per-role wall-clock budget. Default DEFAULT_ROLE_TIMEOUT_MS.
 *   IKBI_WORKER_MODEL_MAX_CONCURRENT_RUNS  concurrent runs cap. Default DEFAULT_MAX_CONCURRENT_RUNS
 *                                    (concurrency the FEATURE is deferred — the core is built
 *                                    safe for it; default 1).
 */

import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("worker-model");

/** Default per-role wall-clock budget (ms) — a named constant, not a magic number. */
export const DEFAULT_ROLE_TIMEOUT_MS = 120_000; // 2 minutes
/** Default concurrent-run cap (concurrency feature deferred; safe default 1). */
export const DEFAULT_MAX_CONCURRENT_RUNS = 1;

export interface WorkerModelConfig {
  /** When false, `run` throws WorkerError("disabled") (opt-in substrate). */
  readonly enabled: boolean;
  /** Per-role wall-clock budget in ms. */
  readonly roleTimeoutMs: number;
  /** Max concurrent runs (the orchestrator does not yet enforce; concurrency deferred). */
  readonly maxConcurrentRuns: number;
}

/** Load the worker-model config slice from `IKBI_WORKER_MODEL_*`. */
export function loadWorkerModelConfig(reader = env): WorkerModelConfig {
  return Object.freeze({
    enabled: reader.bool("ENABLED", false),
    roleTimeoutMs: reader.int("ROLE_TIMEOUT_MS", DEFAULT_ROLE_TIMEOUT_MS, { min: 1 }),
    maxConcurrentRuns: reader.int("MAX_CONCURRENT_RUNS", DEFAULT_MAX_CONCURRENT_RUNS, { min: 1 }),
  });
}

/** The process-wide worker-model config. */
export const workerModelConfig: WorkerModelConfig = loadWorkerModelConfig();

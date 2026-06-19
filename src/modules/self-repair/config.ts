/**
 * ikbi self-repair — its OWN config slice (per-module config seam).
 *
 * Read ONLY through `moduleEnv("self-repair")` — the reader auto-prefixes
 * `IKBI_SELF_REPAIR_`. No module touches `core/config.ts`.
 *
 *   IKBI_SELF_REPAIR_ENABLED        on/off. DEFAULT ON.
 *   IKBI_SELF_REPAIR_WORK_ORDER_DIR where WO-NNNN.json files are written. DEFAULT
 *                                   `<stateRoot>/../work-orders` (the shared lab queue).
 *   IKBI_SELF_REPAIR_HEALTH_URL     health endpoint to probe. DEFAULT the local service.
 *   IKBI_SELF_REPAIR_TEST_COMMAND   the test command. DEFAULT `pnpm test`.
 *   IKBI_SELF_REPAIR_REPO_ROOT      repo root the test command runs in. DEFAULT cwd.
 *   IKBI_SELF_REPAIR_REQUIRED_ENV   comma-list of env vars that must be set.
 *   IKBI_SELF_REPAIR_STALE_THRESHOLD stale-workspace count that trips maintenance. DEFAULT 10.
 *   IKBI_SELF_REPAIR_RUN_TESTS      run the (slow) test-suite check. DEFAULT ON.
 */

import { resolve } from "node:path";

import { config } from "../../core/config.js";
import { moduleEnv } from "../../core/module-config.js";
import type { MonitorOptions } from "./contract.js";

const env = moduleEnv("self-repair");

/** Default work-order queue: a sibling of the engine state root (`state/../work-orders`). */
export const DEFAULT_WORK_ORDER_DIR = resolve(config.stateRoot, "..", "work-orders");

/** Default health endpoint — the local service's `/health` on the configured port. */
export const DEFAULT_HEALTH_URL = `http://127.0.0.1:${config.port}/health`;

/** Env vars whose absence means ikbi cannot run a build (the dependency floor). */
export const DEFAULT_REQUIRED_ENV = ["IKBI_OPERATOR_TOKEN", "IKBI_WORKER_TOKEN"] as const;

export interface SelfRepairConfig {
  readonly enabled: boolean;
  readonly workOrderDir: string;
  readonly healthUrl: string;
  readonly testCommand: string;
  readonly repoRoot: string;
  readonly requiredEnv: readonly string[];
  readonly staleThreshold: number;
  readonly runTestSuite: boolean;
}

/** Load the self-repair config slice from `IKBI_SELF_REPAIR_*`. */
export function loadSelfRepairConfig(reader = env): SelfRepairConfig {
  return Object.freeze({
    enabled: reader.bool("ENABLED", true),
    workOrderDir: reader.path("WORK_ORDER_DIR", DEFAULT_WORK_ORDER_DIR),
    healthUrl: reader.str("HEALTH_URL", DEFAULT_HEALTH_URL),
    testCommand: reader.str("TEST_COMMAND", "pnpm test"),
    repoRoot: reader.path("REPO_ROOT", process.cwd()),
    requiredEnv: reader.list("REQUIRED_ENV", DEFAULT_REQUIRED_ENV),
    staleThreshold: reader.int("STALE_THRESHOLD", 10, { min: 1 }),
    runTestSuite: reader.bool("RUN_TESTS", true),
  });
}

/** The process-wide self-repair config. */
export const selfRepairConfig: SelfRepairConfig = loadSelfRepairConfig();

/** Project the config slice into the `MonitorOptions` the runner consumes. */
export function monitorOptions(cfg: SelfRepairConfig = selfRepairConfig): MonitorOptions {
  return Object.freeze({
    healthUrl: cfg.healthUrl,
    testCommand: cfg.testCommand,
    repoRoot: cfg.repoRoot,
    requiredEnv: cfg.requiredEnv,
    stateRoot: config.stateRoot,
    staleThreshold: cfg.staleThreshold,
    repos: ["ikbi"],
    runTestSuite: cfg.runTestSuite,
  });
}

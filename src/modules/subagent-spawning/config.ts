/**
 * ikbi subagent-spawning — its OWN config slice (per-module config seam).
 *
 * Read ONLY through `moduleEnv("subagent-spawning")` — never `configEnv` directly
 * (module plan ## 8). The reader auto-prefixes `IKBI_SUBAGENT_SPAWNING_`.
 *
 *   IKBI_SUBAGENT_SPAWNING_ENABLED  on/off. DEFAULT ON. When disabled the spawner
 *                                   REFUSES (fail-closed) — like gate-wall, a
 *                                   disabled spawner denies, it never bypasses the
 *                                   ceiling/governance to spawn ungoverned work.
 */

import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("subagent-spawning");

export interface SubagentSpawningConfig {
  /** When false, every spawn refuses fail-closed (NOT a bypass). */
  readonly enabled: boolean;
}

/** Load the subagent-spawning config slice from `IKBI_SUBAGENT_SPAWNING_*`. */
export function loadSubagentSpawningConfig(reader = env): SubagentSpawningConfig {
  return Object.freeze({ enabled: reader.bool("ENABLED", true) });
}

/** The process-wide subagent-spawning config. */
export const subagentSpawningConfig: SubagentSpawningConfig = loadSubagentSpawningConfig();

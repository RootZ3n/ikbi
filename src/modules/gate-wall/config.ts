/**
 * ikbi gate-wall — its OWN config slice (per-module config seam).
 *
 * Read ONLY through `moduleEnv("gate-wall")` — never `configEnv` directly (module
 * plan ## 8). The reader auto-prefixes `IKBI_GATE_WALL_`.
 *
 *   IKBI_GATE_WALL_ENABLED  on/off. DEFAULT ON.
 *   IKBI_GATE_WALL_BYPASS   when true, allows ALL actions without approval.
 *                            For single-operator use where the operator explicitly
 *                            chooses models. DEFAULT OFF.
 */

import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("gate-wall");

export interface GateWallConfig {
  /** When false, the evaluator denies every promote (fail-closed; NOT an allow-all). */
  readonly enabled: boolean;
  /** When true, allows ALL actions without approval. For single-operator use. */
  readonly bypass: boolean;
}

/** Load the gate-wall config slice from `IKBI_GATE_WALL_*`. */
export function loadGateWallConfig(reader = env): GateWallConfig {
  return Object.freeze({
    enabled: reader.bool("ENABLED", true),
    bypass: reader.bool("BYPASS", false)
  });
}

/** The process-wide gate-wall config. */
export const gateWallConfig: GateWallConfig = loadGateWallConfig();

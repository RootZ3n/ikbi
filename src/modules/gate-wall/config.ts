/**
 * ikbi gate-wall — its OWN config slice (per-module config seam).
 *
 * Read ONLY through `moduleEnv("gate-wall")` — never `configEnv` directly (module
 * plan ## 8). The reader auto-prefixes `IKBI_GATE_WALL_`.
 *
 *   IKBI_GATE_WALL_ENABLED  on/off. DEFAULT ON. NOTE: there is deliberately NO
 *                           "allow-all" escape hatch — disabling the gate does NOT
 *                           bypass policy. When disabled, the evaluator DENIES (a
 *                           governance gate that is off cannot grant approval —
 *                           fail-closed, matching the egress default-deny posture).
 */

import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("gate-wall");

export interface GateWallConfig {
  /** When false, the evaluator denies every promote (fail-closed; NOT an allow-all). */
  readonly enabled: boolean;
}

/** Load the gate-wall config slice from `IKBI_GATE_WALL_*`. */
export function loadGateWallConfig(reader = env): GateWallConfig {
  return Object.freeze({ enabled: reader.bool("ENABLED", true) });
}

/** The process-wide gate-wall config. */
export const gateWallConfig: GateWallConfig = loadGateWallConfig();

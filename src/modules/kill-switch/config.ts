/**
 * ikbi kill-switch — its OWN config slice (per-module config seam).
 *
 * Read ONLY through `moduleEnv("kill-switch")` — never `configEnv` directly (module
 * plan ## 8). The reader auto-prefixes `IKBI_KILL_SWITCH_`.
 *
 *   IKBI_KILL_SWITCH_ENABLED  on/off. DEFAULT ON. Disabled ⇒ the checkpoints never see
 *                             a kill (isKilled returns not-killed) — but a DISABLED
 *                             kill-switch is itself a documented operator choice.
 *   IKBI_KILL_SWITCH_DIR      durable latch directory. DEFAULT under the engine state
 *                             root (`<stateRoot>/kill-switch`) so a kill survives a
 *                             restart and the `state/` gitignore covers it.
 */

import { resolve } from "node:path";

import { config } from "../../core/config.js";
import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("kill-switch");

/** Default durable-latch directory — under the shared engine state root. */
export const DEFAULT_LATCH_DIR = resolve(config.stateRoot, "kill-switch");
/** The single document id the latch is stored under. */
export const LATCH_ID = "state";

export interface KillSwitchConfig {
  /** When false, isKilled always reports not-killed (kill-switch off). */
  readonly enabled: boolean;
  /** The durable latch directory (under the state root by default). */
  readonly latchDir: string;
}

/** Load the kill-switch config slice from `IKBI_KILL_SWITCH_*`. */
export function loadKillSwitchConfig(reader = env): KillSwitchConfig {
  return Object.freeze({
    enabled: reader.bool("ENABLED", true),
    latchDir: reader.path("DIR", DEFAULT_LATCH_DIR),
  });
}

/** The process-wide kill-switch config. */
export const killSwitchConfig: KillSwitchConfig = loadKillSwitchConfig();

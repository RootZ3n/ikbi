/**
 * ikbi self-observation — its OWN config slice (per-module config seam).
 *
 * Read ONLY through `moduleEnv("self-observation")` — never `configEnv` directly
 * (module plan ## 8). The reader auto-prefixes `IKBI_SELF_OBSERVATION_`.
 *
 *   IKBI_SELF_OBSERVATION_ENABLED            on/off. DEFAULT ON. Disabled ⇒ the
 *                                            observer does not subscribe (no-op).
 *   IKBI_SELF_OBSERVATION_RECENT_EVENTS_MAX  ring-buffer bound for recent events.
 *   IKBI_SELF_OBSERVATION_DIR                snapshot store dir. DEFAULT lives UNDER
 *                                            the engine state root (`<stateRoot>/self-
 *                                            observation`), like receipts/trust/
 *                                            workspaces/lab-context-memory — so the
 *                                            gitignored `state/` covers it.
 */

import { resolve } from "node:path";

import { config } from "../../core/config.js";
import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("self-observation");

/** Default bound on the recent-events ring buffer (no unbounded growth). */
export const DEFAULT_RECENT_EVENTS_MAX = 200;

/**
 * Default snapshot store directory — UNDER the shared engine state root (same
 * `config.stateRoot` receipts/trust/workspaces derive from), so `state/` covers it
 * and observation data is never committed.
 */
export const DEFAULT_SNAPSHOT_DIR = resolve(config.stateRoot, "self-observation");

export interface SelfObservationConfig {
  /** When false, the observer does not subscribe (passive no-op). */
  readonly enabled: boolean;
  /** Bound on the recent-events ring buffer. */
  readonly recentEventsMax: number;
  /** Directory for persisted snapshots (under the state root by default). */
  readonly snapshotDir: string;
}

/** Load the self-observation config slice from `IKBI_SELF_OBSERVATION_*`. */
export function loadSelfObservationConfig(reader = env): SelfObservationConfig {
  return Object.freeze({
    enabled: reader.bool("ENABLED", true),
    recentEventsMax: reader.int("RECENT_EVENTS_MAX", DEFAULT_RECENT_EVENTS_MAX, { min: 1 }),
    snapshotDir: reader.path("DIR", DEFAULT_SNAPSHOT_DIR),
  });
}

/** The process-wide self-observation config. */
export const selfObservationConfig: SelfObservationConfig = loadSelfObservationConfig();

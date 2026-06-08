/**
 * ikbi drift-prevention — its OWN config slice (per-module config seam).
 *
 * Read ONLY through `moduleEnv("drift-prevention")` — never `configEnv` directly
 * (module plan ## 8). The reader auto-prefixes `IKBI_DRIFT_PREVENTION_`.
 *
 *   IKBI_DRIFT_PREVENTION_ENABLED          on/off. DEFAULT ON. Disabled ⇒ check()
 *                                          returns no reports (inert).
 *   IKBI_DRIFT_PREVENTION_DRIFT_THRESHOLD  minimum DROP (baseline−recent) to flag
 *                                          drift. Default 0.2 (a 20-point drop).
 *   IKBI_DRIFT_PREVENTION_MIN_SAMPLE_SIZE  minimum recent outcomes before flagging —
 *                                          never cry drift on noise. Default 5.
 *   IKBI_DRIFT_PREVENTION_RECENT_WINDOW    how many recent outcomes = "recent". Default 20.
 *   IKBI_DRIFT_PREVENTION_POLICY           intervention on detected drift: "reportOnly"
 *                                          (default — log/emit only), "warn" (console.warn
 *                                          and continue), or "block" (check() throws a
 *                                          DriftBlockedError). Invalid value ⇒ load throws.
 */

import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("drift-prevention");

/** The intervention a detected drift triggers in check(). */
export type DriftPolicyName = "reportOnly" | "warn" | "block";

/** The default intervention: detect-and-report only (acts on nothing). */
export const DEFAULT_DRIFT_POLICY: DriftPolicyName = "reportOnly";

/** Parse + validate the policy name (fail-loud on an unrecognized value). */
export function parseDriftPolicy(raw: string | undefined): DriftPolicyName {
  if (raw === undefined) return DEFAULT_DRIFT_POLICY;
  const v = raw.trim();
  if (v === "reportOnly" || v === "warn" || v === "block") return v;
  throw new Error(`invalid IKBI_DRIFT_PREVENTION_POLICY "${raw}" (expected reportOnly | warn | block)`);
}

/** Minimum drop (baseline rate − recent rate) to flag drift. */
export const DEFAULT_DRIFT_THRESHOLD = 0.2;
/** Minimum recent samples before a flag is allowed (anti-noise guard). */
export const DEFAULT_MIN_SAMPLE_SIZE = 5;
/** How many most-recent outcomes form the "recent" rate. */
export const DEFAULT_RECENT_WINDOW = 20;

export interface DriftPreventionConfig {
  /** When false, check() is inert (no reports). */
  readonly enabled: boolean;
  /** Drop threshold to flag drift, in [0,1]. */
  readonly driftThreshold: number;
  /** Minimum recent samples to flag. */
  readonly minSampleSize: number;
  /** Recent-window size. */
  readonly recentWindow: number;
  /**
   * Intervention on detected drift. Optional — when absent, the detector defaults to
   * `reportOnly` (the v1 posture). Set via IKBI_DRIFT_PREVENTION_POLICY.
   */
  readonly policy?: DriftPolicyName;
}

/** Load the drift-prevention config slice from `IKBI_DRIFT_PREVENTION_*`. */
export function loadDriftPreventionConfig(reader = env): DriftPreventionConfig {
  return Object.freeze({
    enabled: reader.bool("ENABLED", true),
    driftThreshold: reader.number("DRIFT_THRESHOLD", DEFAULT_DRIFT_THRESHOLD, { min: 0, max: 1 }),
    minSampleSize: reader.int("MIN_SAMPLE_SIZE", DEFAULT_MIN_SAMPLE_SIZE, { min: 1 }),
    recentWindow: reader.int("RECENT_WINDOW", DEFAULT_RECENT_WINDOW, { min: 1 }),
    policy: parseDriftPolicy(reader.str("POLICY")),
  });
}

/** The process-wide drift-prevention config. */
export const driftPreventionConfig: DriftPreventionConfig = loadDriftPreventionConfig();

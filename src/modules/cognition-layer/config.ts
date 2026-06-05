/**
 * ikbi cognition-layer — its OWN config slice (per-module config seam).
 *
 * Read ONLY through `moduleEnv("cognition-layer")` — never `configEnv` directly
 * (module plan ## 8). The reader auto-prefixes `IKBI_COGNITION_LAYER_`.
 *
 *   IKBI_COGNITION_LAYER_ENABLED            on/off. DEFAULT ON. Disabled ⇒ deliberate refuses.
 *   IKBI_COGNITION_LAYER_MAX_MEMORY_ENTRIES cap on memory entries pulled per deliberation
 *                                           (bounds the model context).
 */

import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("cognition-layer");

/** Model that performs the deliberation. */
export const COGNITION_MODEL = "mimo-v2.5";
/** Sampling temperature (low — steady judgment). */
export const COGNITION_TEMPERATURE = 0.2;
/** Max completion tokens for the decision reply. */
export const COGNITION_MAX_TOKENS = 1500;
/** Default cap on memory entries pulled into a deliberation. */
export const DEFAULT_MAX_MEMORY_ENTRIES = 40;

export interface CognitionLayerConfig {
  /** When false, deliberate refuses fail-closed. */
  readonly enabled: boolean;
  /** Max memory entries pulled into the deliberation context. */
  readonly maxMemoryEntries: number;
}

/** Load the cognition-layer config slice from `IKBI_COGNITION_LAYER_*`. */
export function loadCognitionLayerConfig(reader = env): CognitionLayerConfig {
  return Object.freeze({
    enabled: reader.bool("ENABLED", true),
    maxMemoryEntries: reader.int("MAX_MEMORY_ENTRIES", DEFAULT_MAX_MEMORY_ENTRIES, { min: 1 }),
  });
}

/** The process-wide cognition-layer config. */
export const cognitionLayerConfig: CognitionLayerConfig = loadCognitionLayerConfig();

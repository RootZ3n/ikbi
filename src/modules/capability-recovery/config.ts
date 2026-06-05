/**
 * ikbi capability-recovery — its OWN config slice (per-module config seam).
 *
 * Read ONLY through `moduleEnv("capability-recovery")` — never `configEnv` directly
 * (module plan ## 8). The reader auto-prefixes `IKBI_CAPABILITY_RECOVERY_`.
 *
 *   IKBI_CAPABILITY_RECOVERY_ENABLED            on/off. DEFAULT ON. Disabled ⇒ assess refuses.
 *   IKBI_CAPABILITY_RECOVERY_MAX_MEMORY_ENTRIES cap on memory entries scanned per assessment.
 *   IKBI_CAPABILITY_RECOVERY_MAX_RECEIPTS       cap on receipts scanned per assessment.
 */

import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("capability-recovery");

/** Model that performs the diagnosis. */
export const RECOVERY_MODEL = "mimo-v2.5";
/** Sampling temperature (low — steady classification). */
export const RECOVERY_TEMPERATURE = 0.2;
/** Max completion tokens for the diagnosis reply. */
export const RECOVERY_MAX_TOKENS = 1200;
/** Default cap on memory entries scanned for the it-used-to-work record. */
export const DEFAULT_MAX_MEMORY_ENTRIES = 40;
/** Default cap on receipts scanned for last-known-good + breakage evidence. */
export const DEFAULT_MAX_RECEIPTS = 100;

export interface CapabilityRecoveryConfig {
  readonly enabled: boolean;
  readonly maxMemoryEntries: number;
  readonly maxReceipts: number;
}

/** Load the capability-recovery config slice from `IKBI_CAPABILITY_RECOVERY_*`. */
export function loadCapabilityRecoveryConfig(reader = env): CapabilityRecoveryConfig {
  return Object.freeze({
    enabled: reader.bool("ENABLED", true),
    maxMemoryEntries: reader.int("MAX_MEMORY_ENTRIES", DEFAULT_MAX_MEMORY_ENTRIES, { min: 1 }),
    maxReceipts: reader.int("MAX_RECEIPTS", DEFAULT_MAX_RECEIPTS, { min: 1 }),
  });
}

/** The process-wide capability-recovery config. */
export const capabilityRecoveryConfig: CapabilityRecoveryConfig = loadCapabilityRecoveryConfig();

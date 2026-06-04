/**
 * ikbi lab-context-memory — its OWN config slice (per-module config seam).
 *
 * Read ONLY through `moduleEnv("lab-context-memory")` — never `configEnv` directly
 * (module plan ## 8). The reader auto-prefixes `IKBI_LAB_CONTEXT_MEMORY_`.
 *
 *   IKBI_LAB_CONTEXT_MEMORY_ENABLED  on/off. DEFAULT ON. Disabled ⇒ writes refuse.
 *   IKBI_LAB_CONTEXT_MEMORY_DIR      the SHARED LAB-MEMORY directory. Named with the
 *                                    ikbi prefix today, but this is the cross-agent
 *                                    store other lab agents (Ptah, Peh) will point at
 *                                    once their transport/auth lands — NOT ikbi-private.
 *   IKBI_LAB_CONTEXT_MEMORY_MAX_RECEIPTS_PER_PROJECTION  cap per projection run.
 */

import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("lab-context-memory");

/** Default shared lab-memory directory (operator points other agents at the same dir later). */
export const DEFAULT_MEMORY_DIR = ".ikbi/lab-context-memory";
/** Cap on receipts read per projection run (bounded work). */
export const DEFAULT_MAX_RECEIPTS_PER_PROJECTION = 1_000;

export interface LabContextMemoryConfig {
  /** When false, writes (record/projectFromReceipts) refuse fail-closed. Reads stay open. */
  readonly enabled: boolean;
  /** The shared lab-memory store directory. */
  readonly memoryDir: string;
  readonly maxReceiptsPerProjection: number;
}

/** Load the lab-context-memory config slice from `IKBI_LAB_CONTEXT_MEMORY_*`. */
export function loadLabContextMemoryConfig(reader = env): LabContextMemoryConfig {
  return Object.freeze({
    enabled: reader.bool("ENABLED", true),
    memoryDir: reader.path("DIR", DEFAULT_MEMORY_DIR),
    maxReceiptsPerProjection: reader.int("MAX_RECEIPTS_PER_PROJECTION", DEFAULT_MAX_RECEIPTS_PER_PROJECTION, { min: 1 }),
  });
}

/** The process-wide lab-context-memory config. */
export const labContextMemoryConfig: LabContextMemoryConfig = loadLabContextMemoryConfig();

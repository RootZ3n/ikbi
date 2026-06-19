/**
 * ikbi lab-context-memory — its OWN config slice (per-module config seam).
 *
 * Read ONLY through `moduleEnv("lab-context-memory")` — never `configEnv` directly
 * (module plan ## 8). The reader auto-prefixes `IKBI_LAB_CONTEXT_MEMORY_`.
 *
 *   IKBI_LAB_CONTEXT_MEMORY_ENABLED  on/off. DEFAULT ON. Disabled ⇒ writes refuse.
 *   IKBI_LAB_CONTEXT_MEMORY_DIR      the SHARED LAB-MEMORY directory. DEFAULT lives
 *                                    UNDER the engine state root (`<stateRoot>/lab-
 *                                    context-memory`), exactly like receipts/trust/
 *                                    workspaces — so the gitignored `state/` covers it
 *                                    and lab memory can never be committed. Set this
 *                                    override to point at a SHARED lab location that
 *                                    other agents (the Mechanic, Peh, …) also use — NOT
 *                                    ikbi-private. The override always wins.
 *   IKBI_LAB_CONTEXT_MEMORY_MAX_RECEIPTS_PER_PROJECTION  cap per projection run.
 *   IKBI_LAB_CONTEXT_MEMORY_MAX_VALUE_BYTES  cap on a single record()'s serialized
 *                                    value (H7). DURABLE shared memory holds SUMMARIES,
 *                                    not blobs — an over-cap value is REJECTED fail-closed
 *                                    (the caller must summarize), never silently stored.
 */

import { resolve } from "node:path";

import { config } from "../../core/config.js";
import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("lab-context-memory");

/**
 * Default lab-memory directory — UNDER the shared engine state root (the same
 * `config.stateRoot` receipts/trust/workspaces derive from), so the `state/`
 * gitignore covers it and lab data cannot accidentally be committed. The env
 * override repoints it at a shared lab location when other agents wire in.
 */
export const DEFAULT_MEMORY_DIR = resolve(config.stateRoot, "lab-context-memory");
/** Cap on receipts read per projection run (bounded work). */
export const DEFAULT_MAX_RECEIPTS_PER_PROJECTION = 1_000;
/**
 * Cap on a single record()'s serialized `value` (H7). 16 KiB — durable cross-agent
 * memory entries are SUMMARIES (an activity note, a pattern count), not blobs; an
 * over-cap value is rejected so the caller summarizes instead of persisting a giant blob.
 */
export const DEFAULT_MAX_VALUE_BYTES = 16_384;

export interface LabContextMemoryConfig {
  /** When false, writes (record/projectFromReceipts) refuse fail-closed. Reads stay open. */
  readonly enabled: boolean;
  /** The shared lab-memory store directory. */
  readonly memoryDir: string;
  readonly maxReceiptsPerProjection: number;
  /** Max serialized bytes of a single record()'s value (over-cap ⇒ rejected fail-closed). */
  readonly maxValueBytes: number;
}

/** Load the lab-context-memory config slice from `IKBI_LAB_CONTEXT_MEMORY_*`. */
export function loadLabContextMemoryConfig(reader = env): LabContextMemoryConfig {
  return Object.freeze({
    enabled: reader.bool("ENABLED", true),
    memoryDir: reader.path("DIR", DEFAULT_MEMORY_DIR),
    maxReceiptsPerProjection: reader.int("MAX_RECEIPTS_PER_PROJECTION", DEFAULT_MAX_RECEIPTS_PER_PROJECTION, { min: 1 }),
    maxValueBytes: reader.int("MAX_VALUE_BYTES", DEFAULT_MAX_VALUE_BYTES, { min: 1 }),
  });
}

/** The process-wide lab-context-memory config. */
export const labContextMemoryConfig: LabContextMemoryConfig = loadLabContextMemoryConfig();

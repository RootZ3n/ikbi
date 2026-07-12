/**
 * ikbi caching floor — its OWN config slice (per-module config seam).
 *
 * Read ONLY through `moduleEnv("cache")` — never `configEnv` directly (module
 * plan ## 8: "No direct configEnv reads"). The reader auto-prefixes `IKBI_CACHE_`.
 *
 *   IKBI_CACHE_ENABLED      on/off. Opt-out-safe: when off, invokeModel is an exact
 *                           passthrough (no lookup, no store). Default ON (the floor).
 *   IKBI_CACHE_TTL_MS       entry time-to-live in ms. Default DEFAULT_TTL_MS.
 *   IKBI_CACHE_MAX_ENTRIES  hard cap on live entries (LRU eviction). Default DEFAULT_MAX_ENTRIES.
 */

import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("cache");

/** Default cache entry TTL (ms) — a single named constant, not a magic number. */
export const DEFAULT_TTL_MS = 5 * 60_000; // 5 minutes

/** Default hard cap on live cache entries — bounds memory (H7). LRU-evicts past this. */
export const DEFAULT_MAX_ENTRIES = 1000;

export interface CacheConfig {
  /** When false, invokeModel behaves exactly as today (pure passthrough). */
  readonly enabled: boolean;
  /** Entry time-to-live in ms. `0` disables storage (every call is a miss). */
  readonly ttlMs: number;
  /** H7: hard cap on live entries. On overflow the least-recently-used entry is evicted. `0` ⇒ no cap. */
  readonly maxEntries: number;
}

/** Load the cache config slice from `IKBI_CACHE_*`. */
export function loadCacheConfig(reader = env): CacheConfig {
  return Object.freeze({
    enabled: reader.bool("ENABLED", true),
    ttlMs: reader.int("TTL_MS", DEFAULT_TTL_MS, { min: 0 }),
    maxEntries: reader.int("MAX_ENTRIES", DEFAULT_MAX_ENTRIES, { min: 0 }),
  });
}

/** The process-wide cache config. */
export const cacheConfig: CacheConfig = loadCacheConfig();

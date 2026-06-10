/**
 * ikbi capability-client — its OWN config slice (per-module config seam).
 *
 * NAMESPACE NOTE: the module DIRECTORY is `capability-client`, but its env namespace
 * is `IKBI_CAPABILITY_LEDGER_*` (the ledger it talks to) so the operator-facing knob
 * is the documented `IKBI_CAPABILITY_LEDGER_URL`. Read ONLY through this reader — never
 * `configEnv` directly (module plan ## 8).
 *
 *   IKBI_CAPABILITY_LEDGER_ENABLED         consult the ledger at all. DEFAULT ON.
 *                                          OFF ⇒ accessors no-op (always static fallback).
 *   IKBI_CAPABILITY_LEDGER_URL             scores endpoint. DEFAULT the local ittunaha.
 *   IKBI_CAPABILITY_LEDGER_TTL_MS          cache TTL (ms) — avoid hammering the API. DEFAULT 300000 (5 min).
 *   IKBI_CAPABILITY_LEDGER_TIMEOUT_MS      per-request timeout (ms). DEFAULT 2000.
 *   IKBI_CAPABILITY_LEDGER_MIN_CONFIDENCE  routing trust gate on a score's confidence. DEFAULT 0.5.
 *   IKBI_CAPABILITY_LEDGER_MIN_SAMPLES     routing trust gate on a score's sampleCount. DEFAULT 3.
 */

import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("capability-ledger");

/** Default Capability Ledger scores endpoint (local ittunaha on the lab spine). */
export const DEFAULT_LEDGER_URL = "http://localhost:18783/api/nous/capability-scores";
/** Default cache TTL — 5 minutes. */
export const DEFAULT_TTL_MS = 300_000;
/** Default per-request timeout — fail fast so routing never blocks on a down ledger. */
export const DEFAULT_TIMEOUT_MS = 2_000;
/** Default routing trust gates (a score must clear BOTH to override static config). */
export const DEFAULT_MIN_CONFIDENCE = 0.5;
export const DEFAULT_MIN_SAMPLES = 3;

export interface CapabilityClientConfig {
  /** When false, the client never fetches — every accessor returns empty/null (static fallback). */
  readonly enabled: boolean;
  /** The scores endpoint URL. */
  readonly url: string;
  /** Cache TTL in ms (>=0; 0 disables caching). */
  readonly ttlMs: number;
  /** Per-request timeout in ms. */
  readonly timeoutMs: number;
  /** A score's confidence must be STRICTLY greater than this to drive routing. */
  readonly minConfidence: number;
  /** A score's sampleCount must be STRICTLY greater than this to drive routing. */
  readonly minSamples: number;
}

/** Load the capability-client config slice from `IKBI_CAPABILITY_LEDGER_*`. */
export function loadCapabilityClientConfig(reader = env): CapabilityClientConfig {
  return Object.freeze({
    enabled: reader.bool("ENABLED", true),
    url: reader.str("URL", DEFAULT_LEDGER_URL),
    ttlMs: reader.int("TTL_MS", DEFAULT_TTL_MS, { min: 0 }),
    timeoutMs: reader.int("TIMEOUT_MS", DEFAULT_TIMEOUT_MS, { min: 1 }),
    minConfidence: reader.number("MIN_CONFIDENCE", DEFAULT_MIN_CONFIDENCE, { min: 0, max: 1 }),
    minSamples: reader.int("MIN_SAMPLES", DEFAULT_MIN_SAMPLES, { min: 0 }),
  });
}

/** The process-wide capability-client config. */
export const capabilityClientConfig: CapabilityClientConfig = loadCapabilityClientConfig();

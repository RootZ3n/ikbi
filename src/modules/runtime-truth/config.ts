/**
 * ikbi runtime-truth — PRODUCTION CONFIG + FAIL-CLOSED READER LOADER (Phase 5).
 *
 * Opt-in, standalone, fail-closed. Disabled by default; when enabled the reader is either injected
 * (a dep, the primary path for tests + operators who compose in-process) or resolved at runtime by a
 * DYNAMIC import of an operator-configured module (`IKBI_RUNTIME_TRUTH_READER_MODULE`) exporting
 * `createEvidenceReader(): RuntimeTruthEvidenceReader`. ikbi contains no static import of any external
 * lab package; an unset/failed module is inert (normal ikbi), never a fabricated success.
 */

import { configEnv } from "../../core/config.js";
import { DEFAULT_FRESHNESS_MS, DEFAULT_LIMITS } from "./policy.js";
import type { EvidenceLimits, RuntimeTruthEvidenceReader } from "./contract.js";

export const RUNTIME_TRUTH_EVIDENCE_ENV = "IKBI_RUNTIME_TRUTH_EVIDENCE"; // on|off (default off)
export const RUNTIME_TRUTH_READER_MODULE_ENV = "IKBI_RUNTIME_TRUTH_READER_MODULE"; // operator adapter path
export const RUNTIME_TRUTH_MAX_ITEMS_ENV = "IKBI_RUNTIME_TRUTH_MAX_ITEMS";
export const RUNTIME_TRUTH_MAX_BYTES_ENV = "IKBI_RUNTIME_TRUTH_MAX_BYTES";
export const RUNTIME_TRUTH_FRESHNESS_MS_ENV = "IKBI_RUNTIME_TRUTH_FRESHNESS_MS";

/** Whether the production evidence layer is enabled (default OFF — advisory, opt-in). */
export function runtimeTruthEvidenceEnabled(env: Readonly<NodeJS.ProcessEnv> = configEnv): boolean {
  return (env[RUNTIME_TRUTH_EVIDENCE_ENV] ?? "").trim().toLowerCase() === "on";
}

function posIntEnv(env: Readonly<NodeJS.ProcessEnv>, key: string, fallback: number): number {
  const n = Number.parseInt((env[key] ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Resolve the evidence limits from env (falling back to conservative cheap-tier defaults). */
export function resolveEvidenceLimits(env: Readonly<NodeJS.ProcessEnv> = configEnv): EvidenceLimits {
  return {
    maxItems: posIntEnv(env, RUNTIME_TRUTH_MAX_ITEMS_ENV, DEFAULT_LIMITS.maxItems),
    maxTotalBytes: posIntEnv(env, RUNTIME_TRUTH_MAX_BYTES_ENV, DEFAULT_LIMITS.maxTotalBytes),
    maxItemBytes: DEFAULT_LIMITS.maxItemBytes,
  };
}

/** The freshness window (ms) for expiring stale evidence. */
export function resolveFreshnessWindowMs(env: Readonly<NodeJS.ProcessEnv> = configEnv): number {
  return posIntEnv(env, RUNTIME_TRUTH_FRESHNESS_MS_ENV, DEFAULT_FRESHNESS_MS);
}

/** Minimal structural check that a loaded value satisfies the reader port (fail-closed on mismatch). */
function isReader(v: unknown): v is RuntimeTruthEvidenceReader {
  return typeof v === "object" && v !== null && typeof (v as RuntimeTruthEvidenceReader).readEvidence === "function" && typeof (v as RuntimeTruthEvidenceReader).id === "string";
}

/**
 * Resolve the production reader. Precedence: an injected `dep` wins (in-process composition); else, if
 * enabled AND a module path is configured, DYNAMICALLY import it and call `createEvidenceReader()`.
 * Returns `{ reader }` on success, `{ error }` on a truthful failure, or `undefined` when disabled/inert.
 * NEVER throws and NEVER fabricates a reader — an import/validation failure is a visible operational
 * status, and the caller treats missing evidence as advisory (the build continues).
 */
export async function loadRuntimeTruthReader(
  dep: RuntimeTruthEvidenceReader | undefined,
  env: Readonly<NodeJS.ProcessEnv> = configEnv,
): Promise<{ reader: RuntimeTruthEvidenceReader } | { error: string } | undefined> {
  if (dep !== undefined) return { reader: dep };
  if (!runtimeTruthEvidenceEnabled(env)) return undefined; // disabled ⇒ inert, no reader, no claim
  const modulePath = (env[RUNTIME_TRUTH_READER_MODULE_ENV] ?? "").trim();
  if (modulePath.length === 0) return { error: `runtime-truth enabled but ${RUNTIME_TRUTH_READER_MODULE_ENV} is unset — no reader loaded` };
  try {
    const mod = (await import(modulePath)) as { createEvidenceReader?: () => unknown; default?: () => unknown };
    const factory = mod.createEvidenceReader ?? mod.default;
    if (typeof factory !== "function") return { error: `runtime-truth reader module ${modulePath} does not export createEvidenceReader()` };
    const reader = await Promise.resolve(factory());
    if (!isReader(reader)) return { error: `runtime-truth reader module ${modulePath} did not return a valid reader` };
    return { reader };
  } catch (err) {
    return { error: `runtime-truth reader module ${modulePath} failed to load: ${err instanceof Error ? err.message : String(err)}` };
  }
}

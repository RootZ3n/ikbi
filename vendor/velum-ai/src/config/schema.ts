/**
 * Velum — Configuration schema + validation.
 */

import type { PatternDefinition } from "../core/patterns.js";

export type PiiLevel = 1 | 2 | 3;

export interface VelumModuleConfig {
  piiLevel?: PiiLevel;
}

export interface VelumConfig {
  /** Master switch. When false, adapters pass everything through. */
  enabled: boolean;
  /** Default PII level applied when a module has no override. */
  defaultPiiLevel: PiiLevel;
  /** PII redaction level for model output. Defaults to defaultPiiLevel (H5). */
  outputPiiLevel?: PiiLevel;
  /** Enable NAME PII detection (off by default — noisy without context, M5). */
  detectNames?: boolean;
  /** Extra patterns added to the registry at startup. */
  customPatterns?: PatternDefinition[];
  /** Extra known-safe terms merged into the registry's neverRedact set. */
  neverRedact?: string[];
  /** Credential buffer TTL in milliseconds. */
  credentialBufferTtlMs?: number;
  /** Path to a JSONL audit log (optional). */
  auditLogPath?: string;
  /** Directory for JSONL receipts (optional). */
  receiptsDir?: string;
  /** Paths to shareable pattern-pack JSON files loaded at startup. */
  patternPacks?: string[];
  /** Per-module overrides keyed by module/route name. */
  modules?: Record<string, VelumModuleConfig>;
}

export class VelumConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VelumConfigError";
  }
}

function isPiiLevel(v: unknown): v is PiiLevel {
  return v === 1 || v === 2 || v === 3;
}

/**
 * Validate and normalize a partial config object into a full VelumConfig,
 * filling in defaults. Throws VelumConfigError on invalid values.
 */
export function validateConfig(input: Partial<VelumConfig> | undefined, defaults: VelumConfig): VelumConfig {
  const cfg: VelumConfig = { ...defaults, ...(input ?? {}) };

  if (typeof cfg.enabled !== "boolean") {
    throw new VelumConfigError(`'enabled' must be a boolean, got ${typeof cfg.enabled}`);
  }
  if (!isPiiLevel(cfg.defaultPiiLevel)) {
    throw new VelumConfigError(`'defaultPiiLevel' must be 1, 2, or 3, got ${String(cfg.defaultPiiLevel)}`);
  }
  if (cfg.outputPiiLevel !== undefined && !isPiiLevel(cfg.outputPiiLevel)) {
    throw new VelumConfigError(`'outputPiiLevel' must be 1, 2, or 3, got ${String(cfg.outputPiiLevel)}`);
  }
  if (cfg.detectNames !== undefined && typeof cfg.detectNames !== "boolean") {
    throw new VelumConfigError("'detectNames' must be a boolean");
  }
  if (cfg.credentialBufferTtlMs !== undefined) {
    if (typeof cfg.credentialBufferTtlMs !== "number" || cfg.credentialBufferTtlMs <= 0) {
      throw new VelumConfigError("'credentialBufferTtlMs' must be a positive number");
    }
  }
  if (cfg.neverRedact !== undefined && !Array.isArray(cfg.neverRedact)) {
    throw new VelumConfigError("'neverRedact' must be an array of strings");
  }
  if (cfg.patternPacks !== undefined && !Array.isArray(cfg.patternPacks)) {
    throw new VelumConfigError("'patternPacks' must be an array of file paths");
  }
  if (cfg.modules !== undefined) {
    for (const [name, mod] of Object.entries(cfg.modules)) {
      if (mod.piiLevel !== undefined && !isPiiLevel(mod.piiLevel)) {
        throw new VelumConfigError(`module '${name}': piiLevel must be 1, 2, or 3`);
      }
    }
  }

  return cfg;
}

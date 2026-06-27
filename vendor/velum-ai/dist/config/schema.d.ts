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
export declare class VelumConfigError extends Error {
    constructor(message: string);
}
/**
 * Validate and normalize a partial config object into a full VelumConfig,
 * filling in defaults. Throws VelumConfigError on invalid values.
 */
export declare function validateConfig(input: Partial<VelumConfig> | undefined, defaults: VelumConfig): VelumConfig;
//# sourceMappingURL=schema.d.ts.map
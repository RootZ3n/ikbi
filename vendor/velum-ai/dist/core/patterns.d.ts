/**
 * Velum — Pattern Registry
 * ============================================================
 * The foundation of Velum. Every other core module (classify, guard, pii)
 * consumes its detection patterns from this registry. Patterns are grouped
 * by category and carry a severity hint used by the guard stages.
 *
 * The registry is extensible at runtime: callers can add custom patterns,
 * remove built-ins, or look one up by name.
 * ============================================================
 */
export type PatternCategory = "credential" | "injection" | "pii" | "policy";
export type PatternSeverity = "block" | "review" | "warn";
/**
 * Detection confidence:
 *  - "high": distinctive prefix/shape (sk-…, AKIA…, ghp_…) — a real secret; it
 *    must NEVER be suppressed by neverRedact (H6).
 *  - "low": generic assignment/heuristic (api_key=…) — may collide with safe
 *    terms, so neverRedact filtering applies.
 * Defaults to "low" when omitted (backward compatible).
 */
export type PatternConfidence = "high" | "low";
export interface PatternDefinition {
    name: string;
    pattern: RegExp;
    category: PatternCategory;
    severity: PatternSeverity;
    description: string;
    /** Detection confidence — gates neverRedact suppression for credentials. */
    confidence?: PatternConfidence;
}
export interface PatternRegistry {
    credentialPatterns: PatternDefinition[];
    injectionPatterns: PatternDefinition[];
    piiPatterns: PatternDefinition[];
    policyPatterns: PatternDefinition[];
    neverRedact: Set<string>;
    addPattern(def: PatternDefinition): void;
    removePattern(name: string): void;
    getPattern(name: string): PatternDefinition | undefined;
}
export declare const DEFAULT_NEVER_REDACT: readonly string[];
/**
 * Return a global version of `re`, cloning it if the 'g' flag is missing.
 * Used everywhere a regex is driven in an exec()/match() loop so a user-added
 * non-global pattern can never spin forever (H8).
 */
export declare function ensureGlobal(re: RegExp): RegExp;
/** Create a fresh, independent pattern registry seeded with all built-ins. */
export declare function createRegistry(): PatternRegistry;
/** The shared default registry used by the core modules. */
export declare const registry: PatternRegistry;
//# sourceMappingURL=patterns.d.ts.map
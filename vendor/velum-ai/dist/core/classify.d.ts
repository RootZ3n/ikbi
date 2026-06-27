/**
 * Velum — Classification Engine
 * ============================================================
 * Classifies a single message into one trust category, redacting credentials
 * (and stashing them in the credential buffer) before they can reach a model.
 *
 * Priority:
 *   1. Credentials   → redact + buffer  → CREDENTIAL
 *   2. Injection     → flag             → PROMPT_INJECTION / INSTRUCTION_OVERRIDE / …
 *   3. Otherwise     → pass             → SAFE
 *
 * Credential + injection no longer downgrades to credential-only: after the
 * secret is redacted, the sanitized text is re-scanned for injection so both
 * signals survive (H3). Injection scanning runs over a normalized copy so
 * leetspeak / base64 / zero-width tricks can't slip past (H9).
 *
 * Known-safe terms (registry.neverRedact) and module/class-like tokens are
 * filtered out of LOW-confidence credential matches only; HIGH-confidence
 * matches (sk-…, AKIA…, ghp_…) are never suppressed (H6).
 * ============================================================
 */
import { type PatternRegistry } from "./patterns.js";
export type Classification = "SAFE" | "CREDENTIAL" | "PROMPT_INJECTION" | "INSTRUCTION_OVERRIDE" | "MEMORY_MANIPULATION" | "BOUNDARY_PROBE" | "UNSAFE_CONTENT";
export interface ClassificationResult {
    classification: Classification;
    action: "passed" | "redacted" | "flagged";
    sanitizedMessage: string;
    warnings: string[];
    patternsMatched: string[];
    credentialBufferIds: string[];
}
export interface ClassifyOptions {
    /** Store redacted credentials in the buffer (default true). */
    storeInBuffer?: boolean;
    /** Registry to draw patterns from (default: shared registry). */
    registry?: PatternRegistry;
}
export declare function classify(message: string, sessionId?: string, options?: ClassifyOptions): ClassificationResult;
//# sourceMappingURL=classify.d.ts.map
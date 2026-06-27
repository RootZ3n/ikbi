/**
 * Velum — Safe Pipeline API
 * ============================================================
 * One-call guard functions that wire the full Velum pipeline:
 *
 *   guardRequest:  classify input → scanContext → apply PII → return sanitized
 *   guardResponse: deep scan output → apply PII → demask → return safe response
 *
 * These are the recommended entry points for new integrations.
 * ============================================================
 */
import { type ClassificationResult } from "./classify.js";
import { type ContextScanInput, type ContextScanResult, type Decision, type ScanResult } from "./guard.js";
import { type PiiLevel, type PiiResult } from "./pii.js";
import { type PatternRegistry } from "./patterns.js";
export interface GuardRequestInput {
    /** Raw user input text. */
    input?: string;
    /** Full message array going to the model (system, user, assistant, tool). */
    messages?: ContextScanInput[];
    /** PII level override (default: 1 = observe only). */
    piiLevel?: PiiLevel;
    /** Optional pattern registry override. */
    registry?: PatternRegistry;
}
export interface GuardRequestResult {
    input: {
        classification: ClassificationResult;
        decision: Decision;
    };
    messages: {
        /** Sanitized message array (secrets redacted, injection flagged). */
        messages: ContextScanInput[];
        contextScan: ContextScanResult;
        /** Overall context decision. */
        decision: Decision;
    };
    pii: {
        result: PiiResult;
        /** Placeholder map for demasking responses (only at level 2). */
        placeholderMap?: Map<string, string>;
    };
    /** All credential buffer IDs from this request. */
    credentialBufferIds: string[];
    /** Highest decision across all stages. */
    decision: Decision;
}
/**
 * Full request guard. Classifies user input, scans the context array,
 * applies PII processing, and returns everything sanitized.
 */
export declare function guardRequest(input?: GuardRequestInput): GuardRequestResult;
export interface GuardResponseInput {
    /** Model output as text. */
    text?: string;
    /** Model output as structured object (e.g. OpenAI response shape). */
    object?: unknown;
    /** PII placeholder map from guardRequest (for demasking). */
    piiPlaceholderMap?: Map<string, string>;
    /** PII level override. */
    piiLevel?: PiiLevel;
    /** Optional pattern registry override. */
    registry?: PatternRegistry;
}
export interface GuardResponseResult {
    /** Safe text (redacted/blocked as needed). */
    text: string;
    /** Safe structured object (if input.object was provided). */
    object?: unknown;
    /** The output scan result. */
    outputScan: ScanResult;
    /** True if the response was blocked (secrets detected). */
    blocked: boolean;
    /** True if content was redacted. */
    redacted: boolean;
}
/**
 * Full response guard. Scans model output for secrets, PII, and dangerous
 * patterns. Supports both text and structured object responses (e.g.
 * `{choices: [{message: {content: "..."}}]}`).
 */
export declare function guardResponse(input?: GuardResponseInput): GuardResponseResult;
//# sourceMappingURL=pipeline.d.ts.map
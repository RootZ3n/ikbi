/**
 * Velum — Three-Stage Guard
 * ============================================================
 * A unified trust boundary applied at three points:
 *
 *   Stage 1 — INPUT:   user input before model execution
 *   Stage 2 — CONTEXT: model-bound context (tool/system/assistant content)
 *   Stage 3 — OUTPUT:  generated model output before it is shown/accepted
 *
 * Decisions (ascending severity):
 *   allow  — proceed normally
 *   warn   — proceed, but record it
 *   review — elevated scrutiny / annotate
 *   block  — stop (input: refuse; output: redact + refuse)
 * ============================================================
 */
import { type PatternRegistry } from "./patterns.js";
import { type PiiLevel } from "./pii.js";
export type Decision = "allow" | "warn" | "review" | "block";
export type Stage = "input" | "context" | "output";
export interface ScanResult {
    decision: Decision;
    reasons: string[];
    flags: string[];
    /** Populated when the guard produced a sanitized/redacted version of the text. */
    redacted?: string;
}
export interface ContextScanInput {
    role: string;
    content: unknown;
}
export interface ContextScanResult extends ScanResult {
    /** When secrets were found and redacted, this carries the sanitized messages. */
    redactedMessages?: ContextScanInput[];
}
export interface OutputGuardResult {
    /** Text the client should see (redacted on warn/review, refusal on block, else original). */
    text: string;
    /** Raw scan result, for receipts/telemetry. */
    scan: ScanResult;
    /** True when text was replaced with a refusal (block decision). */
    blocked: boolean;
    /** True when secrets were redacted in-place (non-block decision). */
    redacted: boolean;
}
export interface OutputGuardOptions {
    /** Treat refusals as in-character text (default false → neutral refusal). */
    inCharacter?: boolean;
    /** PII redaction level for output (>= 2 strips PII). Default 1 (off). */
    outputPiiLevel?: PiiLevel;
}
export declare function maxDecision(a: Decision, b: Decision): Decision;
export declare function scanInput(text: string, registry?: PatternRegistry): ScanResult;
export declare function scanContext(messages: ContextScanInput[], registry?: PatternRegistry): ContextScanResult;
export declare function scanOutput(text: string, registry?: PatternRegistry, opts?: {
    outputPiiLevel?: PiiLevel;
    maxScanBytes?: number;
}): ScanResult;
/**
 * Scan a candidate model output and return the text the client should see:
 *   - block  → a refusal substitute (never the original)
 *   - secret redacted (non-block) → the redacted text
 *   - otherwise → the original text
 * Always returns non-empty text on block.
 */
export declare function applyOutputGuardSync(text: string, opts?: OutputGuardOptions, registry?: PatternRegistry): OutputGuardResult;
export interface OutputStreamGuard {
    /** Feed a streamed chunk; returns the bytes safe to forward (may be ""). */
    push(chunk: string): string;
    /** Call once the stream ends; returns the guarded remaining tail. */
    flush(): string;
    /** True once a secret was detected and the stream was closed. */
    readonly blocked: boolean;
}
export interface OutputStreamGuardOptions extends OutputGuardOptions {
    /** Tail window in bytes (default 512). Must exceed the longest secret match. */
    tailBytes?: number;
}
/**
 * Build a streaming output guard. As chunks arrive they accumulate in a buffer;
 * the joined text is scanned so a secret spanning a chunk boundary is caught.
 * Bytes older than the tail window can't be part of a still-forming secret (any
 * secret touching them would already be complete and detected), so they're
 * released. On a credential block the guard emits a single refusal and closes:
 * every subsequent push() and the final flush() return "".
 */
export declare function createOutputStreamGuard(opts?: OutputStreamGuardOptions, registry?: PatternRegistry): OutputStreamGuard;
export interface DeepScanResult {
    /** The guarded value — same shape as input, string leaves transformed. */
    value: unknown;
    /** Aggregated scan over every string leaf. */
    scan: ScanResult;
    /** True when any leaf was blocked (replaced with a refusal). */
    blocked: boolean;
    /** True when any leaf was redacted in place. */
    redacted: boolean;
}
/**
 * Recursively scan a model response — a string OR a nested object/array shape
 * such as `{ choices: [{ message: { content: "…" } }] }` — and guard every
 * string leaf. Blocked leaves become a refusal; redacted leaves become their
 * sanitized text (H2).
 */
export declare function deepScanOutput(input: string | object, opts?: OutputGuardOptions, registry?: PatternRegistry): DeepScanResult;
//# sourceMappingURL=guard.d.ts.map
/**
 * Velum — PII Detection + Masking
 * ============================================================
 * Detects personally-identifiable information (email, phone, SSN, credit card,
 * IP, names) and applies one of three privacy levels:
 *
 *   Level 1 — Observe:  detect + log only, text unchanged
 *   Level 2 — Redact:   replace each value with a typed placeholder ([EMAIL_1]),
 *                       reversible via the returned placeholder map
 *   Level 3 — Sanitize: strip all PII to [REDACTED] (NOT reversible)
 *
 * Raw PII values are NEVER persisted — the detection log records type + count
 * only.
 *
 * False-positive guards (M5):
 *   - CREDIT_CARD matches must pass the Luhn checksum.
 *   - NAME detection is opt-in (detectNames) and requires a known first name
 *     or a nearby name cue ("name:", "contact:", "Mr.", …).
 * ============================================================
 */
import { type PatternRegistry } from "./patterns.js";
export interface PiiDetection {
    type: string;
    value: string;
    start: number;
    end: number;
}
export type PiiLevel = 1 | 2 | 3;
export interface ScanPiiOptions {
    /** Enable NAME detection (default false — too noisy without context). */
    detectNames?: boolean;
}
export interface PiiResult {
    detections: Array<{
        type: string;
        count: number;
    }>;
    masked: boolean;
    level: PiiLevel;
    maskedText?: string;
    placeholderMap?: Map<string, string>;
}
export interface PiiLogEntry {
    timestamp: string;
    level: PiiLevel;
    detections: Array<{
        type: string;
        count: number;
    }>;
    masked: boolean;
}
export declare function getDetectionLog(): PiiLogEntry[];
export declare function clearDetectionLog(): void;
/**
 * Scan text for PII. Returns non-overlapping detections sorted by position
 * descending (so callers can replace back-to-front without shifting indices).
 */
export declare function scanPii(text: string, registry?: PatternRegistry, options?: ScanPiiOptions): PiiDetection[];
/** Replace PII with reversible typed placeholders. Returns text + placeholder map. */
export declare function maskPii(text: string, registry?: PatternRegistry, options?: ScanPiiOptions): {
    text: string;
    placeholderMap: Map<string, string>;
};
/** Restore placeholders to their original values. */
export declare function demask(text: string, placeholderMap: Map<string, string>): string;
/** Strip all PII to [REDACTED]. Not reversible. */
export declare function sanitizePii(text: string, registry?: PatternRegistry, options?: ScanPiiOptions): string;
export declare function processWithPii(text: string, level: PiiLevel, registry?: PatternRegistry, options?: ScanPiiOptions): PiiResult;
//# sourceMappingURL=pii.d.ts.map
/**
 * Velum — Pattern Packs
 * ============================================================
 * A shareable, version-controlled bundle of detection patterns + safe terms.
 * Each ecosystem product ships its own pack instead of hand-coding addPattern()
 * calls. A pack is a JSON file:
 *
 *   {
 *     "name": "nusika",
 *     "version": "1.0.0",
 *     "patterns": [
 *       { "name": "x", "pattern": "REGEX_SOURCE", "flags": "gi",
 *         "category": "credential", "severity": "block", "description": "...",
 *         "confidence": "high" }
 *     ],
 *     "neverRedact": ["term1", "term2"]
 *   }
 *
 * `pattern` is a regex SOURCE string (not a /…/ literal) plus optional `flags`,
 * so packs stay pure JSON and never carry executable code.
 * ============================================================
 */
import type { PatternDefinition, PatternRegistry, PatternCategory, PatternSeverity, PatternConfidence } from "../core/patterns.js";
export interface PatternPackEntry {
    name: string;
    /** Regex source string (e.g. "ACME-[A-Z0-9]{20,}"). */
    pattern: string;
    /** Regex flags (default "g" for credential/pii so scan loops advance). */
    flags?: string;
    category: PatternCategory;
    severity: PatternSeverity;
    description: string;
    confidence?: PatternConfidence;
}
export interface PatternPack {
    name: string;
    version: string;
    patterns?: PatternPackEntry[];
    neverRedact?: string[];
}
/** Parse + validate a pattern-pack object (already JSON-decoded). */
export declare function parsePatternPack(raw: unknown, source?: string): PatternPack;
/** Read + parse a pattern pack from disk. */
export declare function loadPatternPack(path: string): PatternPack;
/** Convert a pack entry into a runtime PatternDefinition. */
export declare function entryToDefinition(e: PatternPackEntry): PatternDefinition;
/** Apply a parsed pack to a registry: add patterns + merge neverRedact terms. */
export declare function applyPatternPack(pack: PatternPack, registry: PatternRegistry): void;
//# sourceMappingURL=pattern-pack.d.ts.map
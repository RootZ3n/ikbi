/**
 * Velum — Product presets for `velum init --preset <product>`.
 *
 * Each preset pairs a config (raised PII level + product-safe `neverRedact`
 * terms) with a shareable pattern-pack JSON file. The config references the
 * pack via `patternPacks:`, so the product version-controls its own detection
 * rules instead of hand-coding addPattern() calls.
 */
import type { PatternPack } from "../config/pattern-pack.js";
import type { PiiLevel } from "../config/schema.js";
export interface Preset {
    name: string;
    /** Headline shown by `velum init --preset` / `--list-presets`. */
    summary: string;
    defaultPiiLevel: PiiLevel;
    neverRedact: string[];
    pack: PatternPack;
}
export declare const PRESETS: Record<string, Preset>;
export declare function listPresets(): string;
/** Render the velum.config.yaml text for a preset, referencing its pack file. */
export declare function renderPresetConfig(preset: Preset, packFileName: string): string;
//# sourceMappingURL=presets.d.ts.map
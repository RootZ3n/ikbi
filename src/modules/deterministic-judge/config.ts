/**
 * ikbi deterministic-judge — its OWN config slice (per-module config seam).
 *
 * Read ONLY through `moduleEnv("deterministic-judge")` — never `configEnv` directly
 * (module plan ## 8). The reader auto-prefixes `IKBI_DETERMINISTIC_JUDGE_`.
 *
 *   IKBI_DETERMINISTIC_JUDGE_ENABLED  on/off. DEFAULT ON — this only means the judge
 *                                     is AVAILABLE. The COMPETITIVE BUILD mode that
 *                                     uses it (next module) defaults OFF separately.
 *   IKBI_DETERMINISTIC_JUDGE_MAX_DIFF_LINES / _MAX_FILES  normalization ceilings.
 *
 * The family WEIGHTS are fixed constants here and MUST sum to 1.0 (asserted in test).
 */

import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("deterministic-judge");

/** Diff-size normalization ceiling: a diff this large scores 0 on the "diff" family. */
export const DEFAULT_MAX_DIFF_LINES = 2_000;
/** Files-touched normalization ceiling: this many files scores 0 on the "files" family. */
export const DEFAULT_MAX_FILES = 50;
/** Composite-equality epsilon for the tie-break (two composites within this are "tied"). */
export const TIE_EPSILON = 1e-9;

/** Family weights — MUST sum to 1.0. */
export const FAMILY_WEIGHTS = Object.freeze({
  tests: 0.35,
  efficiency: 0.25,
  diff: 0.2,
  files: 0.1,
  convergence: 0.1,
});

export interface DeterministicJudgeConfig {
  /** When false the judge module is inert (the competitive mode would not use it). */
  readonly enabled: boolean;
  readonly maxDiffLines: number;
  readonly maxFiles: number;
}

/** Load the deterministic-judge config slice from `IKBI_DETERMINISTIC_JUDGE_*`. */
export function loadDeterministicJudgeConfig(reader = env): DeterministicJudgeConfig {
  return Object.freeze({
    enabled: reader.bool("ENABLED", true),
    maxDiffLines: reader.int("MAX_DIFF_LINES", DEFAULT_MAX_DIFF_LINES, { min: 1 }),
    maxFiles: reader.int("MAX_FILES", DEFAULT_MAX_FILES, { min: 1 }),
  });
}

/** The process-wide deterministic-judge config. */
export const deterministicJudgeConfig: DeterministicJudgeConfig = loadDeterministicJudgeConfig();

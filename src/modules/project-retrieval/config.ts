/**
 * ikbi project-retrieval — config slice (`moduleEnv("project-retrieval")`, prefix
 * `IKBI_PROJECT_RETRIEVAL_`). No core-config edits.
 *
 *   IKBI_PROJECT_RETRIEVAL_BUDGET_BYTES        total selection budget. Default 60_000.
 *   IKBI_PROJECT_RETRIEVAL_PER_FILE_CAP_BYTES  per-file budget cost cap. Default 4_000.
 *   IKBI_PROJECT_RETRIEVAL_MAX_FILES           hard cap on returned files. Default 60.
 *   IKBI_PROJECT_RETRIEVAL_MAX_PER_TERM        drop a goal term that matches more than N files
 *                                              (too generic to be a useful seed). Default 8.
 */

import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("project-retrieval");

export const DEFAULT_BUDGET_BYTES = 60_000;
export const DEFAULT_PER_FILE_CAP_BYTES = 4_000;
export const DEFAULT_MAX_FILES = 60;
export const DEFAULT_MAX_PER_TERM = 8;
export const DEFAULT_MAX_SEEDS = 32;

/** Goal words ignored as seed terms (too generic to locate code). */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "and", "or", "for", "with", "on", "in", "into", "to", "of", "is", "are", "be",
  "fix", "bug", "add", "remove", "update", "make", "sure", "that", "this", "when", "where", "use",
  "package", "packages", "file", "files", "code", "test", "tests", "function", "method", "class",
  "feature", "issue", "error", "support", "implement", "implementation", "change", "changes", "new",
  "render", "rendering", "logic", "module", "modules", "src", "index",
]);

export interface ProjectRetrievalConfig {
  readonly budgetBytes: number;
  readonly perFileCapBytes: number;
  readonly maxFiles: number;
  readonly maxPerTerm: number;
  /** Hard cap on goal-mined seeds (bounds expansion fan-out + query cost). */
  readonly maxSeeds: number;
}

export function loadProjectRetrievalConfig(reader = env): ProjectRetrievalConfig {
  return Object.freeze({
    budgetBytes: reader.int("BUDGET_BYTES", DEFAULT_BUDGET_BYTES, { min: 1 }),
    perFileCapBytes: reader.int("PER_FILE_CAP_BYTES", DEFAULT_PER_FILE_CAP_BYTES, { min: 1 }),
    maxFiles: reader.int("MAX_FILES", DEFAULT_MAX_FILES, { min: 1 }),
    maxPerTerm: reader.int("MAX_PER_TERM", DEFAULT_MAX_PER_TERM, { min: 1 }),
    maxSeeds: reader.int("MAX_SEEDS", DEFAULT_MAX_SEEDS, { min: 1 }),
  });
}

export const projectRetrievalConfig: ProjectRetrievalConfig = loadProjectRetrievalConfig();

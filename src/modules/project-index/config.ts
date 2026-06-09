/**
 * ikbi project-index — its OWN config slice (read through `moduleEnv("project-index")`,
 * auto-prefix `IKBI_PROJECT_INDEX_`). No core-config edits.
 *
 *   IKBI_PROJECT_INDEX_MAX_FILE_BYTES   skip files larger than this entirely. Default 4MB.
 *   IKBI_PROJECT_INDEX_MAX_PARSE_BYTES  parse imports only over the first N bytes. Default 1MB.
 *   IKBI_PROJECT_INDEX_MAX_FILES        safety cap on indexed files (walk stops; truncated=true).
 *   IKBI_PROJECT_INDEX_SKIP_DIRS        extra directory names to skip (additive to the defaults).
 */

import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("project-index");

export const DEFAULT_MAX_FILE_BYTES = 4_000_000;
export const DEFAULT_MAX_PARSE_BYTES = 1_000_000;
export const DEFAULT_MAX_FILES = 200_000;

/** Directory names never descended into (independent of .gitignore). */
export const DEFAULT_SKIP_DIRS: readonly string[] = Object.freeze([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  "out",
  ".turbo",
  ".cache",
  ".svelte-kit",
]);

export interface ProjectIndexConfig {
  readonly maxFileBytes: number;
  readonly maxParseBytes: number;
  readonly maxFiles: number;
  readonly skipDirs: readonly string[];
}

/** Load the project-index config slice from `IKBI_PROJECT_INDEX_*`. */
export function loadProjectIndexConfig(reader = env): ProjectIndexConfig {
  return Object.freeze({
    maxFileBytes: reader.int("MAX_FILE_BYTES", DEFAULT_MAX_FILE_BYTES, { min: 1 }),
    maxParseBytes: reader.int("MAX_PARSE_BYTES", DEFAULT_MAX_PARSE_BYTES, { min: 1 }),
    maxFiles: reader.int("MAX_FILES", DEFAULT_MAX_FILES, { min: 1 }),
    skipDirs: Object.freeze([...new Set([...DEFAULT_SKIP_DIRS, ...reader.list("SKIP_DIRS")])]),
  });
}

/** The process-wide project-index config. */
export const projectIndexConfig: ProjectIndexConfig = loadProjectIndexConfig();

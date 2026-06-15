/**
 * ikbi worker-model — PROJECT MEMORY loader.
 *
 * Loads project-instruction files from the target repo root so the builder and chat
 * can honor repo-specific conventions. Loads:
 *   1. CLAUDE.md or AGENTS.md (first present wins — the primary source)
 *   2. IKBI.md (ikbi-specific project instructions — additive)
 *   3. .ikbi/project.md (project-specific config — additive)
 *   4. .ikbi/checks.yaml (custom check definitions — additive)
 *   5. .ikbi/ignore (files/patterns to ignore — additive)
 *
 * TRUST: file content is repo content (operator-authored, but still UNTRUSTED — a repo
 * could embed injection). Callers route it through the neutralization chokepoint
 * (neutralizeUntrusted) as an isolated data-role message — honored as project guidance,
 * but bounded and structurally isolated; never raw-concatenated into the trusted system prompt.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Project-instruction filenames, in priority order (first present wins). */
export const PROJECT_INSTRUCTION_FILES: readonly string[] = ["CLAUDE.md", "AGENTS.md"];

/** ikbi-specific config files loaded additively (all present files combined). */
export const IKBI_CONFIG_FILES: readonly string[] = [
  "IKBI.md",
  ".ikbi/project.md",
  ".ikbi/checks.yaml",
  ".ikbi/ignore",
];

/** Cap on instruction bytes injected per file — a large file must not crowd out the working context. */
export const MAX_PROJECT_INSTRUCTION_BYTES = 16_000;

/** Metadata about a single file that was loaded as part of project memory. */
export interface ProjectMemoryFile {
  /** Relative path from the repo root (e.g. "CLAUDE.md", ".ikbi/project.md"). */
  readonly path: string;
  /** Original byte count before any truncation. */
  readonly bytes: number;
  /** Whether the file was truncated to fit the byte cap. */
  readonly truncated: boolean;
}

/** Rich result of loading all project memory from a repo root. */
export interface ProjectMemoryResult {
  /** Combined content of all loaded files, for injection into the model context. */
  readonly content: string;
  /** The primary source name (first loaded file, for display/backward compat). */
  readonly source: string;
  /** All files that were loaded (primary + additive ikbi files). */
  readonly files: readonly ProjectMemoryFile[];
  /** Additive ikbi config files that were NOT found (all listed in IKBI_CONFIG_FILES). */
  readonly missing: readonly string[];
}

/** Load a single file with byte-bounding. Returns undefined if missing, unreadable, or empty. */
function tryLoadFile(root: string, name: string): { content: string; meta: ProjectMemoryFile } | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(root, name), "utf8");
  } catch {
    return undefined;
  }
  if (raw.trim().length === 0) return undefined;
  const truncated = raw.length > MAX_PROJECT_INSTRUCTION_BYTES;
  const content = truncated ? `${raw.slice(0, MAX_PROJECT_INSTRUCTION_BYTES)}\n…(truncated)` : raw;
  return { content, meta: { path: name, bytes: raw.length, truncated } };
}

/**
 * Load all project memory from `root`: primary instructions (CLAUDE.md / AGENTS.md — first
 * present wins) plus additive ikbi config files (IKBI.md, .ikbi/project.md, etc.).
 * Returns undefined when no files are found. NEVER throws.
 */
export function loadProjectMemory(root: string): ProjectMemoryResult | undefined {
  const files: ProjectMemoryFile[] = [];
  const missing: string[] = [];
  const parts: string[] = [];
  let primarySource = "";

  // Primary: CLAUDE.md / AGENTS.md (first present wins)
  for (const name of PROJECT_INSTRUCTION_FILES) {
    const loaded = tryLoadFile(root, name);
    if (loaded !== undefined) {
      files.push(loaded.meta);
      parts.push(loaded.content);
      primarySource = name;
      break;
    }
  }

  // Additive: ikbi config files (all present are loaded)
  for (const name of IKBI_CONFIG_FILES) {
    const loaded = tryLoadFile(root, name);
    if (loaded !== undefined) {
      files.push(loaded.meta);
      parts.push(`\n--- [${name}] ---\n${loaded.content}`);
    } else {
      missing.push(name);
    }
  }

  if (files.length === 0) return undefined;

  const source = primarySource.length > 0 ? primarySource : (files[0]?.path ?? "");
  return { content: parts.join("\n"), source, files, missing };
}

/**
 * Load the target repo's project instructions from `root` (CLAUDE.md, then AGENTS.md).
 * Returns the (bounded) content + which file it came from, or undefined when none exists or
 * is readable. NEVER throws — a missing/unreadable file is simply "no project memory".
 *
 * @deprecated Prefer `loadProjectMemory` — it also loads IKBI.md and .ikbi/ config files
 *   and returns richer metadata (file list, byte counts, missing files) for verbose display.
 */
export function loadProjectInstructions(root: string): { content: string; source: string } | undefined {
  const result = loadProjectMemory(root);
  if (result === undefined) return undefined;
  return { content: result.content, source: result.source };
}

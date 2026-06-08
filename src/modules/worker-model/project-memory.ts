/**
 * ikbi worker-model — PROJECT MEMORY loader (CLAUDE.md / AGENTS.md).
 *
 * Reads a target repo's project-instruction file from its ROOT so the builder and chat can
 * honor repo-specific conventions (the same role CLAUDE.md plays for Claude Code). It is a
 * bounded, read-only file read — a missing file returns undefined (never throws).
 *
 * TRUST: the file content is repo content (operator-authored, but still UNTRUSTED data — a
 * repo could embed injection). Callers route it through the neutralization chokepoint
 * (neutralizeUntrusted) as an isolated data-role message — honored as project guidance, but
 * bounded and structurally isolated; never raw-concatenated into the trusted system prompt.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Project-instruction filenames, in priority order (first present wins). */
export const PROJECT_INSTRUCTION_FILES: readonly string[] = ["CLAUDE.md", "AGENTS.md"];

/** Cap on instruction bytes injected — a large file must not crowd out the working context. */
export const MAX_PROJECT_INSTRUCTION_BYTES = 16_000;

/**
 * Load the target repo's project instructions from `root` (CLAUDE.md, then AGENTS.md).
 * Returns the (bounded) content + which file it came from, or undefined when none exists or
 * is readable. NEVER throws — a missing/unreadable file is simply "no project memory".
 */
export function loadProjectInstructions(root: string): { content: string; source: string } | undefined {
  for (const name of PROJECT_INSTRUCTION_FILES) {
    let raw: string;
    try {
      raw = readFileSync(join(root, name), "utf8");
    } catch {
      continue; // missing/unreadable — try the next candidate
    }
    if (raw.trim().length === 0) continue;
    const content = raw.length > MAX_PROJECT_INSTRUCTION_BYTES ? `${raw.slice(0, MAX_PROJECT_INSTRUCTION_BYTES)}\n…(truncated)` : raw;
    return { content, source: name };
  }
  return undefined;
}

/**
 * ikbi memory-governor — GUARD (path/slug checks).
 *
 * Determines whether a file path or brain slug is governed by the memory governor.
 * These are pure, deterministic checks — no model calls, no side effects.
 */

import {
  GOVERNED_FILE_PATHS,
  type MemorySurface,
} from "./contract.js";

/**
 * Check if a file path (relative to repo root) is governed.
 * Normalizes the path and checks against the governed list.
 *
 * Returns the surface type if governed, undefined otherwise.
 */
export function isGovernedPath(relPath: string): MemorySurface | undefined {
  // Normalize: strip leading ./, use forward slashes
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");

  // Check against governed file paths (exact match)
  for (const governed of GOVERNED_FILE_PATHS) {
    if (norm === governed || norm === `./${governed}`) {
      // Classify: .ikbi/ files are project_files, top-level files are instruction_files
      if (governed.startsWith(".ikbi/")) return "project_file";
      return "instruction_file";
    }
  }

  return undefined;
}

/**
 * Check if a brain slug is governed.
 * All brain_put calls are governed by default (any slug).
 *
 * Returns true if governed.
 */
export function isGovernedBrainSlug(_slug: string): boolean {
  // All brain slugs are governed by default.
  // If specific exemptions are needed later, add them here.
  return true;
}

/**
 * Derive the MemorySurface type for a brain slug.
 */
export function brainSurface(): "brain_page" {
  return "brain_page";
}

/**
 * Generate a deterministic proposal id from (surface, target).
 * Same inputs → same id → upsert semantics.
 *
 * IMPORTANT: the id becomes a filename (id + .json) in the DocumentStore, so
 * it MUST NOT contain path separators (/) or the store's structural confinement
 * rejects it. We replace / with -- (double dash) and sanitize to the store's
 * safe charset [A-Za-z0-9._:-].
 */
export function makeProposalId(surface: MemorySurface, target: string): string {
  const safe = target.replace(/\//g, "--").replace(/[^A-Za-z0-9._:-]/g, "_");
  return `${surface}:${safe}`;
}

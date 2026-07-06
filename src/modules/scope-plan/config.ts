/**
 * ikbi scope-plan — config.
 */

/**
 * Safety cap on stages parsed from a SCOPE.md. A build with more ordered stages than this is
 * almost certainly a malformed file (every line parsed as a stage), not a real plan — cap it so a
 * runaway file cannot spawn an unbounded chain of paid builder passes. Generous: a real product
 * decomposes into far fewer top-level stages than this.
 */
export const MAX_SCOPE_STAGES = 20;

/** Default file names probed at the repo root when `--scope` is not given an explicit path. */
export const DEFAULT_SCOPE_FILES: readonly string[] = ["SCOPE.md", ".ikbi/SCOPE.md"];

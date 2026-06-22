/**
 * ikbi correction-library — contract (types only).
 *
 * A correction is a REUSABLE LESSON learned from a build failure: what went wrong,
 * how to fix it, and how to verify the fix holds. Corrections are PROPOSED (by the
 * system or an operator) and only take effect once APPROVED — governance never lets
 * a self-discovered lesson silently rewrite future behavior (fail-closed).
 */

/**
 * What KIND of lesson a correction encodes. The first eight map onto the refuter's
 * refutation checklist (a refuted check proposes a correction of the matching
 * category); `custom` is the operator escape hatch for anything outside the taxonomy.
 */
export type CorrectionCategory =
  | "expected_manifest_change"
  | "tool_limitation"
  | "environment_missing"
  | "suspicious_pattern"
  | "test_weakening"
  | "forbidden_file"
  | "verification_forgery"
  | "conflict_resolution"
  | "custom";

/** The full set of categories (runtime list — for validation + filtering). */
export const CORRECTION_CATEGORIES: readonly CorrectionCategory[] = [
  "expected_manifest_change",
  "tool_limitation",
  "environment_missing",
  "suspicious_pattern",
  "test_weakening",
  "forbidden_file",
  "verification_forgery",
  "conflict_resolution",
  "custom",
] as const;

/** Runtime guard: is `s` a known correction category? */
export function isCorrectionCategory(s: string): s is CorrectionCategory {
  return (CORRECTION_CATEGORIES as readonly string[]).includes(s);
}

/** A single reusable correction entry. */
export interface CorrectionEntry {
  readonly id: string;
  readonly category: CorrectionCategory;
  /** What went wrong (the finding). */
  readonly finding: string;
  /** How to fix it (the correction). */
  readonly correction: string;
  /** How to verify the fix holds (the regression guard). */
  readonly regression: string;
  /** Which run discovered this, if any. */
  readonly sourceRunId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Who proposed it: "system" (auto, from a refuted build) or "operator". */
  readonly proposedBy: string;
  /** Governance: corrections are PROPOSED, not auto-installed. */
  readonly approved: boolean;
  /** How many times this correction has been applied. */
  readonly appliedCount: number;
  /** ISO timestamp of the last application, if ever applied. */
  readonly lastAppliedAt?: string;
}

/** Input shape for proposing a new correction (server fills id/timestamps/counters). */
export interface CorrectionProposeInput {
  readonly category: CorrectionCategory;
  readonly finding: string;
  readonly correction: string;
  readonly regression: string;
  readonly sourceRunId?: string;
  readonly proposedBy?: string;
  /** Optional pre-approval (operator path). Defaults to false (proposed, not installed). */
  readonly approved?: boolean;
}

/** Optional filter for listing corrections. */
export interface CorrectionFilter {
  readonly category?: CorrectionCategory;
  readonly approved?: boolean;
}

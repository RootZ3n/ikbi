/**
 * ikbi repo-doctor — contract (types only).
 *
 * Health analysis across 6 dimensions, each scored 0-100.
 */

/** The 6 health dimensions. */
export type HealthDimension =
  | "file-health"
  | "dependency-health"
  | "test-health"
  | "doc-health"
  | "import-health"
  | "structure-health";

/** Severity of a finding. */
export type FindingSeverity = "info" | "warning" | "critical";

/** A single health finding. */
export interface Finding {
  readonly dimension: HealthDimension;
  readonly severity: FindingSeverity;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly suggestion?: string;
}

/** Score and findings for one dimension. */
export interface DimensionReport {
  readonly dimension: HealthDimension;
  readonly score: number;
  readonly findings: readonly Finding[];
  readonly scannedAt: string;
}

/** The full health report across all dimensions. */
export interface HealthReport {
  readonly overallScore: number;
  readonly dimensions: readonly DimensionReport[];
  readonly scannedAt: string;
  readonly repoPath: string;
}

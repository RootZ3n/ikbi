/**
 * ikbi spec-artifact — contract (types only).
 *
 * Spec artifacts are first-class editable plans generated from goals.
 * Users can review and modify steps before execution.
 */

/** Status of a spec artifact. */
export type SpecStatus = "draft" | "approved" | "executing" | "completed" | "failed" | "not_implemented";

/** A single step in a spec. */
export interface SpecStep {
  readonly index: number;
  readonly goal: string;
  readonly targetFiles?: readonly string[];
  readonly verificationHint?: string;
}

/** The SCOPE of a structured spec card: what is in-scope vs explicitly out-of-scope. */
export interface SpecScope {
  readonly in: readonly string[];
  readonly out: readonly string[];
}

/** A spec artifact — an editable, executable plan. */
export interface SpecArtifact {
  readonly id: string;
  readonly goal: string;
  readonly steps: readonly SpecStep[];
  readonly status: SpecStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Result output after execution, if any. */
  readonly output?: string;
  /** Error message if execution failed. */
  readonly error?: string;

  // ── Structured spec-card fields (all optional — a plain-goal spec omits them) ──
  /** PROJECT name. */
  readonly project?: string;
  /** SCOPE — in / out boundaries. */
  readonly scope?: SpecScope;
  /** RULES (constraints the build must honor). */
  readonly rules?: readonly string[];
  /** Expected OUTPUT format / acceptance description. */
  readonly outputFormat?: string;
  /** ON CONFLICT behavior (what to do when the change collides with existing work). */
  readonly onConflict?: string;
  /** Referenced correction IDs (lessons from the correction library to apply). */
  readonly corrections?: readonly string[];
  /** Cost ceiling for the build, in USD. */
  readonly maxCostUsd?: number;
  /** Blast-radius cap: maximum number of files the build may change. */
  readonly maxFilesChanged?: number;
}

/**
 * The optional structured fields attachable to a spec at creation time. Distinct from
 * the lifecycle fields (status/output/error) the store manages itself.
 */
export type SpecCardFields = Partial<
  Pick<
    SpecArtifact,
    | "project"
    | "scope"
    | "rules"
    | "outputFormat"
    | "onConflict"
    | "corrections"
    | "maxCostUsd"
    | "maxFilesChanged"
  >
>;

/** Input for generating a spec. */
export interface SpecGenerateInput {
  readonly goal: string;
  /** When true, the goal is parsed as a structured PROJECT/GOAL/SCOPE/RULES/... card. */
  readonly structured?: boolean;
}

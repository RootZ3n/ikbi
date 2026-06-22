/**
 * ikbi spec-artifact — contract (types only).
 *
 * Spec artifacts are first-class editable plans generated from goals.
 * Users can review and modify steps before execution.
 */

/** Status of a spec artifact. */
export type SpecStatus = "draft" | "approved" | "executing" | "completed" | "failed";

/** A single step in a spec. */
export interface SpecStep {
  readonly index: number;
  readonly goal: string;
  readonly targetFiles?: readonly string[];
  readonly verificationHint?: string;
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
}

/** Input for generating a spec. */
export interface SpecGenerateInput {
  readonly goal: string;
}

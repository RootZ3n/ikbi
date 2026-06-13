/**
 * ikbi step-planner — contract (types only).
 *
 * The step-planner breaks a complex goal into a chain of atomic steps.
 * Each step is simple enough for a cheap model to handle. The orchestrator
 * runs each step through the builder + verifier, failing closed if any step fails.
 *
 * WHY: Cheap models fail on complex multi-step tasks. They can't juggle
 * "read file A, modify B, add test C, update docs D" in one shot.
 * But they CAN handle "read file A and add function X" — one atomic step.
 */

/** A single atomic step in a step plan. */
export interface Step {
  /** 1-based step number. */
  readonly index: number;
  /** The goal for this step — simple enough for a cheap model. */
  readonly goal: string;
  /** Files this step is expected to touch (best-effort, for context). */
  readonly targetFiles?: readonly string[];
  /**
   * How to verify this step succeeded (human-readable, for the verifier).
   *
   * L4 — RESERVED, not yet consumed. The planner stamps this on the LAST step, but no current
   * caller reads it: the `ikbi build` CLI runs its own fixed verification (pnpm test via the
   * verifier role) regardless. It is retained as the documented seam for a future enhancement
   * that threads the hint into the final verify goal — wiring it later is a call-site change,
   * not a contract change. Until then it is intentionally advisory metadata, not dead weight.
   */
  readonly verificationHint?: string;
}

/** A decomposed step plan. */
export interface StepPlan {
  /** The original complex goal. */
  readonly originalGoal: string;
  /** The decomposed steps, in order. */
  readonly steps: readonly Step[];
  /** How the plan was generated. */
  readonly source: "heuristic" | "model";
  /** Whether the goal was actually complex (false = no decomposition needed). */
  readonly decomposed: boolean;
}

/** Result of executing one step. */
export interface StepResult {
  readonly step: Step;
  readonly outcome: "success" | "failure" | "skipped";
  readonly summary?: string;
}

/** Result of executing a full step plan. */
export interface StepPlanResult {
  readonly plan: StepPlan;
  readonly results: readonly StepResult[];
  readonly outcome: "success" | "failure";
  readonly reason?: string;
}

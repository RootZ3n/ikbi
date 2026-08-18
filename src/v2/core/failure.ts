/**
 * ikbi v2 — THE STRUCTURED FAILURE TAXONOMY.
 *
 * A v2 run never fails as a thrown string. Failure is DATA: a category (what kind
 * of thing went wrong — stable, small, closed), a code (which specific thing —
 * extensible per slice), the stage it happened in, and whether retrying could
 * plausibly help. Receipts, exit codes, escalation policy and recovery policy all
 * read the same object, so they can never disagree about why a run ended.
 *
 * The CATEGORY set is the stable part and is intended to survive every later slice.
 * The CODE set grows: each slice adds the codes for the stage it implements. That
 * split is deliberate — categories are an interface, codes are an implementation
 * detail that must stay free to become more precise.
 *
 * `not_implemented` is a first-class category, not a squatter on `internal`. This
 * slice ships a lifecycle whose later stages genuinely do not exist yet, and the
 * only honest way to report that is to say so in the type system rather than
 * dressing it up as an internal error — or worse, as a success.
 */

import type { LifecycleStage } from "./lifecycle.js";

/**
 * Top-level failure domains. One owner each; a later slice extends CODES, not this list.
 *
 *   task            — the request itself is invalid (empty goal, unusable repo path).
 *   preflight       — configuration/environment is not fit to start (missing repo, no config).
 *   provider        — a model invocation failed (transport, auth, context overflow, refusal).
 *   workspace       — isolation failed (worktree allocation, lock, stale/dirty state).
 *   mutation        — a state-bound edit was refused (stale observation, unobserved target).
 *   context         — the authorized context package could not be assembled or bounded.
 *   build           — candidate generation failed (builder gave up, protocol stop, no work).
 *   verification    — verification could not produce a trustworthy verdict.
 *   recovery        — recovery/retry budget exhausted without a good candidate.
 *   policy          — an authority said no (gate-wall, trust tier, kill switch, budget).
 *   resolution      — no model/provider route could be AUTHORIZED for a role. Distinct
 *                     from `provider`: nothing was contacted, nothing failed in flight —
 *                     the selection itself is impossible or forbidden.
 *   promotion       — the decision could not be enacted (conflict, CAS lost, stale tree).
 *   internal        — an engine defect or infrastructure fault. Nobody's build was wrong.
 *   not_implemented — this build of ikbi does not implement a stage the run requires.
 */
export const RUN_FAILURE_CATEGORIES = [
  "task",
  "preflight",
  "provider",
  "workspace",
  "mutation",
  "context",
  "build",
  "verification",
  "recovery",
  "resolution",
  "policy",
  "promotion",
  "internal",
  "not_implemented",
] as const;

export type RunFailureCategory = (typeof RUN_FAILURE_CATEGORIES)[number];

/** Runtime guard: is `s` a known failure category? */
export function isRunFailureCategory(s: string): s is RunFailureCategory {
  return (RUN_FAILURE_CATEGORIES as readonly string[]).includes(s);
}

/** Structured, reportable failure. The ONLY way a v2 run reports "this did not work". */
export interface RunFailure {
  readonly category: RunFailureCategory;
  /** Stable machine code, namespaced by category (e.g. "preflight.repo_not_a_git_repo"). */
  readonly code: string;
  /** Operator-facing sentence. No stack traces, no provider jargon. */
  readonly message: string;
  /** Where in the lifecycle it happened. Absent only for failures raised before preflight. */
  readonly stage?: LifecycleStage;
  /** Could an identical retry plausibly succeed? Recovery policy (a later slice) reads this. */
  readonly retryable: boolean;
  /** Small, printable, non-secret context. Never raw model output, never credentials. */
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

/** The failure codes THIS slice can actually produce. Later slices add their own. */
export const V2_001_FAILURE_CODES = {
  goalEmpty: "task.goal_empty",
  goalTooLong: "task.goal_too_long",
  repoMissing: "preflight.repo_path_missing",
  repoNotDirectory: "preflight.repo_path_not_a_directory",
  repoNotGit: "preflight.repo_not_a_git_repo",
  strategyUnknown: "task.candidate_strategy_unknown",
  stageNotImplemented: "not_implemented.lifecycle_stage",
} as const;

/** Build a failure. `detail`/`stage` are omitted rather than set to undefined (exactOptional). */
export function runFailure(input: {
  readonly category: RunFailureCategory;
  readonly code: string;
  readonly message: string;
  readonly stage?: LifecycleStage;
  readonly retryable?: boolean;
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}): RunFailure {
  return {
    category: input.category,
    code: input.code,
    message: input.message,
    retryable: input.retryable ?? false,
    ...(input.stage !== undefined ? { stage: input.stage } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  };
}

/**
 * The honest failure for a stage this build cannot perform. Retryable is FALSE:
 * running it again will not make an unimplemented stage exist.
 */
export function stageNotImplemented(stage: LifecycleStage, reachedStage: LifecycleStage): RunFailure {
  return runFailure({
    category: "not_implemented",
    code: V2_001_FAILURE_CODES.stageNotImplemented,
    message: `the v2 lifecycle stage "${stage}" is not implemented in this build — the run stopped after "${reachedStage}" without building, verifying, or promoting anything`,
    stage: reachedStage,
    retryable: false,
    detail: { missingStage: stage, reachedStage },
  });
}

/** One-line operator rendering: `[category] message`. */
export function formatRunFailure(failure: RunFailure): string {
  return `[${failure.category}] ${failure.message}`;
}

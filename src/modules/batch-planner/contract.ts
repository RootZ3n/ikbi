/**
 * ikbi batch-planner — THE MODULE CONTRACT (versioned).
 *
 * Parallel goal-decomposition orchestration ABOVE worker-model — ikbi's parity with
 * how a top coding agent handles a large multi-step prompt: decompose into
 * dependency-ordered subtasks, build them in parallel (within a dependency level),
 * promote in dependency order, stop-and-report on a merge conflict.
 *
 * It is NOT a new execution surface: it makes ONE model call (the decomposition) and
 * calls `orchestrator.run()` once per subtask — each a FULL governed worker run
 * (gate-wall, receipts, promote, exactly as today). batch-planner executes nothing
 * directly and gates nothing directly; worker-model does both, per subtask.
 *
 * SCHEDULING: subtasks are grouped into dependency LEVELS (level 0 = no deps; level N
 * = all deps in levels < N). Levels run in order; within a level subtasks are
 * independent and build in PARALLEL. Level ordering gives dependency-correct promotes
 * for FREE — a later level builds off the target head that already includes earlier
 * levels' promotes (the workspace layer's branch-lock + conflict-detecting promote
 * means no clobber).
 *
 * CONFLICT POLICY v1 = STOP-AND-REPORT: a rejected merge (a subtask promoted:false
 * with outcome "partial") or a failed subtask HALTS scheduling — report the
 * subtask/level/reason, leave already-promoted work intact. No retry, no resolve, no
 * clobber. The policy is a SEAM (a `ConflictPolicy` function) so "retry against the
 * updated base" (option B) can replace it later without restructuring.
 *
 * No frozen-core change.
 *
 * CONTRACT_VERSION changelog (newest on top):
 *   1.0.0 — initial batch-planner contract: Subtask / BatchPlan / SubtaskOutcome /
 *           BatchResult, decompose→schedule→run-levels, validated DAG, stop-and-report.
 */

import type { OperationContext } from "../../core/identity/index.js";
import type { WorkerResult } from "../worker-model/index.js";

/** Semantic version of the batch-planner contract. Bump on breaking change. */
export const CONTRACT_VERSION = "1.0.0";

/** One decomposed unit of work + the subtasks it must follow. */
export interface Subtask {
  /** Stable id within this batch (kebab-case). */
  readonly subtaskId: string;
  /** The subtask goal (fed to a normal governed worker run). */
  readonly goal: string;
  /** subtaskIds that must complete (promote) before this one builds. */
  readonly dependsOn: readonly string[];
}

/** A validated plan: the subtasks + their topological dependency levels. */
export interface BatchPlan {
  readonly batchId: string;
  readonly subtasks: readonly Subtask[];
  /** Dependency levels: levels[i] is the subtaskIds buildable once levels < i are done. */
  readonly levels: readonly (readonly string[])[];
}

/** A subtask's terminal status. */
export type SubtaskStatus =
  | "promoted" // built + merged into the target
  | "conflicted" // merge rejected (target untouched) — stop-and-report
  | "failed" // the worker run failed/rejected, or threw
  | "not-reached"; // scheduling stopped before this subtask ran

/** A subtask's outcome (full transparency for the receipt/audit). */
export interface SubtaskOutcome {
  readonly subtaskId: string;
  readonly status: SubtaskStatus;
  readonly level: number;
  readonly promoted: boolean;
  readonly reason?: string;
  readonly workspaceId?: string;
}

/** The overall batch status. */
export type BatchStatus = "completed" | "stopped-on-conflict" | "stopped-on-failure" | "rejected";

/** The result of a batch run — plan + per-subtask outcomes + overall status. */
export interface BatchResult {
  readonly batchId: string;
  readonly status: BatchStatus;
  /** The validated plan (absent only when decomposition itself was rejected). */
  readonly plan?: BatchPlan;
  readonly outcomes: readonly SubtaskOutcome[];
  /** Human reason on a rejected/stopped batch. */
  readonly reason?: string;
  /** How many subtasks promoted. */
  readonly promotedCount: number;
}

/** A classified verdict for one subtask's worker run. */
export interface ConflictVerdict {
  /** Stop scheduling further levels. */
  readonly stop: boolean;
  /** The terminal status to record for this subtask. */
  readonly status: SubtaskStatus;
}

/**
 * The conflict-policy SEAM. Given a subtask's worker result, decide whether to stop
 * and how to classify it. v1 default = stop-and-report; a future retry policy swaps in.
 */
export type ConflictPolicy = (result: WorkerResult, subtask: Subtask) => ConflictVerdict;

/** Input to a batch run. */
export interface BatchRunInput {
  readonly parentCtx: OperationContext;
  readonly goal: string;
  readonly targetRepo: string;
  readonly baseBranch?: string;
}

/** The batch-planner surface. */
export interface BatchPlanner {
  /** Decompose → schedule → run levels → apply conflict policy → report. */
  planAndRun(input: BatchRunInput): Promise<BatchResult>;
}

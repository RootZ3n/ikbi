/**
 * ikbi HTTP task registry — the in-memory state for build/fix tasks submitted over
 * the API (Phase 10.1, the Pehlichi↔ikbi integration foundation).
 *
 * A single process-wide `Map<taskId, TaskState>`. PURE state + queries — it neither
 * runs builds nor touches the event bus (that is the task SERVICE's job, see tasks.ts).
 * Tasks are EPHEMERAL: like the HTTP `/chat` sessions, they live in RAM only and do not
 * survive a restart (the durable record of a run is its receipts, never this map).
 */

/** The kind of work a task represents. */
export type TaskKind = "build" | "fix";

/**
 * A task's lifecycle status. `running` and `cancelling` are the non-terminal states;
 * the three terminal states are written exactly once (a cancelled task never flips to
 * success). `cancelling` means an operator requested cancellation but the underlying run
 * is still draining (it stops at its next check boundary, then settles to `cancelled`) —
 * a cancelling task still occupies a concurrency slot until its run actually finishes.
 */
export type TaskStatus = "running" | "cancelling" | "success" | "failure" | "cancelled";

/** One role's progress within a task (mirrors the worker pipeline's per-role result). */
export interface TaskRoleState {
  readonly role: string;
  /** "running" while in flight, then the role's terminal outcome. */
  readonly outcome: string;
  /** USD cost attributed to this role, when known. */
  readonly cost?: number;
  /** Builder tool-loop round count, surfaced live for the in-flight builder role. */
  readonly rounds?: number;
}

/** The full tracked state of one submitted task. Serializable (the API view derives from it). */
export interface TaskState {
  readonly taskId: string;
  readonly kind: TaskKind;
  status: TaskStatus;
  /** The goal text (build always; fix when supplied). */
  readonly goal?: string;
  /** Absolute path to the target repo. */
  readonly repo: string;
  /** ISO-8601 submit time. */
  readonly startedAt: string;
  /** ISO-8601 terminal time (absent while running). */
  finishedAt?: string;
  /** Per-role progress, in dispatch order. */
  roles: TaskRoleState[];
  /** Total USD across every model call the run made. */
  totalCost: number;
  /** Repo-relative paths the run changed. */
  filesChanged: string[];
  /** "pass" / "fail" / a verifier verdict string, when verification ran. */
  verificationResult?: string;
  /** Human reason on a non-success terminal. */
  reason?: string;
}

/** Filters for {@link TaskRegistry.list}. */
export interface TaskListQuery {
  readonly status?: TaskStatus;
  readonly limit?: number;
  readonly offset?: number;
}

/** A page of tasks plus the total matched (before limit/offset). */
export interface TaskListResult {
  readonly tasks: readonly TaskState[];
  readonly total: number;
}

/**
 * The in-memory task registry. Append + mutate-in-place; queries return defensive
 * copies so a caller can never mutate stored state out from under the service.
 */
export class TaskRegistry {
  private readonly tasks = new Map<string, TaskState>();

  /** Insert a freshly-created task. Throws on a duplicate id (a wiring/id-collision bug). */
  add(state: TaskState): void {
    if (this.tasks.has(state.taskId)) {
      throw new Error(`task "${state.taskId}" already registered`);
    }
    this.tasks.set(state.taskId, state);
  }

  /** The live (mutable) state for in-service updates, or undefined if unknown. */
  get(taskId: string): TaskState | undefined {
    return this.tasks.get(taskId);
  }

  /** Number of tasks currently in the `running` state (for the concurrency cap). */
  runningCount(): number {
    let n = 0;
    for (const t of this.tasks.values()) if (t.status === "running") n += 1;
    return n;
  }

  /**
   * List tasks newest-first (insertion order is chronological), optionally filtered by
   * status and windowed by offset/limit. `total` is the count BEFORE windowing.
   */
  list(query: TaskListQuery = {}): TaskListResult {
    let all = [...this.tasks.values()].reverse();
    if (query.status !== undefined) all = all.filter((t) => t.status === query.status);
    const total = all.length;
    const offset = query.offset !== undefined && query.offset > 0 ? query.offset : 0;
    const windowed = query.limit !== undefined && query.limit >= 0 ? all.slice(offset, offset + query.limit) : all.slice(offset);
    return { tasks: windowed, total };
  }

  /** Test-only: clear all tasks. */
  reset(): void {
    this.tasks.clear();
  }
}

/** Render a task's tracked state as the public API JSON view (omitting absent fields). */
export function toPublicTask(t: TaskState): Record<string, unknown> {
  return {
    taskId: t.taskId,
    kind: t.kind,
    status: t.status,
    ...(t.goal !== undefined ? { goal: t.goal } : {}),
    repo: t.repo,
    startedAt: t.startedAt,
    ...(t.finishedAt !== undefined ? { finishedAt: t.finishedAt } : {}),
    roles: t.roles,
    totalCost: t.totalCost,
    filesChanged: t.filesChanged,
    ...(t.verificationResult !== undefined ? { verificationResult: t.verificationResult } : {}),
    ...(t.reason !== undefined ? { reason: t.reason } : {}),
  };
}

/**
 * ikbi HTTP task SERVICE — the orchestration behind the /api/build, /api/fix, and
 * /api/tasks endpoints (Phase 10.1).
 *
 * Holds the {@link TaskRegistry}, kicks off build/fix runs ASYNCHRONOUSLY (the HTTP
 * handler returns 202 immediately), and folds the worker's live `worker.*` events into
 * the tracked task state so a poller / SSE stream sees role-by-role progress.
 *
 * GOVERNANCE: the live build runner goes through the SAME `createProductionWorker`
 * wiring `ikbi build` and `ikbi batch` use (shared-worker roleClaim + REAL gate-wall),
 * so an API-submitted build is governed identically to a CLI build. Cancellation is a
 * COOPERATIVE per-run kill-check (the orchestrator already polls it at role boundaries).
 *
 * All collaborators are injected (defaults wire the live singletons) so the service is
 * testable without a model key, a worktree, or real subprocesses.
 */

import { beginOperation, resolveIdentity as coreResolveIdentity } from "../core/identity/index.js";
import type { OperationContext, ValidatedIdentity } from "../core/identity/index.js";
import { events as coreEvents } from "../core/events/index.js";
import type { EventBusSurface, IkbiEvent } from "../core/events/index.js";
import { config } from "../core/config.js";
import type { WorkerResult, WorkerTask } from "../modules/worker-model/index.js";
import type { FixCheckCommand, FixOutcome } from "../modules/worker-model/fix.js";
import { TaskRegistry, type TaskRoleState, type TaskState, type TaskStatus } from "./task-registry.js";

/** Validated body for a build submission (the route validates shape; this is the typed unit). */
export interface BuildSubmission {
  readonly goal: string;
  readonly repo: string;
  readonly builderMode?: "agent" | "patch";
  readonly priority?: string;
}

/** Validated body for a fix submission. */
export interface FixSubmission {
  readonly repo: string;
  readonly check?: string;
  readonly goal?: string;
  readonly allowTestEdits?: boolean;
}

/** Maximum tasks that may be `running` at once (the API concurrency cap). */
export const MAX_CONCURRENT_TASKS = 3;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Split a `"<cmd> <args...>"` check string into a command + args (whitespace-tokenized). */
function splitCheck(raw: string | undefined): FixCheckCommand | undefined {
  if (raw === undefined) return undefined;
  const toks = raw.trim().split(/\s+/).filter((t) => t.length > 0);
  if (toks.length === 0) return undefined;
  return { command: toks[0]!, args: toks.slice(1) };
}

/** Injectable collaborators (defaults wire the live, governed singletons). */
export interface TaskServiceDeps {
  /**
   * Run a build to completion under the given cancellation seam. Default: the governed
   * production worker (shared-worker roleClaim + real gate-wall + per-run kill-check).
   */
  readonly runBuild?: (task: WorkerTask, ctx: OperationContext, isCancelled: () => boolean) => Promise<WorkerResult>;
  /**
   * Run a fix pipeline to completion under the given cancellation seam (H1): the pipeline
   * polls `isCancelled` at its check boundaries and stops early (SAFE_FAIL) when set.
   * Default: the governed fix pipeline.
   */
  readonly runFix?: (req: FixSubmission, ctx: OperationContext, isCancelled: () => boolean) => Promise<FixOutcome>;
  /** Resolve a token to a validated identity. Default: the core resolver. */
  readonly resolveIdentity?: (claim: { token: string }) => ValidatedIdentity;
  /** Event bus the role-progress folder subscribes to. Default: the live bus. */
  readonly events?: EventBusSurface;
  /** Clock for task ids + timestamps. Default: Date.now. */
  readonly now?: () => number;
  /** Operator credential. Default: config (IKBI_OPERATOR_TOKEN). */
  readonly operatorToken?: string | undefined;
  /** Shared-worker credential. Default: config (IKBI_WORKER_TOKEN). */
  readonly workerToken?: string | undefined;
}

/** The task service: registry + async run orchestration + live event folding. */
export class TaskService {
  readonly registry = new TaskRegistry();
  private readonly cancelled = new Set<string>();
  /**
   * Task ids whose run is ACTUALLY executing right now — the true concurrency gate. A task
   * stays in this set from submit until its run settles (success/failure/cancelled), so a
   * `cancelling` task keeps its slot reserved and cannot be used to bypass the cap (H2).
   */
  private readonly live = new Set<string>();
  /** Monotonic suffix making same-millisecond task ids unique (H5). */
  private idCounter = 0;
  private readonly deps: TaskServiceDeps;
  private readonly events: EventBusSurface;
  private readonly now: () => number;
  private subscribed = false;

  constructor(deps: TaskServiceDeps = {}) {
    this.deps = deps;
    this.events = deps.events ?? coreEvents;
    this.now = deps.now ?? Date.now;
  }

  /** True iff both operator + shared-worker credentials are configured (build/fix need them). */
  credentialsConfigured(): boolean {
    const op = "operatorToken" in this.deps ? this.deps.operatorToken : config.identity.operatorToken;
    const wk = "workerToken" in this.deps ? this.deps.workerToken : config.identity.workerToken;
    return op !== undefined && op.length > 0 && wk !== undefined && wk.length > 0;
  }

  /**
   * Are we already at the concurrent-task cap? Counts tasks whose run is ACTUALLY live —
   * a `cancelling` task still counts (its run is draining), so cancel cannot free a slot
   * for a new submission before the underlying work has stopped (H2).
   */
  atCapacity(): boolean {
    return this.live.size >= MAX_CONCURRENT_TASKS;
  }

  /** Mint a unique task id — `<kind>-<ms>-<counter>` — collision-free even within one ms (H5). */
  private nextTaskId(kind: "build" | "fix"): string {
    return `${kind}-${this.now()}-${this.idCounter++}`;
  }

  /**
   * Submit a build. Creates the task, kicks off the run asynchronously, and returns the
   * id immediately — the caller (route) has already validated the body + capacity.
   */
  submitBuild(sub: BuildSubmission): string {
    const taskId = this.nextTaskId("build");
    const state: TaskState = {
      taskId,
      kind: "build",
      status: "running",
      goal: sub.goal,
      repo: sub.repo,
      startedAt: new Date(this.now()).toISOString(),
      roles: [],
      totalCost: 0,
      filesChanged: [],
    };
    this.registry.add(state);
    this.live.add(taskId);
    this.ensureSubscribed();
    void this.runBuild(state, sub);
    return taskId;
  }

  /** Submit a fix. Same async-accept contract as {@link submitBuild}. */
  submitFix(sub: FixSubmission): string {
    const taskId = this.nextTaskId("fix");
    const state: TaskState = {
      taskId,
      kind: "fix",
      status: "running",
      ...(sub.goal !== undefined ? { goal: sub.goal } : {}),
      repo: sub.repo,
      startedAt: new Date(this.now()).toISOString(),
      roles: [],
      totalCost: 0,
      filesChanged: [],
    };
    this.registry.add(state);
    this.live.add(taskId);
    this.ensureSubscribed();
    void this.runFix(state, sub);
    return taskId;
  }

  /**
   * Request cancellation of a running task. Returns false if unknown or already terminal/
   * cancelling. Moves the task to the non-terminal `cancelling` state and arms the
   * cooperative kill-check: the in-flight worker (build) or fix pipeline stops at its next
   * check boundary, the slot stays reserved (H2) until the run drains, and the eventual run
   * result settles the task to the terminal `cancelled` status (it never flips to success).
   * Emits a terminal `task.cancelled` event so any open SSE stream closes promptly (H4).
   */
  cancel(taskId: string): boolean {
    const state = this.registry.get(taskId);
    if (state === undefined || state.status !== "running") return false;
    this.cancelled.add(taskId);
    state.status = "cancelling";
    state.reason = "cancelled by operator";
    this.emitTerminal("task.cancelled", taskId, state.status, state.totalCost);
    return true;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private isCancelled(taskId: string): boolean {
    return this.cancelled.has(taskId);
  }

  /** Subscribe ONCE to worker.* events to fold live role progress into task state. */
  private ensureSubscribed(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    this.events.subscribe({ typePrefix: "worker.", label: "http-task-progress" }, (e) => this.onWorkerEvent(e));
  }

  /** Fold one worker event into its task's tracked state (best-effort; never throws). */
  private onWorkerEvent(e: IkbiEvent): void {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const taskId = typeof p.taskId === "string" ? p.taskId : undefined;
    if (taskId === undefined) return;
    const state = this.registry.get(taskId);
    if (state === undefined || state.status !== "running") return;
    switch (e.type) {
      case "worker.role.dispatched": {
        const role = String(p.role ?? "?");
        if (!state.roles.some((r) => r.role === role)) state.roles.push({ role, outcome: "running" });
        break;
      }
      case "worker.builder.activity": {
        const rounds = typeof p.toolRounds === "number" ? p.toolRounds : undefined;
        upsertRole(state, "builder", { outcome: "running", ...(rounds !== undefined ? { rounds } : {}) });
        break;
      }
      case "worker.role.completed": {
        const role = String(p.role ?? "?");
        const cost = typeof p.costUsd === "number" ? p.costUsd : undefined;
        upsertRole(state, role, { outcome: String(p.outcome ?? "?"), ...(cost !== undefined ? { cost } : {}) });
        if (cost !== undefined) state.totalCost += cost;
        break;
      }
      case "worker.verification": {
        state.verificationResult = p.verdict === "pass" || p.testsPassed === true ? "pass" : "fail";
        break;
      }
      default:
        break; // other worker.* events carry no registry-state delta
    }
  }

  /** The default (or injected) build run, then finalize the task from the result. */
  private async runBuild(state: TaskState, sub: BuildSubmission): Promise<void> {
    try {
      const ctx = this.beginOperation(state.taskId);
      const task: WorkerTask = {
        taskId: state.taskId,
        targetRepo: sub.repo,
        goal: sub.goal,
        ...(sub.builderMode !== undefined ? { builderMode: sub.builderMode } : {}),
      };
      const run = this.deps.runBuild ?? ((t, c, cancelled) => this.liveRunBuild(t, c, cancelled));
      const result = await run(task, ctx, () => this.isCancelled(state.taskId));
      this.finalizeBuild(state, result);
    } catch (e) {
      this.finalizeError(state, errMsg(e));
    } finally {
      // The run has actually stopped — release its concurrency slot now (NOT at cancel time, H2).
      this.live.delete(state.taskId);
      this.cancelled.delete(state.taskId);
    }
  }

  /** The default (or injected) fix run, then finalize the task from the outcome. */
  private async runFix(state: TaskState, sub: FixSubmission): Promise<void> {
    try {
      const ctx = this.beginOperation(state.taskId);
      const run = this.deps.runFix ?? ((req, c, cancelled) => this.liveRunFix(req, c, cancelled));
      const outcome = await run(sub, ctx, () => this.isCancelled(state.taskId));
      this.finalizeFix(state, outcome);
    } catch (e) {
      this.finalizeError(state, errMsg(e));
    } finally {
      this.live.delete(state.taskId);
      this.cancelled.delete(state.taskId);
    }
  }

  /** Resolve the operator identity and begin the operation context for this task. */
  private beginOperation(taskId: string): OperationContext {
    const resolveIdentity = this.deps.resolveIdentity ?? coreResolveIdentity;
    const operatorToken = "operatorToken" in this.deps ? this.deps.operatorToken : config.identity.operatorToken;
    if (operatorToken === undefined || operatorToken.length === 0) {
      throw new Error("no operator identity — set IKBI_OPERATOR_TOKEN");
    }
    const who = resolveIdentity({ token: operatorToken });
    return beginOperation(who, { requestId: taskId });
  }

  /** Live build: the governed production worker with a per-run cooperative kill-check. */
  private async liveRunBuild(task: WorkerTask, ctx: OperationContext, isCancelled: () => boolean): Promise<WorkerResult> {
    const { createProductionWorker } = await import("../modules/worker-model/cli.js");
    const workerToken = "workerToken" in this.deps ? this.deps.workerToken : config.identity.workerToken;
    const worker = createProductionWorker({
      workerToken,
      killCheck: async (target) => ({ killed: isCancelled() && (target.runId === task.taskId || target.requestId === task.taskId) }),
    });
    return worker.run(task, ctx);
  }

  /**
   * Live fix: the governed fix pipeline, check routed through governed-exec under the ctx.
   * `isCancelled` is the cooperative kill-check (H1): the pipeline polls it at its check
   * boundaries and stops early when an operator has cancelled the task.
   */
  private async liveRunFix(req: FixSubmission, ctx: OperationContext, isCancelled: () => boolean): Promise<FixOutcome> {
    const { runFixPipeline } = await import("../modules/worker-model/fix.js");
    const { resolveCheckTimeoutMs } = await import("../modules/worker-model/checks.js");
    const { governedExec } = await import("../modules/governed-exec/index.js");
    const timeoutMs = resolveCheckTimeoutMs();
    const runCheck = async (repoPath: string, check: FixCheckCommand) => {
      const res = await governedExec.run({ parentCtx: ctx, command: check.command, args: [...check.args], cwd: repoPath, purpose: `fix check: ${check.command} ${check.args.join(" ")}`.trim(), timeoutMs });
      const output = `${res.stdoutTail ?? ""}${res.stderrTail ?? ""}`;
      if (res.denied === true) return { exitCode: 126, output: `GOVERNED-EXEC DENIED: ${res.reason ?? "command refused"}\n${output}` };
      if (!res.executed) return { exitCode: 1, output: `check did not execute: ${res.reason ?? "unknown"}\n${output}` };
      return { exitCode: res.exitCode ?? 0, output };
    };
    const check = splitCheck(req.check);
    return runFixPipeline(
      { repo: req.repo, ...(check !== undefined ? { check } : {}), allowTestEdits: req.allowTestEdits === true, ...(req.goal !== undefined ? { goal: req.goal } : {}) },
      { runCheck, isCancelled },
    );
  }

  /**
   * If the task was cancelled mid-flight, write its terminal `cancelled` state (the run has
   * now drained) and report it handled, so a late run result never overwrites a cancellation.
   * The `task.cancelled` SSE-terminal event was already emitted by {@link cancel}.
   */
  private settleCancelled(state: TaskState): boolean {
    if (state.status !== "cancelling") return false;
    state.status = "cancelled";
    state.finishedAt = new Date(this.now()).toISOString();
    if (state.reason === undefined) state.reason = "cancelled by operator";
    return true;
  }

  /** Publish a terminal task.* event so any open SSE stream closes (H4). Best-effort. */
  private emitTerminal(type: "task.completed" | "task.cancelled" | "task.error", taskId: string, status: TaskStatus, totalCost: number): void {
    try {
      this.events.publish({ type, payload: { taskId, status, totalCost }, source: "http-task-service" });
    } catch {
      /* a bus publish failure must never break finalization */
    }
  }

  /** Write the terminal state for a completed build run (no-op if already cancelled). */
  private finalizeBuild(state: TaskState, result: WorkerResult): void {
    if (this.settleCancelled(state)) return; // cancelled mid-flight — settle to the cancelled terminal
    if (state.status !== "running") return;
    state.status = result.outcome === "success" ? "success" : "failure";
    state.finishedAt = new Date(this.now()).toISOString();
    state.totalCost = result.costUsd ?? state.totalCost;
    state.roles = result.roles.map((r): TaskRoleState => {
      const detail = (r.detail ?? {}) as Record<string, unknown>;
      const cost = typeof detail.costUsd === "number" ? detail.costUsd : undefined;
      return { role: r.role, outcome: r.outcome, ...(cost !== undefined ? { cost } : {}) };
    });
    const builder = result.roles.find((r) => r.role === "builder");
    const written = builder !== undefined && Array.isArray((builder.detail as Record<string, unknown> | undefined)?.filesWritten)
      ? ((builder.detail as Record<string, unknown>).filesWritten as unknown[]).map(String)
      : [];
    if (written.length > 0) state.filesChanged = written;
    const verifier = result.roles.find((r) => r.role === "verifier");
    if (verifier !== undefined) state.verificationResult = verifier.outcome === "success" ? "pass" : "fail";
    if (result.outcome !== "success" && result.reason !== undefined) state.reason = result.reason;
    this.emitTerminal("task.completed", state.taskId, state.status, state.totalCost);
  }

  /** Write the terminal state for a completed fix run (no-op if already cancelled). */
  private finalizeFix(state: TaskState, outcome: FixOutcome): void {
    if (this.settleCancelled(state)) return;
    if (state.status !== "running") return;
    const ok = outcome.result === "FIXED_NARROWLY" || outcome.result === "CORRECT_REFUSAL";
    state.status = ok ? "success" : "failure";
    state.finishedAt = new Date(this.now()).toISOString();
    state.roles = [{ role: "fix", outcome: outcome.result }];
    state.filesChanged = [...outcome.filesModified];
    state.verificationResult = outcome.receipt.fullCheck.passed ? "pass" : "fail";
    if (!ok) state.reason = outcome.result;
    this.emitTerminal("task.completed", state.taskId, state.status, state.totalCost);
  }

  /** Write a failure terminal state from a thrown error (no-op if already cancelled). */
  private finalizeError(state: TaskState, reason: string): void {
    if (this.settleCancelled(state)) return;
    if (state.status !== "running") return;
    state.status = "failure";
    state.finishedAt = new Date(this.now()).toISOString();
    state.reason = reason;
    this.emitTerminal("task.error", state.taskId, state.status, state.totalCost);
  }
}

/** Insert or update a role entry in place (preserving dispatch order). */
function upsertRole(state: TaskState, role: string, patch: Partial<TaskRoleState>): void {
  const idx = state.roles.findIndex((r) => r.role === role);
  if (idx === -1) state.roles.push({ role, outcome: "running", ...patch });
  else state.roles[idx] = { ...state.roles[idx]!, ...patch };
}

/** The process-wide task service (live singleton). */
export const taskService = new TaskService();

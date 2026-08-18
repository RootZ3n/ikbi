/**
 * ikbi v2 — THE CANONICAL RUN FUNCTION. The production spine.
 *
 * Every v2 surface (CLI today; server, REPL, delegation later) enters HERE. There is
 * one of these, and adding a second would be an obvious, reviewable act rather than
 * the quiet accretion that gave v1 several de facto build paths.
 *
 * WHAT THIS SLICE ACTUALLY DOES — and what it truthfully refuses to claim:
 *
 *   1. mint a task identity and a run identity
 *   2. open the canonical lifecycle
 *   3. enter `preflight` and validate the request (goal, strategy, repository) —
 *      READ-ONLY: it stats paths, nothing more
 *   4. STOP, because `context` (the next stage) has no implementation in this build
 *   5. terminalize as `failed` with category `not_implemented`, and emit a receipt
 *      whose evidence block is counted from a ledger nothing wrote to: zero
 *      invocations, zero candidates, zero verifications, not promoted, repository
 *      not mutated
 *
 * It performs NO model call, NO workspace allocation, NO mutation, NO promotion. The
 * receipt says exactly that, because the receipt has no way to say anything else.
 */

import { statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import {
  defaultStrategyPlan,
  isCandidateStrategyKind,
  type CandidateStrategyPlan,
  type V2Task,
  type V2TaskRequest,
} from "./contract.js";
import { V2_001_FAILURE_CODES, runFailure, stageNotImplemented, type RunFailure } from "./failure.js";
import { createIdFactory, type V2IdFactory } from "./identity.js";
import { RunLifecycle, type LifecycleStage } from "./lifecycle.js";
import { summarizeEvidence, type V2RunReceipt, type V2RunResult, type RunTerminalOutcome } from "./result.js";

/** The furthest stage this build of ikbi implements. Slice 001 implements preflight only. */
export const IMPLEMENTED_THROUGH_STAGE: LifecycleStage = "preflight";

/** The stage the run would need next, and does not have. */
export const FIRST_UNIMPLEMENTED_STAGE: LifecycleStage = "context";

/** Upper bound on a goal, so an accidental file paste is rejected as input, not as a build. */
export const MAX_GOAL_LENGTH = 8000;

/** Read-only repository inspection — a seam so preflight is testable without a real repo. */
export interface RepoProbe {
  inspect(repoPath: string): { readonly exists: boolean; readonly isDirectory: boolean; readonly hasGitDir: boolean };
}

/** The default probe: `statSync` only. It never opens, writes, or executes anything. */
export const nodeRepoProbe: RepoProbe = {
  inspect(repoPath: string) {
    let isDirectory = false;
    try {
      isDirectory = statSync(repoPath).isDirectory();
    } catch {
      return { exists: false, isDirectory: false, hasGitDir: false };
    }
    let hasGitDir = false;
    try {
      // A worktree's `.git` is a FILE, not a directory — both count as a git repo.
      statSync(join(repoPath, ".git"));
      hasGitDir = true;
    } catch {
      hasGitDir = false;
    }
    return { exists: true, isDirectory, hasGitDir };
  },
};

/** Injectable collaborators. Production passes none; tests pin the clock and the ids. */
export interface V2RunDeps {
  readonly ids?: V2IdFactory;
  readonly now?: () => number;
  readonly probe?: RepoProbe;
}

/** Validation outcome of preflight: the normalized task, or the structured reason it cannot start. */
type PreflightResult = { readonly ok: true; readonly task: V2Task } | { readonly ok: false; readonly failure: RunFailure };

/**
 * Validate and normalize the request. Read-only and fail-closed: anything it cannot
 * positively confirm becomes a structured failure, never a default.
 */
export function preflight(request: V2TaskRequest, probe: RepoProbe): PreflightResult {
  const goal = request.goal.trim();
  if (goal.length === 0) {
    return {
      ok: false,
      failure: runFailure({
        category: "task",
        code: V2_001_FAILURE_CODES.goalEmpty,
        message: "the goal is empty — a run needs something to do",
        stage: "preflight",
      }),
    };
  }
  if (goal.length > MAX_GOAL_LENGTH) {
    return {
      ok: false,
      failure: runFailure({
        category: "task",
        code: V2_001_FAILURE_CODES.goalTooLong,
        message: `the goal is ${goal.length} characters — the limit is ${MAX_GOAL_LENGTH}`,
        stage: "preflight",
        detail: { length: goal.length, limit: MAX_GOAL_LENGTH },
      }),
    };
  }

  const strategyRaw = request.candidateStrategy ?? "single";
  if (!isCandidateStrategyKind(strategyRaw)) {
    return {
      ok: false,
      failure: runFailure({
        category: "task",
        code: V2_001_FAILURE_CODES.strategyUnknown,
        message: `unknown candidate strategy "${strategyRaw}" (expected single, shadow, or tournament)`,
        stage: "preflight",
        detail: { requested: strategyRaw },
      }),
    };
  }

  const repoPath = isAbsolute(request.repoPath) ? request.repoPath : resolve(request.repoPath);
  const seen = probe.inspect(repoPath);
  if (!seen.exists) {
    return {
      ok: false,
      failure: runFailure({
        category: "preflight",
        code: V2_001_FAILURE_CODES.repoMissing,
        message: `no such path: ${repoPath}`,
        stage: "preflight",
        detail: { repoPath },
      }),
    };
  }
  if (!seen.isDirectory) {
    return {
      ok: false,
      failure: runFailure({
        category: "preflight",
        code: V2_001_FAILURE_CODES.repoNotDirectory,
        message: `not a directory: ${repoPath}`,
        stage: "preflight",
        detail: { repoPath },
      }),
    };
  }
  if (!seen.hasGitDir) {
    return {
      ok: false,
      failure: runFailure({
        category: "preflight",
        code: V2_001_FAILURE_CODES.repoNotGit,
        message: `not a git repository (no .git): ${repoPath}`,
        stage: "preflight",
        detail: { repoPath },
      }),
    };
  }

  return { ok: true, task: { goal, repoPath, candidateStrategy: strategyRaw } };
}

/** The candidate strategy plan a run resolved. Declared here, executed by no one yet. */
export function planFor(task: V2Task): CandidateStrategyPlan {
  return defaultStrategyPlan(task.candidateStrategy);
}

/**
 * THE canonical v2 build run. One task in, one authoritative result out.
 *
 * The shape of this function is the shape of the whole engine: mint identity, open
 * the lifecycle, walk stages the build actually implements, and terminalize exactly
 * once through the same machine no matter which branch was taken. Later slices add
 * stages between step 3 and terminalization — they do not add exits.
 */
export async function runV2Build(request: V2TaskRequest, deps: V2RunDeps = {}): Promise<V2RunResult> {
  const ids = deps.ids ?? createIdFactory();
  const now = deps.now ?? Date.now;
  const probe = deps.probe ?? nodeRepoProbe;

  const taskId = ids.mint("task");
  const runId = ids.mint("run");
  const startedAt = now();
  const lifecycle = new RunLifecycle({ runId, now });

  // Stage 1 — PREFLIGHT. Everything, including a rejected request, goes through the
  // lifecycle: there is no path that ends a run outside the machine.
  lifecycle.enter(runId, "preflight");
  const checked = preflight(request, probe);

  const outcome: RunTerminalOutcome = checked.ok
    ? // Preflight passed. The next stage does not exist in this build, so the run stops
      // here and says so. It does not enter `context` — a stage is only ever recorded as
      // entered when it actually ran.
      { kind: "failed", failure: stageNotImplemented(FIRST_UNIMPLEMENTED_STAGE, IMPLEMENTED_THROUGH_STAGE) }
    : { kind: "failed", failure: checked.failure };
  lifecycle.terminalize(runId, outcome);

  const endedAt = now();
  const receipt: V2RunReceipt = {
    receiptId: ids.mint("receipt"),
    taskId,
    runId,
    outcome,
    stagesEntered: lifecycle.stagesEntered,
    evidence: summarizeEvidence(lifecycle.ledger, outcome),
    startedAt,
    endedAt,
  };

  return {
    taskId,
    runId,
    goal: checked.ok ? checked.task.goal : request.goal,
    repoPath: checked.ok ? checked.task.repoPath : request.repoPath,
    outcome,
    journal: lifecycle.journal,
    receipt,
  };
}

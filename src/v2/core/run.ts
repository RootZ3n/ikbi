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
 *   4. resolve CONFIGURATION TRUTH inside preflight: what this machine can invoke
 *      (provider inventory), what strategy the operator selected (active profile),
 *      and whether the two are coherent — producing ONE immutable
 *      `RuntimeModelPolicy`, recorded on the lifecycle ledger
 *   5. enter `model_resolution` and ask THE resolver which exact model/provider route is
 *      AUTHORIZED for the builder role, recording the decision on the ledger
 *   6. STOP, because `context` (the next stage) has no implementation in this build
 *   7. terminalize as `failed` with category `not_implemented`, and emit a receipt
 *      whose evidence block is counted from the ledger: zero invocations, zero
 *      candidates, zero verifications, not promoted, repository not mutated
 *
 * It performs NO model call, NO workspace allocation, NO mutation, NO promotion.
 * Configuration and resolution are read-only decisions — reading a roster file, reading
 * a profile file, and CHOOSING a route are not invoking anything. An authorization is
 * not a call: the receipt reports `modelResolutionCompleted: true` beside
 * `providerInvoked: false`, and no `V2InvocationId` is minted, because no invocation
 * happened.
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
import { buildRuntimeModelPolicy, type ConfigurationSource, type RuntimeModelPolicy } from "./config.js";
import {
  resolveModelRoute,
  type ModelRequirements,
  type ModelResolutionDecision,
} from "./resolver.js";
import { V2_001_FAILURE_CODES, runFailure, stageNotImplemented, type RunFailure } from "./failure.js";
import { createIdFactory, type V2IdFactory } from "./identity.js";
import { RunLifecycle, type LifecycleStage } from "./lifecycle.js";
import {
  summarizeConfiguration,
  summarizeEvidence,
  summarizeResolution,
  type V2RunReceipt,
  type V2RunResult,
  type RunTerminalOutcome,
} from "./result.js";

/**
 * The ONE role this skeleton actually resolves end to end.
 *
 * `builder` on purpose: it is the role whose served identity matters most once real
 * invocation exists, so it is the one worth proving through the production entrypoint.
 * The resolver itself supports the whole role vocabulary — demonstrating every role in a
 * single run would be theatre, not evidence.
 */
export const DEMONSTRATED_ROLE = "builder" as const;

/**
 * Requirements the skeleton states for that role: none.
 *
 * A requirement here would have to be a real architectural claim about what a builder
 * needs, and this slice has no builder to make that claim on behalf of. Stating none is
 * the truthful position; the resolver's requirement handling is covered by its own tests.
 */
export const DEMONSTRATED_REQUIREMENTS: ModelRequirements | undefined = undefined;

/** The furthest stage this build of ikbi implements. */
export const IMPLEMENTED_THROUGH_STAGE: LifecycleStage = "model_resolution";

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

/**
 * Injectable collaborators.
 *
 * `configuration` is REQUIRED and has no default. That is deliberate: a default would
 * have to live in `src/v2/core/`, which imports no v1 code, so the only way to give it
 * one would be to smuggle v1 into the pure layer. Instead the production source is
 * wired in exactly one place — `src/v2/runtime/index.ts` — and every surface enters
 * through `runV2BuildProduction`. Tests pass a fake and get a hermetic run.
 */
export interface V2RunDeps {
  readonly configuration: ConfigurationSource;
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
export async function runV2Build(request: V2TaskRequest, deps: V2RunDeps): Promise<V2RunResult> {
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

  let task: V2Task | undefined;
  let policy: RuntimeModelPolicy | undefined;
  let decision: ModelResolutionDecision | undefined;

  const failure = await (async (): Promise<RunFailure> => {
    const checked = preflight(request, probe);
    if (!checked.ok) return checked.failure;
    task = checked.task;

    // CONFIGURATION TRUTH. Read-only: the source observes a provider roster and a
    // profile file. A structurally incoherent selection fails HERE, rather than
    // surfacing as a confusing model error three stages later.
    const built = buildRuntimeModelPolicy(
      await deps.configuration.load(request.profile !== undefined ? { profileOverride: request.profile } : {}),
    );
    if (!built.ok) return built.failure;
    policy = built.policy;
    lifecycle.record(runId, { kind: "configuration", policyId: policy.policyId });

    // Stage 2 — MODEL RESOLUTION. One authority, one request, one authorized route.
    // The request names the policy it expects, so a decision cannot be computed against
    // configuration other than the one this run just recorded.
    lifecycle.enter(runId, "model_resolution");
    const resolved = resolveModelRoute(policy, {
      runId,
      policyId: policy.policyId,
      role: DEMONSTRATED_ROLE,
      ...(DEMONSTRATED_REQUIREMENTS !== undefined ? { requirements: DEMONSTRATED_REQUIREMENTS } : {}),
    });
    if (!resolved.ok) return resolved.failure;
    decision = resolved.decision;
    lifecycle.record(runId, { kind: "resolution", decisionId: decision.decisionId, role: decision.role });

    // Resolution is complete and the next stage does not exist in this build, so the
    // run stops here and says so. It does not enter `context` — a stage is only ever
    // recorded as entered when it actually ran.
    return stageNotImplemented(FIRST_UNIMPLEMENTED_STAGE, IMPLEMENTED_THROUGH_STAGE);
  })();

  const outcome: RunTerminalOutcome = { kind: "failed", failure };
  lifecycle.terminalize(runId, outcome);

  const endedAt = now();
  const receipt: V2RunReceipt = {
    receiptId: ids.mint("receipt"),
    taskId,
    runId,
    outcome,
    stagesEntered: lifecycle.stagesEntered,
    evidence: summarizeEvidence(lifecycle.ledger, outcome),
    ...(policy !== undefined ? { configuration: summarizeConfiguration(policy) } : {}),
    ...(decision !== undefined ? { resolution: summarizeResolution(decision) } : {}),
    startedAt,
    endedAt,
  };

  return {
    taskId,
    runId,
    goal: task?.goal ?? request.goal,
    repoPath: task?.repoPath ?? request.repoPath,
    outcome,
    ...(policy !== undefined ? { policy } : {}),
    ...(decision !== undefined ? { decision } : {}),
    journal: lifecycle.journal,
    receipt,
  };
}

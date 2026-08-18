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
 *   6. enter `context` and ask THE assembler for the one bounded, content-addressed
 *      context package that route's capabilities permit — deterministic retrieval runs
 *      here as an ordinary source, DISCOVERING relevant files while the assembler alone
 *      decides what is admitted — recording both on the ledger
 *   7. enter `invocation` and ask THE invocation authority to call EXACTLY that route,
 *      once, recording what was authorized, what was sent, and what the provider says
 *      actually served it
 *   8. enter `candidate_strategy`: choose the SINGLE strategy, allocate ONE isolated
 *      workspace bound to the exact source commit and tree, and RE-OBSERVE the context
 *      artifact it would edit through the state-bound authority — proving the bytes the
 *      model saw are the bytes that are actually there
 *   9. discard the workspace (nothing was produced) and STOP, because
 *      `candidate_generation` has no implementation
 *  10. terminalize as `failed` with category `not_implemented`, and emit a receipt
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
import { assembleContext, manifestOf, type ContextPackage, type ContextSource } from "./context.js";
import { candidateDigest, summarizeCandidate, type CandidateRecord, type TreeCaptureResult } from "./candidate.js";
import { generateCandidate, type BuilderBudget, type BuilderToolExecutor, type BuilderToolExecutorDeps, type UntrustedBoundary } from "./builder.js";
import { summarizeRetrieval, type RetrievalReporter, type RetrievalSummary } from "./retrieval.js";
import { summarizeSnapshot, type SourceSnapshotAuthority, type SourceSnapshotReader } from "./source.js";
import {
  V2_WORKSPACE_FAILURE_CODES,
  workspaceFailure,
  type StateBoundMutationAuthority,
  type V2WorkspaceRecord,
  type WorkspaceAuthority,
  type WorkspaceDisposition,
} from "./workspace.js";
import {
  type InvocationTransport,
  type ServedModelAlias,
  type V2InvocationRecord,
} from "./invocation.js";
import { V2_001_FAILURE_CODES, runFailure, stageNotImplemented, type RunFailure } from "./failure.js";
import { createIdFactory, type V2IdFactory } from "./identity.js";
import { RunLifecycle, type LifecycleStage } from "./lifecycle.js";
import {
  summarizeConfiguration,
  summarizeContext,
  summarizeEvidence,
  summarizeInvocation,
  summarizeResolution,
  summarizeWorkspace,
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

/**
 * The context artifact whose workspace copy is re-observed before generation starts.
 *
 * A real, already-authorized artifact — never a probe file invented to have something to
 * look at. A goal-named target file is preferred (it is what a builder would edit first);
 * a repository instruction file is the fallback; and a package with neither yields no
 * observation at all, which the receipt then truthfully counts as zero.
 */
export function rebindableArtifact(pkg: ContextPackage): { path: string; observedSha256: string } | undefined {
  const chosen =
    pkg.artifacts.find((a) => a.category === "target_file" && a.path !== undefined) ??
    pkg.artifacts.find((a) => a.category === "repository_instructions" && a.path !== undefined);
  if (chosen?.path === undefined) return undefined;
  return { path: chosen.path, observedSha256: chosen.observedSha256 };
}

/** The furthest stage this build of ikbi implements. */
export const IMPLEMENTED_THROUGH_STAGE: LifecycleStage = "candidate_generation";

/** The stage the run would need next, and does not have. */
export const FIRST_UNIMPLEMENTED_STAGE: LifecycleStage = "verification";

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
  /**
   * The context contributors, in consultation order. REQUIRED, for the same reason
   * `configuration` is: a default would have to live in this pure layer, and these read
   * the filesystem. The production list is wired once, in `src/v2/runtime/index.ts`.
   */
  readonly contextSources: readonly ContextSource[];
  /**
   * Where the run asks what deterministic retrieval actually did, once context is
   * assembled. Optional: a run wired with no retrieval source truthfully reports none
   * rather than an empty one, and the distinction stays visible in the receipt.
   */
  readonly retrieval?: RetrievalReporter;
  /**
   * The model transport. REQUIRED and injected for the same reason the other two are:
   * it performs I/O, and this layer imports no v1 code. Tests supply a fake and stay
   * hermetic; the production adapter is wired once, in `src/v2/runtime/index.ts`.
   */
  readonly transport: InvocationTransport;
  /** Declared served-model alias relations. Defaults to the (empty) production table. */
  readonly aliases?: readonly ServedModelAlias[];
  /**
   * The workspace and state-bound mutation authorities. REQUIRED and injected, like the
   * others: they perform I/O, and this layer imports no v1 code.
   */
  readonly workspaces: WorkspaceAuthority;
  readonly mutations: StateBoundMutationAuthority;
  /**
   * THE source snapshot authority. Captured once, in preflight, and every downstream
   * component reads that answer instead of asking the filesystem again.
   */
  readonly sources: SourceSnapshotAuthority;
  /**
   * Builds the tool executor for one workspace. REQUIRED and injected for the same reason
   * the rest are: it holds the mutation authority and performs I/O, and this pure layer
   * imports no v1 code and no filesystem API.
   */
  readonly buildTools: (deps: BuilderToolExecutorDeps) => BuilderToolExecutor;
  /**
   * Addresses the exact resulting state of a candidate workspace. Injected because it
   * shells out to git; wired once, in `src/v2/runtime/index.ts`.
   */
  readonly captureTree: (workspace: V2WorkspaceRecord) => Promise<TreeCaptureResult>;
  /**
   * THE untrusted-data boundary every tool result crosses on its way back to the model.
   * REQUIRED and injected: it is v1's neutralization fence, which is I/O-adjacent and
   * cannot live in this pure layer. Wired once, in `src/v2/runtime/index.ts`.
   */
  readonly untrustedBoundary: UntrustedBoundary;
  /** Bounds on the builder loop. Defaults to `DEFAULT_BUILDER_BUDGET`. */
  readonly builderBudget?: BuilderBudget;
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

  let resolvedTask: V2Task | undefined;
  let policy: RuntimeModelPolicy | undefined;
  let source: SourceSnapshotReader | undefined;
  let decision: ModelResolutionDecision | undefined;
  let retrieval: RetrievalSummary | undefined;
  let contextPackage: ContextPackage | undefined;
  let invocations: readonly V2InvocationRecord[] = [];
  let candidate: CandidateRecord | undefined;
  let workspace: V2WorkspaceRecord | undefined;
  let workspaceObservations = 0;
  let disposition: WorkspaceDisposition | undefined;

  const failure = await (async (): Promise<RunFailure> => {
    const checked = preflight(request, probe);
    if (!checked.ok) return checked.failure;
    const task = checked.task;
    resolvedTask = task;

    // CONFIGURATION TRUTH. Read-only: the source observes a provider roster and a
    // profile file. A structurally incoherent selection fails HERE, rather than
    // surfacing as a confusing model error three stages later.
    const built = buildRuntimeModelPolicy(
      await deps.configuration.load(request.profile !== undefined ? { profileOverride: request.profile } : {}),
    );
    if (!built.ok) return built.failure;
    policy = built.policy;
    lifecycle.record(runId, { kind: "configuration", policyId: policy.policyId });

    // THE SOURCE SNAPSHOT. Captured here, once, and never recaptured: everything after
    // this point reads the state the operator had when the run began — including their
    // uncommitted work — rather than whatever the working tree happens to hold later.
    const captured = await deps.sources.capture({ repoPath: task.repoPath });
    if (!captured.ok) return captured.failure;
    source = captured.reader;
    lifecycle.record(runId, { kind: "snapshot", id: source.snapshot.snapshotId, clean: source.snapshot.clean });

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

    // Stage 3 — CONTEXT. One authority assembles one bounded package, sized by the
    // capabilities of the route just authorized. Sources contribute; only the assembler
    // admits.
    lifecycle.enter(runId, "context");
    const assembled = await assembleContext(
      {
        runId,
        taskId,
        goal: task.goal,
        source,
        resolutionDecisionId: decision.decisionId,
        capabilities: decision.capabilities,
      },
      deps.contextSources,
    );
    if (!assembled.ok) return assembled.failure;
    contextPackage = assembled.package;
    // Retrieval evidence is recorded BEFORE the package: what was searched for is a fact
    // about how this package came to exist, and the ledger reads in causal order.
    const retrieved = deps.retrieval?.lastResult();
    if (retrieved !== undefined) {
      retrieval = summarizeRetrieval(
        retrieved,
        contextPackage.artifacts.filter((a) => a.category === "retrieved_repository_evidence").length,
      );
      lifecycle.record(runId, {
        kind: "retrieval",
        id: retrieved.retrievalId,
        offered: retrieved.candidates.length,
        examined: retrieved.examinedCount,
      });
    }
    lifecycle.record(runId, { kind: "context", packageId: contextPackage.packageId, artifacts: contextPackage.artifacts.length });

    // Stage 4 — CANDIDATE STRATEGY. "Where and how is a candidate produced?" For the
    // SINGLE strategy that is one isolated workspace. A workspace is not a candidate:
    // allocating one produces nothing.
    lifecycle.enter(runId, "candidate_strategy");
    // The workspace materializes THE SAME snapshot context was assembled from, so the
    // builder starts from exactly the state it was shown.
    const allocated = await deps.workspaces.allocate({ runId, source: source.snapshot, label: `v2-${DEMONSTRATED_ROLE}` });
    if (!allocated.ok) return allocated.failure;
    workspace = allocated.workspace;
    lifecycle.record(runId, { kind: "workspace", id: workspace.workspaceId, baseTree: workspace.source.baseTree });

    // RE-OBSERVE. The context package was assembled from the TARGET REPOSITORY before any
    // workspace existed; the workspace is a worktree at the base commit. Those are not
    // guaranteed to agree — an uncommitted change in the source repo is exactly the case
    // where they do not. So the bytes the model saw are checked against the bytes that
    // are actually here, through the same authority every edit must use.
    const anchor = rebindableArtifact(contextPackage);
    if (anchor !== undefined) {
      const observed = await deps.mutations.observe({ runId, workspace, path: anchor.path });
      if (!observed.ok) return observed.failure;
      workspaceObservations += 1;
      lifecycle.record(runId, {
        kind: "observation",
        id: observed.observation.observationId,
        workspaceId: workspace.workspaceId,
        path: observed.observation.path,
      });
      if (observed.observation.state.contentSha256 !== anchor.observedSha256) {
        // Do NOT silently rebuild context. Re-contextualization is a recovery decision,
        // and pretending the model saw what is on disk would make every downstream
        // state-bound edit rest on a lie.
        return workspaceFailure({
          code: V2_WORKSPACE_FAILURE_CODES.contextDrift,
          message:
            `the workspace copy of ${anchor.path} does not match the bytes the context package recorded ` +
            `— the model was shown a state this workspace does not have`,
          detail: {
            path: anchor.path,
            workspaceId: workspace.workspaceId,
            contextSha256: anchor.observedSha256,
            workspaceSha256: observed.observation.state.contentSha256 ?? "none",
          },
        });
      }
    }

    // Stage 5 — CANDIDATE GENERATION. The builder loop. EVERY model turn goes through the
    // one invocation authority, EVERY file read produces an observation, and EVERY write
    // names the observation that authorized it. This function holds none of that
    // machinery itself — it wires the authorities together and records what they did.
    lifecycle.enter(runId, "candidate_generation");

    const executor = deps.buildTools({
      runId,
      workspace,
      mutations: deps.mutations,
      onObservation: (observation) => {
        workspaceObservations += 1;
        lifecycle.record(runId, {
          kind: "observation",
          id: observation.observationId,
          workspaceId: observation.workspaceId,
          path: observation.path,
        });
      },
      onMutation: (applied) => {
        lifecycle.record(runId, {
          kind: "mutation",
          id: applied.mutationId,
          workspaceId: workspace!.workspaceId,
          path: applied.path,
        });
      },
    });

    const generated = await generateCandidate({
      runId,
      taskId,
      decision,
      contextPackage,
      transport: deps.transport,
      executor,
      untrustedBoundary: deps.untrustedBoundary,
      mintInvocationId: () => ids.mint("invocation"),
      ...(deps.builderBudget !== undefined ? { budget: deps.builderBudget } : {}),
      ...(deps.aliases !== undefined ? { aliases: deps.aliases } : {}),
      now,
    });

    // Invocations are recorded whether generation succeeded or not: the provider really
    // was contacted, and a receipt that omitted the calls a failed build paid for would
    // be understating the run's cost.
    for (const record of generated.ok ? generated.generation.invocations : generated.invocations) {
      lifecycle.record(runId, { kind: "invocation", id: record.invocationId, role: decision.role });
    }
    // A turn that reached the wire and then failed has no record — but it happened, and
    // the receipt must not report the provider as never contacted.
    if (!generated.ok) {
      for (const id of generated.attemptedInvocationIds) lifecycle.record(runId, { kind: "invocation", id, role: decision.role });
    }
    invocations = generated.ok ? generated.generation.invocations : generated.invocations;
    if (!generated.ok) return generated.failure;

    // CAPTURE. The builder said it is done; now the exact resulting state is addressed,
    // so verification inspects a tree rather than a description of one.
    const capturedTree = await deps.captureTree(workspace);
    if (!capturedTree.ok) return capturedTree.failure;

    const generation = generated.generation;
    candidate = Object.freeze({
      candidateId: candidateDigest({ sourceSnapshotId: source.snapshot.snapshotId, tree: capturedTree.tree }),
      runId,
      sourceSnapshotId: source.snapshot.snapshotId,
      workspaceId: workspace.workspaceId,
      builderDecisionId: decision.decisionId,
      invocationIds: generation.invocationIds,
      mutationIds: generation.mutationIds,
      changedPaths: generation.changedPaths,
      tree: capturedTree.tree,
      completion: "finished",
      claim: generation.claim,
      metadata: {
        turns: generation.turns,
        toolCalls: generation.toolCalls,
        toolFailures: generation.toolFailures,
        startedAt: generation.startedAt,
        endedAt: generation.endedAt,
      },
    });
    lifecycle.record(runId, { kind: "candidate", id: candidate.candidateId, workspaceId: workspace.workspaceId });

    // A CANDIDATE NOW EXISTS. It has not been verified, judged or promoted — the stage
    // that would do that does not exist in this build, and the run says exactly that.
    return stageNotImplemented(FIRST_UNIMPLEMENTED_STAGE, IMPLEMENTED_THROUGH_STAGE);
  })();

  // OWNERSHIP TRANSITION. Until V2-007 a workspace was always discarded, because nothing
  // was ever produced in one. Now the question has a real answer:
  //
  //   a CANDIDATE exists  → the workspace becomes candidate-owned and is RETAINED. It is
  //                         the thing verification will inspect, and discarding it would
  //                         throw away the only copy of the work the run just paid for.
  //   no candidate        → DISCARDED. A generation that failed leaves a half-edited tree
  //                         nothing is entitled to read, and leaking it is a workspace leak.
  //
  // Retention is NOT promotion and NOT a claim of quality: the worktree simply stays on
  // disk, findable through the existing `ikbi workspace ls`.
  if (workspace !== undefined) {
    disposition =
      candidate !== undefined
        ? await deps.workspaces.retain(workspace, `candidate ${candidate.candidateId} awaits verification`)
        : await deps.workspaces.discard(workspace);
  }

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
    ...(source !== undefined ? { sourceSnapshot: summarizeSnapshot(source.snapshot) } : {}),
    ...(decision !== undefined ? { resolution: summarizeResolution(decision) } : {}),
    ...(contextPackage !== undefined ? { context: summarizeContext(contextPackage) } : {}),
    ...(retrieval !== undefined ? { retrieval } : {}),
    invocations: invocations.map(summarizeInvocation),
    ...(candidate !== undefined ? { candidate: summarizeCandidate(candidate) } : {}),
    ...(workspace !== undefined && disposition !== undefined
      ? { workspace: summarizeWorkspace({ workspace, observations: workspaceObservations, disposition }) }
      : {}),
    startedAt,
    endedAt,
  };

  return {
    taskId,
    runId,
    goal: resolvedTask?.goal ?? request.goal,
    repoPath: resolvedTask?.repoPath ?? request.repoPath,
    outcome,
    ...(policy !== undefined ? { policy } : {}),
    ...(decision !== undefined ? { decision } : {}),
    ...(contextPackage !== undefined ? { context: manifestOf(contextPackage) } : {}),
    invocations,
    ...(candidate !== undefined ? { candidate } : {}),
    journal: lifecycle.journal,
    receipt,
  };
}

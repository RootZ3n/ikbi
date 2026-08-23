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
 *   8. enter `candidate_strategy`: resolve the strategy (single=1, shadow=2, tournament=N,
 *      bounded) and allocate EACH candidate its OWN isolated workspace bound to the exact
 *      source commit and tree — sharing ONE RunId + ONE source snapshot but no sibling
 *      workspace, observations or mutations — and RE-OBSERVE the context artifact it would
 *      edit through the state-bound authority, proving the bytes the model saw are really there
 *   9. enter `candidate_generation` and run the governed builder loop, capturing the
 *      resulting tree as ONE content-addressed Candidate
 *  10. enter `verification` and ask THE verifier for a deterministic verdict bound to that
 *      exact candidate tree — recheck the tree, plan the checks, run them through
 *      governed-exec, recheck the tree, classify — with no model call
 *  11. enter `criticism` and ask a SEPARATELY resolved critic model to judge the SAME tree
 *      against the operator's intent and that verification evidence — semantic evidence,
 *      strictly parsed (a bare "fail" cannot become a verdict), deciding nothing
 *  12. enter `disposition` and ask THE adjudication authority for the ONE lawful decision:
 *      it weighs the deterministic verification AND the semantic critic against ONE explicit
 *      policy, re-probes the tree at this fresh authority boundary, and returns
 *      acceptable_for_promotion / withhold / reject / quarantine — invoking no model,
 *      mutating nothing, promoting nothing, repairing nothing
 *  13. SELECT: ask the ONE pure, deterministic selector to pick ≤1 promotion-eligible candidate
 *      from the immutable per-candidate evaluations (only `acceptable_for_promotion` enters the
 *      pool; correctness always outranks cost) — for `single` the one candidate is the trivial
 *      choice, so the single path is byte-for-byte unchanged
 *  14. enter `promotion` for the SELECTED candidate only (a losing/representative candidate never
 *      reaches it) and ask THE promotion authority to publish EXACTLY that candidate's tree by
 *      clean-ref CAS — no merge, no auto-resolve; reclaim the losing candidate workspaces (a
 *      quarantined loser is retained) while every candidate's EVIDENCE stays on the receipt
 *  15. terminalize with the promotion/disposition's lawful outcome and emit a receipt whose
 *      evidence block is counted from the ledger — candidate(s), verification, critic, disposition,
 *      selection and promotion are all real
 *
 * Only the SELECTED, eligible, clean candidate mutates the operator's repository, and only through
 * the promotion authority's compare-and-swap. Every builder's edits land in its OWN isolated
 * worktree; verification runs deterministic checks there and never touches the operator's checkout.
 * The disposition decides what SHOULD happen; the selector decides WHICH candidate; the promotion
 * authority is the only thing that acts on the repository.
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
  V2_SCOPE_FAILURE_CODES,
  type MutationScope,
  buildMutationScope,
  mutationScopeFailure,
  publicationScopeFailure,
  summarizeMutationScope,
  reviewChangedPaths,
  type MutationOperationKind,
} from "./mutation-scope.js";
import type { DiffChangeKind } from "./candidate-diff.js";
import { summarizeFormatter, type FormatterCapability, type FormatterRecord } from "./formatter.js";

/**
 * How a tree-level change maps onto the operation the scope authorizes.
 *
 * Stated as a table rather than inferred at the call site: "added" is a CREATE and "deleted"
 * is a DELETE, and collapsing the three into "the file changed" is precisely the loss of
 * distinction the scope exists to preserve.
 */
const DIFF_KIND_TO_OPERATION: Readonly<Record<DiffChangeKind, MutationOperationKind>> = Object.freeze({
  added: "create",
  modified: "modify",
  deleted: "delete",
});
import {
  resolveModelRoute,
  type ModelRequirements,
  type ModelResolutionDecision,
} from "./resolver.js";
import { assembleContext, manifestOf, type ContextPackage, type ContextSource } from "./context.js";
import { candidateDigest, summarizeCandidate, type CandidateRecord, type TreeCaptureResult } from "./candidate.js";
import {
  defaultStrategyPolicy,
  selectCandidate,
  type CandidateEvaluation,
  type SelectionRecord,
  type StrategyPolicy,
} from "./strategy.js";
import { buildInvocationCostRecord, pricingCatalogId, V2_SHIPPED_PRICING } from "./cost.js";
import {
  summarizeVerification,
  verificationSubjectOf,
  verifyCandidate,
  type ChecksSource,
  type CheckRunner,
  type TreeProbe,
  type VerificationDefinition,
  type VerificationDefinitionProbe,
  type VerificationRecord,
} from "./verification.js";
import type { AdvisoryContextBlock } from "./prompt.js";
import { generateCandidate, DEFAULT_BUILDER_BUDGET, type BuilderBudget, type BuilderToolExecutor, type BuilderToolExecutorDeps, type BuilderBoundSource, type BuilderTurnSource, type UntrustedBoundary } from "./builder.js";
import type { InvocationAdmission } from "./cost.js";
import type { BuilderCommandCapability, BuilderCommandRecord } from "./command.js";
import { judgeCandidate, summarizeCritic, type CriticRecord } from "./critic.js";
import {
  judgeDisposition,
  summarizeDisposition,
  DEFAULT_DISPOSITION_POLICY,
  type DispositionPolicy,
  type DispositionRecord,
} from "./disposition.js";
import {
  promoteAuthorized,
  summarizePromotion,
  type PromotionResult,
  type PromotionRecord,
  type PromotionTarget,
} from "./promotion.js";
import { DEFAULT_DIFF_BUDGET, type CandidateDiffSource } from "./candidate-diff.js";
import type { RepairBrief } from "./repair.js";
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
import { V2_001_FAILURE_CODES, runFailure, type RunFailure } from "./failure.js";
import { createIdFactory, type V2IdFactory, type V2RunId } from "./identity.js";
import { RunLifecycle, type LifecycleStage } from "./lifecycle.js";
import {
  summarizeConfiguration,
  summarizeContext,
  summarizeEvidence,
  summarizeInvocation,
  summarizeCommand,
  summarizeStrategy,
  summarizeBuilderBudget,
  summarizeContextEnvelope,
  summarizeEstimateCalibration,
  type RunContextEnvelopeSummary,
  summarizeSelection,
  type RunCandidateEvaluationSummary,
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

/** The furthest stage this build of ikbi implements — now the whole spine, through publication. */
export const IMPLEMENTED_THROUGH_STAGE: LifecycleStage = "promotion";

/**
 * Map the promotion RESULT onto the run's terminal outcome. ONLY an actually-landed
 * publication (including an idempotent already-landed and a degraded landing — the ref DID
 * move) becomes `accepted`; every refusal keeps the candidate withheld or quarantined and the
 * source unchanged. This function is never called for `refused_wrong_evidence` /
 * `infrastructure_failure` (those end the run as `failed`), but it handles them defensively.
 */
export function terminalOutcomeForPromotion(
  result: PromotionResult,
  candidateId: import("./identity.js").V2CandidateId,
  verificationId: import("./identity.js").V2VerificationId,
): RunTerminalOutcome {
  switch (result.kind) {
    case "promoted":
    case "already_promoted":
    case "promoted_degraded":
      // The repository changed. The receipt's promotion summary carries the degraded flag when
      // post-CAS bookkeeping did not fully complete; the outcome is still, truthfully, accepted.
      return { kind: "accepted", candidateId, verificationId, promotionId: result.record.promotionId };
    case "refused_dirty_source_unsupported":
      return { kind: "withheld", candidateId, verificationId, reason: "unsupported_publication" };
    case "refused_stale_target":
    case "cas_conflict":
      // The target moved — no auto-merge; recovery must re-verify against the new base.
      return { kind: "withheld", candidateId, verificationId, reason: "target_moved" };
    case "refused_target_worktree_dirty":
      return { kind: "withheld", candidateId, verificationId, reason: "operator" };
    case "refused_not_eligible":
      // Defensive: disposition already gated this. Withhold rather than imply anything landed.
      return { kind: "withheld", candidateId, verificationId, reason: "policy" };
    case "refused_candidate_drift":
      // The retained tree moved since adjudication — a stale subject. Quarantine for forensics.
      return { kind: "quarantined", reason: "safety_forensics", detail: result.detail };
    case "refused_wrong_evidence":
    case "infrastructure_failure":
      return { kind: "failed", failure: result.failure };
  }
}

/**
 * Map the ONE lawful disposition decision onto the run's terminal outcome vocabulary. This
 * is a pure projection — it enacts nothing.
 *
 *   acceptable_for_promotion → withheld (awaiting_promotion): ELIGIBLE, not promoted. The
 *                              promotion authority (V2-012) is the only thing that could make
 *                              this `accepted`, and it has not run. The source is unchanged.
 *   withhold                 → withheld, with the policy/operator reason preserved.
 *   reject                   → rejected (deterministic red is not verified-good work).
 *   quarantine               → quarantined, retained for a later recovery authority.
 */
export function terminalOutcomeForDisposition(
  record: DispositionRecord,
  candidateId: import("./identity.js").V2CandidateId,
  verificationId: import("./identity.js").V2VerificationId,
): RunTerminalOutcome {
  switch (record.decision) {
    case "acceptable_for_promotion":
      return { kind: "withheld", candidateId, verificationId, reason: "awaiting_promotion" };
    case "withhold":
      return {
        kind: "withheld",
        candidateId,
        verificationId,
        reason: record.primaryReason === "policy_requires_operator" ? "operator" : "policy",
      };
    case "reject":
      return { kind: "rejected", reason: "verification_red", candidateId };
    case "quarantine":
      // Timeout / infrastructure failure ⇒ incomplete evidence (recovery-needed). A drift or
      // check-mutated candidate ⇒ the tree itself is suspect ⇒ hold for forensics.
      return record.primaryReason === "verification_timeout" || record.primaryReason === "verification_infrastructure_failure"
        ? { kind: "quarantined", reason: "adjudication_incomplete", detail: `${record.primaryReason}` }
        : { kind: "quarantined", reason: "safety_forensics", detail: `${record.primaryReason}` };
  }
}

/** Upper bound on a goal, so an accidental file paste is rejected as input, not as a build. */
export const MAX_GOAL_LENGTH = 8000;

/**
 * The default per-check wall-clock bound (10 minutes), mirroring the donor's
 * `DEFAULT_CHECK_TIMEOUT_MS`. A test suite that takes longer is killed and classified as a
 * timeout, never as an ordinary failure. Overridable per run via `V2RunDeps.checkTimeoutMs`.
 */
export const DEFAULT_CHECK_TIMEOUT_MS = 600_000;

/**
 * Completion cap for the critic's judgment call.
 *
 * WAS 2,048, on the reasoning that "a JSON verdict is small". It is small when the
 * verdict is `satisfied` and the defect list is empty. It is not small when a critic has
 * things to say: the first complete builder → verifier → critic traversal on a real
 * repository came back with `finishReason: "length"` at exactly 2,047 tokens — cut off
 * mid-JSON by this constant, and then reported as the model's protocol violation.
 *
 * 8,192 is still tightly bounded and still far above a normal response; it is headroom
 * for a critic with several findings to describe, not licence to ramble. The session
 * invocation cap and cost ceiling remain the things that actually bound spend, and both
 * are independent of this.
 */
export const CRITIC_MAX_OUTPUT_TOKENS = 8_192;
/** Per-attempt timeout for the critic call. One attempt; no retry follows it. */
export const CRITIC_TIMEOUT_MS = 120_000;

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
   * OPTIONAL governed formatter, built PER CANDIDATE WORKSPACE.
   *
   * A factory rather than an instance because the capability holds a workspace, a mutation
   * authority and the run's scope — a shared instance would be a shared write authority across
   * candidates, which is exactly the isolation a tournament depends on.
   */
  readonly buildFormatter?: (input: {
    readonly runId: V2RunId;
    readonly workspace: V2WorkspaceRecord;
    readonly mutations: StateBoundMutationAuthority;
    readonly mutationScope: MutationScope;
    readonly treeProbe: TreeProbe;
  }) => FormatterCapability;
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
  /**
   * THE candidate diff source for the critic — model-caused change vs the source snapshot.
   * REQUIRED and injected: it shells out to git. Wired once, in `src/v2/runtime/index.ts`.
   */
  readonly candidateDiff: CandidateDiffSource;
  /** Bounds on the builder loop. Defaults to `DEFAULT_BUILDER_BUDGET`. */
  readonly builderBudget?: BuilderBudget;
  /**
   * Where the effective TURN count came from, for the receipt. The runtime resolves the
   * operator's `IKBI_V2_MAX_BUILDER_TURNS` once per session and says so here; anything
   * that injects a budget without saying is recorded as the shipped default.
   */
  readonly builderTurnSource?: BuilderTurnSource;
  /** Where the effective TOOL-CALL count came from, for the receipt. Same freeze path. */
  readonly builderToolCallSource?: BuilderBoundSource;
  /** Where the effective COMMAND count came from, for the receipt. Same freeze path. */
  readonly builderCommandSource?: BuilderBoundSource;
  /**
   * THE deterministic verification seams. REQUIRED and injected: check discovery reads the
   * filesystem, the runner shells out through governed-exec, and the tree probe runs git —
   * none of which belongs in this pure layer. Wired once, in `src/v2/runtime/index.ts`.
   */
  readonly checksSource: ChecksSource;
  readonly checkRunner: CheckRunner;
  readonly treeProbe: TreeProbe;
  /**
   * V2-016A/B4 — the verification-definition probe. Captured from the SOURCE snapshot before the
   * builder runs and re-captured from the candidate during verification, so a candidate that
   * rewrote its manifest-derived exam is caught (verification_policy_changed). Wired once in
   * `src/v2/runtime/index.ts`; absent ⇒ the guard is skipped.
   */
  readonly definitionProbe?: VerificationDefinitionProbe;
  /**
   * V2-017 — the frozen candidate strategy for this attempt. Defaults to the task's strategy kind
   * (single/shadow/tournament) at its default width. The strategy decides how many independent
   * candidates the attempt generates; it never verifies, adjudicates, promotes, or selects a model.
   */
  readonly strategyPolicy?: StrategyPolicy;
  /** Per-check wall-clock bound. Defaults to the donor's shared `resolveCheckTimeoutMs`. */
  readonly checkTimeoutMs?: number;
  /**
   * THE explicit disposition policy the adjudication authority applies. ONE normalized
   * policy, injected — the authority never reads env or repository prose. Defaults to the
   * SAFE `DEFAULT_DISPOSITION_POLICY` (deterministic pass AND satisfied critic required).
   */
  readonly dispositionPolicy?: DispositionPolicy;
  /**
   * THE publication target — the ONLY thing that moves a target ref. REQUIRED and injected:
   * it shells out to git and performs the atomic clean-ref CAS. Wired once, in
   * `src/v2/runtime/index.ts`; tests supply a fake and stay hermetic.
   */
  readonly publisher: PromotionTarget;
  /**
   * OPTIONAL advisory repair evidence (V2-013). Present only when the session controller is
   * making a semantic-repair attempt: bounded, neutralized historical evidence about a prior
   * FAILED attempt, handed to the builder as untrusted context — never authority.
   */
  readonly repairBrief?: RepairBrief;
  /** Local advisory context. Never merged into the goal — see `AdvisoryContextBlock`. */
  readonly advisoryContext?: readonly AdvisoryContextBlock[];
  /**
   * OPTIONAL session cost-budget guard (V2-014). Supplied by the BuildSession controller so a
   * pre-call admission runs before every builder and critic invocation, and every observed
   * usage is charged to the ONE session wallet. Absent for a bare single-attempt run — no
   * budget enforcement, no accounting side-effects on any existing test path.
   */
  readonly admission?: InvocationAdmission;
  /**
   * OPTIONAL read-only command terminal (V2-015). When wired, the builder's `run_command` runs one
   * bounded command with the candidate READ-ONLY and returns its output as untrusted evidence. It
   * mints no observation and holds no mutation authority. Absent ⇒ `run_command` is refused.
   */
  readonly commands?: BuilderCommandCapability;
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

  // THE MUTATION SCOPE, decided before anything else is touched.
  //
  // Deliberately ahead of the repository probe, and far ahead of provider resolution and
  // workspace allocation: a run with no authority to change anything must not reach a model,
  // must not allocate a worktree, and must not cost money. Fail-closed — an absent scope is a
  // refusal, never a fallback to the repository.
  const scopeResult = buildMutationScope(request.mutationScope);
  if (!scopeResult.ok) {
    return {
      ok: false,
      failure: mutationScopeFailure(
        scopeResult.code === "scope_absent" ? V2_SCOPE_FAILURE_CODES.scopeRequired : V2_SCOPE_FAILURE_CODES.scopeInvalid,
        scopeResult.detail,
        { code: scopeResult.code },
      ),
    };
  }
  const mutationScope = scopeResult.scope;

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

  return { ok: true, task: { goal, repoPath, candidateStrategy: strategyRaw, mutationScope } };
}

/** The candidate strategy plan a run resolved. Declared here, executed by no one yet. */
export function planFor(task: V2Task): CandidateStrategyPlan {
  return defaultStrategyPlan(task.candidateStrategy);
}

/**
/**
 * V2-017 — the outcome of ONE candidate's generation + canonical evaluation, inside one attempt.
 *
 * `status: "evaluated"` reached the disposition authority (carries a lawful disposition, and a
 * `stopOutcome` for a non-eligible/quarantined verdict). `status: "incomplete"` hit a build/critic/
 * engine failure or a budget denial before disposition (carries `failure`). Every candidate owns its
 * OWN workspace/observations/mutations/invocations/CandidateId; all share the attempt's snapshot.
 */
interface CandidateResult {
  readonly slot: number;
  readonly workspace?: V2WorkspaceRecord;
  readonly observations: number;
  readonly invocations: readonly V2InvocationRecord[];
  readonly commands: readonly BuilderCommandRecord[];
  readonly candidate?: CandidateRecord;
  readonly verification?: VerificationRecord;
  readonly critic?: CriticRecord;
  readonly disposition?: DispositionRecord;
  readonly status: "evaluated" | "incomplete";
  readonly eligible: boolean;
  /** For an EVALUATED non-eligible/quarantined candidate: its truthful terminal outcome. */
  readonly stopOutcome?: RunTerminalOutcome;
  /** For an INCOMPLETE candidate: the structured engine/build/critic/budget failure. */
  readonly failure?: RunFailure;
}

/** The pricing catalog used to compute a per-candidate cost TIE-BREAK signal (the SAME pure
 *  calculator the session cost authority uses — not a second ledger). */
const STRATEGY_TIEBREAK_CATALOG = V2_SHIPPED_PRICING;
const STRATEGY_TIEBREAK_CATALOG_ID = pricingCatalogId(STRATEGY_TIEBREAK_CATALOG);

/** One candidate's own known cost (a floor) + whether any of its calls is unpriced — for the selector. */
function candidateKnownCost(invocations: readonly V2InvocationRecord[]): { readonly known: number; readonly hasUnknown: boolean } {
  let known = 0;
  let hasUnknown = false;
  for (const inv of invocations) {
    const c = buildInvocationCostRecord({ record: inv, catalog: STRATEGY_TIEBREAK_CATALOG, catalogId: STRATEGY_TIEBREAK_CATALOG_ID });
    if (c.amountMicroUsd !== undefined) known += c.amountMicroUsd;
    if (c.hasUnknownCost) hasUnknown = true;
  }
  return { known, hasUnknown };
}

/** Project a candidate result into the immutable evaluation the pure selector reads. */
function candidateEvaluationOf(c: CandidateResult): CandidateEvaluation | undefined {
  if (c.candidate === undefined) {
    // A candidate that never even produced a tree (allocate/observe/generation failed). It has no
    // CandidateId, so it cannot enter the selector; the attempt derives its outcome from `failure`.
    return undefined;
  }
  const cost = candidateKnownCost(c.invocations);
  return {
    candidateId: c.candidate.candidateId,
    workspaceId: c.candidate.workspaceId,
    slot: c.slot,
    status: c.status,
    ...(c.disposition !== undefined ? { decision: c.disposition.decision } : {}),
    promotionEligible: c.eligible,
    ...(c.verification !== undefined ? { verificationVerdict: c.verification.verdict } : {}),
    ...(c.critic !== undefined ? { criticVerdict: c.critic.verdict } : {}),
    knownCostMicroUsd: cost.known,
    hasUnknownCost: cost.hasUnknown,
    mutationCount: c.candidate.mutationIds.length,
    changedPathCount: c.candidate.changedPaths.length,
    ...(c.failure !== undefined ? { failureCode: c.failure.code } : {}),
  };
}

/** Build the receipt-safe evaluation summary for ONE candidate (loser evidence stays visible). */
function candidateSummaryOf(c: CandidateResult, selectedCandidateId: string | undefined, cleanup: ReadonlyMap<string, string>): RunCandidateEvaluationSummary {
  const cost = candidateKnownCost(c.invocations);
  const selected = c.candidate !== undefined && c.candidate.candidateId === selectedCandidateId;
  const wsId = c.workspace?.workspaceId;
  // The ACTUAL disposition is recorded in the cleanup map for BOTH the representative (retention
  // block) and every loser (cleanup loop). "retained" is the fallback for the (theoretical) case of
  // a workspace that reached neither — never a claim that overrides a real discard.
  const workspaceCleanup = wsId === undefined ? "none" : cleanup.get(wsId) ?? "retained";
  return {
    slot: c.slot,
    candidateId: c.candidate?.candidateId ?? null,
    workspaceId: wsId ?? null,
    status: c.status,
    promotionEligible: c.eligible,
    decision: c.disposition?.decision ?? null,
    verificationId: c.verification?.verificationId ?? null,
    verificationVerdict: c.verification?.verdict ?? null,
    criticId: c.critic?.criticId ?? null,
    criticVerdict: c.critic?.verdict ?? null,
    dispositionId: c.disposition?.dispositionId ?? null,
    knownCostMicroUsd: cost.known,
    hasUnknownCost: cost.hasUnknown,
    mutationCount: c.candidate?.mutationIds.length ?? 0,
    changedPathCount: c.candidate?.changedPaths.length ?? 0,
    failureCode: c.failure?.code ?? null,
    selected,
    workspaceCleanup,
  };
}

/** Deterministic rank of a NON-selected candidate for choosing the attempt's representative outcome:
 *  a truthful adverse verdict outranks an incomplete failure; among adverse, withheld > rejected >
 *  quarantined; ties break by slot. Lower is better. */
function representativeRank(c: CandidateResult): number {
  const kind = c.stopOutcome?.kind;
  if (kind === "withheld") return 0;
  if (kind === "rejected") return 1;
  if (kind === "quarantined") return 2;
  return 3; // incomplete / failed
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
  /* The frozen builder bounds this attempt ran under, captured at the builder call site
     and reported on the receipt. Stays undefined when the run never reached the builder. */
  let builderBudgetUsed: BuilderBudget | undefined;
  /* The context envelope this attempt ran inside — derived per candidate from the
     capability facts of ITS resolved model, so two candidates on different models would
     report different envelopes without a line of policy code changing. */
  let contextEnvelope: RunContextEnvelopeSummary | undefined;
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
  let criticDecision: ModelResolutionDecision | undefined;
  let retrieval: RetrievalSummary | undefined;
  let contextPackage: ContextPackage | undefined;
  let invocations: readonly V2InvocationRecord[] = [];
  let commands: readonly BuilderCommandRecord[] = [];
  /** Every formatter invocation this run made, across all candidates, in order. */
  const formatterRecords: FormatterRecord[] = [];
  let sourceVerificationDefinition: VerificationDefinition | undefined;
  let candidate: CandidateRecord | undefined;
  let verification: VerificationRecord | undefined;
  let critic: CriticRecord | undefined;
  let dispositionRecord: DispositionRecord | undefined;
  let promotionRecord: PromotionRecord | undefined;
  let workspace: V2WorkspaceRecord | undefined;
  let workspaceObservations = 0;
  let disposition: WorkspaceDisposition | undefined;
  // The terminal outcome computed BY the disposition/promotion authorities. Set on the one
  // path that reaches a real adjudication (and, when eligible, a publication); left undefined
  // when the run failed earlier (then the outcome is `failed` with the recorded failure).
  let dispositionOutcome: RunTerminalOutcome | undefined;
  // V2-017 — the frozen candidate strategy, the per-candidate results (each with its OWN workspace,
  // candidate, evidence), and the ONE selection record. For `single` there is exactly one candidate
  // and the singular `candidate`/`verification`/… above point at it, so the single path is unchanged.
  let strategyPolicy: StrategyPolicy | undefined;
  let selectionRecord: SelectionRecord | undefined;
  const candidateResults: CandidateResult[] = [];
  /** Per-candidate loser-workspace cleanup outcome (workspaceId → status), for receipt truth. */
  const candidateWorkspaceDisposition = new Map<string, "reclaimed" | "retained" | "retain_failed">();

  const failure = await (async (): Promise<RunFailure | null> => {
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

    // MULTI-ROLE RESOLUTION. The critic is the second real model role in v2. It is resolved
    // by the SAME authority, as its OWN request — a distinct decision the critic stage will
    // consume by role, never by borrowing the builder's. The same model may be selected for
    // both; the decisions remain role-specific. The lifecycle refuses a duplicate role
    // resolution, so exactly one builder and one critic decision can exist.
    const resolvedCritic = resolveModelRoute(policy, { runId, policyId: policy.policyId, role: "critic" });
    if (!resolvedCritic.ok) return resolvedCritic.failure;
    criticDecision = resolvedCritic.decision;
    lifecycle.record(runId, { kind: "resolution", decisionId: criticDecision.decisionId, role: criticDecision.role });

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

    // Stage 4 — CANDIDATE STRATEGY (V2-017). Freeze the strategy for this attempt. `single` produces
    // ONE candidate (behaviour unchanged); `shadow`/`tournament` produce N INDEPENDENT candidates —
    // each with its OWN workspace/observations/mutations/invocations/CandidateId — ALL sharing this
    // attempt's single RunId and SourceSnapshot. The strategy generates + compares; it never verifies,
    // adjudicates, promotes, retries, or selects a model. The linear lifecycle is honoured by walking
    // each stage ONCE and doing every candidate's work for that stage before advancing.
    const strat = deps.strategyPolicy ?? defaultStrategyPolicy(task.candidateStrategy);
    strategyPolicy = strat;
    const ctxPkg = contextPackage;
    const builderDecision = decision;
    const critDecision = criticDecision;
    const src = source;

    // Mutable per-candidate state, threaded across the shared stages. Each slot owns its workspace,
    // observations, invocations, commands, and its candidate/verification/critic/disposition records.
    interface Slot {
      slot: number;
      workspace?: V2WorkspaceRecord;
      observations: number;
      invocations: readonly V2InvocationRecord[];
      commands: readonly BuilderCommandRecord[];
      candidate?: CandidateRecord;
      verification?: VerificationRecord;
      critic?: CriticRecord;
      disposition?: DispositionRecord;
      status: "evaluated" | "incomplete";
      eligible: boolean;
      stopOutcome?: RunTerminalOutcome;
      failure?: RunFailure;
    }
    const slots: Slot[] = [];
    for (let i = 0; i < strat.candidateCount; i += 1) slots.push({ slot: i, observations: 0, invocations: [], commands: [], status: "incomplete", eligible: false });
    const live = (): Slot[] => slots.filter((s) => s.failure === undefined && s.stopOutcome === undefined);

    // Phase A — WORKSPACES (candidate_strategy). Allocate each candidate its OWN isolated workspace
    // from the SAME source snapshot, and re-observe the context anchor against it (drift guard).
    lifecycle.enter(runId, "candidate_strategy");
    for (const s of slots) {
      const label = strat.candidateCount === 1 ? `v2-${DEMONSTRATED_ROLE}` : `v2-${DEMONSTRATED_ROLE}-c${s.slot}`;
      const allocated = await deps.workspaces.allocate({ runId, source: src.snapshot, label });
      if (!allocated.ok) { s.failure = allocated.failure; continue; }
      s.workspace = allocated.workspace;
      lifecycle.record(runId, { kind: "workspace", id: s.workspace.workspaceId, baseTree: s.workspace.source.baseTree });
      if (deps.definitionProbe !== undefined && sourceVerificationDefinition === undefined) {
        sourceVerificationDefinition = await deps.definitionProbe.capture(s.workspace.path);
      }
      const anchor = rebindableArtifact(ctxPkg);
      if (anchor !== undefined) {
        const observed = await deps.mutations.observe({ runId, workspace: s.workspace, path: anchor.path });
        if (!observed.ok) { s.failure = observed.failure; continue; }
        s.observations += 1;
        lifecycle.record(runId, { kind: "observation", id: observed.observation.observationId, workspaceId: s.workspace.workspaceId, path: observed.observation.path });
        if (observed.observation.state.contentSha256 !== anchor.observedSha256) {
          s.failure = workspaceFailure({
            code: V2_WORKSPACE_FAILURE_CODES.contextDrift,
            message: `the workspace copy of ${anchor.path} does not match the bytes the context package recorded — the model was shown a state this workspace does not have`,
            detail: { path: anchor.path, workspaceId: s.workspace.workspaceId, contextSha256: anchor.observedSha256, workspaceSha256: observed.observation.state.contentSha256 ?? "none" },
          });
        }
      }
    }

    // Phase B — CANDIDATE GENERATION (candidate_generation). Run the governed builder loop for each
    // candidate INDEPENDENTLY. A candidate never sees a sibling; each write goes through the one
    // mutation authority and each turn through the one invocation authority. Stages are entered ONLY
    // when their precondition is met, so an attempt where every candidate failed earlier terminalizes
    // at the last real stage — exactly as the single-candidate spine did (no empty stage entered).
    if (slots.some((s) => s.workspace !== undefined)) {
    lifecycle.enter(runId, "candidate_generation");
    for (const s of live()) {
      const ws = s.workspace!;
      const formatter = deps.buildFormatter?.({
        runId, workspace: ws, mutations: deps.mutations, mutationScope: task.mutationScope, treeProbe: deps.treeProbe,
      });
      const executor = deps.buildTools({
        runId, workspace: ws, mutations: deps.mutations, mutationScope: task.mutationScope,
        ...(formatter !== undefined ? { formatter, onFormatter: (record) => { formatterRecords.push(record); } } : {}),
        onObservation: (observation) => { s.observations += 1; lifecycle.record(runId, { kind: "observation", id: observation.observationId, workspaceId: observation.workspaceId, path: observation.path }); },
        onMutation: (applied) => { lifecycle.record(runId, { kind: "mutation", id: applied.mutationId, workspaceId: ws.workspaceId, path: applied.path }); },
        ...(deps.commands !== undefined ? { commands: deps.commands } : {}),
      });
      /* The bounds this attempt actually ran under, captured where they are applied so the
         receipt cannot drift from the loop. Same for every candidate in a strategy. */
      builderBudgetUsed = deps.builderBudget ?? DEFAULT_BUILDER_BUDGET;
      const generated = await generateCandidate({
        runId, taskId, decision: builderDecision, contextPackage: ctxPkg, transport: deps.transport, executor,
        untrustedBoundary: deps.untrustedBoundary, mintInvocationId: () => ids.mint("invocation"),
        mutationScope: task.mutationScope,
        ...(deps.repairBrief !== undefined ? { repairBrief: deps.repairBrief } : {}),
        ...(deps.advisoryContext !== undefined ? { advisoryContext: deps.advisoryContext } : {}),
        ...(deps.builderBudget !== undefined ? { budget: deps.builderBudget } : {}),
        ...(deps.aliases !== undefined ? { aliases: deps.aliases } : {}),
        ...(deps.admission !== undefined ? { admission: deps.admission } : {}),
        now,
      });
      /*
        BOTH branches. The envelope is execution evidence, not a success trophy — a run
        that died at the turn limit is precisely the one whose window behaviour someone
        will want to read, and it used to report nothing.
      */
      contextEnvelope = generated.ok
        ? summarizeContextEnvelope(generated.generation.ceiling, generated.generation.compactions, generated.generation.turns, generated.generation.maxEstimatedInputTokens, generated.generation.repeatedCommands,
            summarizeEstimateCalibration(generated.generation.invocations, ctxPkg.budget.tokenEstimator.charsPerToken, ctxPkg.budget.tokenEstimator.provenance))
        : summarizeContextEnvelope(generated.ceiling, generated.compactions, generated.turns, generated.maxEstimatedInputTokens, generated.repeatedCommands,
            summarizeEstimateCalibration(generated.invocations, ctxPkg.budget.tokenEstimator.charsPerToken, ctxPkg.budget.tokenEstimator.provenance));
      for (const record of generated.ok ? generated.generation.invocations : generated.invocations) lifecycle.record(runId, { kind: "invocation", id: record.invocationId, role: builderDecision.role });
      if (!generated.ok) for (const id of generated.attemptedInvocationIds) lifecycle.record(runId, { kind: "invocation", id, role: builderDecision.role });
      s.invocations = generated.ok ? generated.generation.invocations : generated.invocations;
      s.commands = generated.ok ? generated.generation.commands : generated.commands;
      if (!generated.ok) { s.failure = generated.failure; continue; }
      const capturedTree = await deps.captureTree(ws);
      if (!capturedTree.ok) { s.failure = capturedTree.failure; continue; }
      const generation = generated.generation;
      s.candidate = Object.freeze({
        candidateId: candidateDigest({ sourceSnapshotId: src.snapshot.snapshotId, tree: capturedTree.tree }),
        runId, sourceSnapshotId: src.snapshot.snapshotId, workspaceId: ws.workspaceId, builderDecisionId: builderDecision.decisionId,
        invocationIds: generation.invocationIds, mutationIds: generation.mutationIds, changedPaths: generation.changedPaths,
        tree: capturedTree.tree, completion: "finished", claim: generation.claim,
        metadata: { turns: generation.turns, toolCalls: generation.toolCalls, toolFailures: generation.toolFailures, startedAt: generation.startedAt, endedAt: generation.endedAt },
      });
      lifecycle.record(runId, { kind: "candidate", id: s.candidate.candidateId, workspaceId: ws.workspaceId });
    }
    }

    // Phase C — VERIFICATION (verification). THE deterministic authority, per candidate tree.
    if (slots.some((s) => s.candidate !== undefined)) {
    lifecycle.enter(runId, "verification");
    for (const s of live()) {
      if (s.candidate === undefined) continue;
      const verified = await verifyCandidate({
        runId, subject: verificationSubjectOf(s.candidate), candidate: s.candidate, workspacePath: s.workspace!.path,
        checksSource: deps.checksSource, runner: deps.checkRunner, tree: deps.treeProbe, checkTimeoutMs: deps.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
        ...(sourceVerificationDefinition !== undefined ? { sourceDefinition: sourceVerificationDefinition } : {}),
        ...(deps.definitionProbe !== undefined ? { definitionProbe: deps.definitionProbe } : {}),
        now,
      });
      if (!verified.ok) { s.failure = verified.failure; continue; }
      s.verification = verified.record;
      lifecycle.record(runId, { kind: "verification", id: s.verification.verificationId, candidateId: s.candidate.candidateId });
    }
    }

    // Phase D — CRITICISM (criticism). THE semantic critic, per candidate; pre-call cost admission on
    // the SAME session wallet. A candidate never sees a sibling's diff, claim, or defects.
    if (slots.some((s) => s.verification !== undefined)) {
    lifecycle.enter(runId, "criticism");
    for (const s of live()) {
      if (s.candidate === undefined || s.verification === undefined) continue;
      const criticMaxOutputTokens = Math.min(CRITIC_MAX_OUTPUT_TOKENS, ctxPkg.budget.reservedCompletionTokens);
      if (deps.admission !== undefined) {
        const admittedCritic = deps.admission.admitNext({ identity: { authorizedModelId: critDecision.modelId, sentProviderId: critDecision.providerId, sentProviderModelId: critDecision.providerModelId }, estimatedInputTokens: ctxPkg.budget.availableInputTokens, maxOutputTokens: criticMaxOutputTokens });
        if (!admittedCritic.admit) { s.failure = admittedCritic.failure; continue; }
      }
      // V2-019/HIGH-02: the RUN mints the critic's InvocationId and hands the SAME session
      // admission the builder uses down into the critic, which records the attempt immediately
      // before the wire send. The identity therefore exists here before the call is made, so a
      // transport failure carrying no record can still be ledgered.
      const criticInvocationId = ids.mint("invocation");
      /* Minted here, with the first: the run must know the identity of every call that
         could reach the wire BEFORE any of them do, so a repair that dies in transport is
         still ledgerable. Passing it is what ENABLES the one bounded protocol repair. */
      const criticRepairInvocationId = ids.mint("invocation");
      const judged = await judgeCandidate({
        runId, taskId, goal: task.goal, candidate: s.candidate, verification: s.verification, verificationSummary: summarizeVerification(s.verification), workspacePath: s.workspace!.path,
        decision: critDecision, transport: deps.transport, boundary: deps.untrustedBoundary, diffSource: deps.candidateDiff, diffBudget: DEFAULT_DIFF_BUDGET,
        probeTree: (path) => deps.treeProbe.treeOf(path), invocationId: criticInvocationId, repairInvocationId: criticRepairInvocationId, maxOutputTokens: criticMaxOutputTokens, timeoutMs: CRITIC_TIMEOUT_MS,
        // The formatter invocations for THIS candidate's workspace — part of the deterministic
        // evidence the critic may cite, and scoped to the candidate so a sibling's formatting
        // can never support a claim about this one.
        formatterEvidence: formatterRecords
          .filter((r) => r.workspaceId === s.workspace!.workspaceId)
          .map((r) => ({ formatterId: r.formatterId, argv: r.argv, outcome: r.outcome })),
        ...(deps.admission !== undefined ? { admission: deps.admission } : {}),
        ...(deps.aliases !== undefined ? { aliases: deps.aliases } : {}), now,
      });
      if (judged.ok) {
        lifecycle.record(runId, { kind: "invocation", id: judged.generation.invocation.invocationId, role: "critic" });
        s.invocations = [...s.invocations, judged.generation.invocation];
        if (deps.admission !== undefined) deps.admission.charge(judged.generation.invocation);
        // A protocol repair is a second REAL call. Ledger and charge it like the first —
        // there is no such thing as a free re-ask.
        if (judged.generation.repairInvocation !== undefined) {
          lifecycle.record(runId, { kind: "invocation", id: judged.generation.repairInvocation.invocationId, role: "critic" });
          s.invocations = [...s.invocations, judged.generation.repairInvocation];
          if (deps.admission !== undefined) deps.admission.charge(judged.generation.repairInvocation);
        }
      } else if (judged.invocation !== undefined) {
        lifecycle.record(runId, { kind: "invocation", id: judged.invocation.invocationId, role: "critic" });
        s.invocations = [...s.invocations, judged.invocation];
        if (deps.admission !== undefined) deps.admission.charge(judged.invocation);
        if (judged.repairInvocation !== undefined) {
          lifecycle.record(runId, { kind: "invocation", id: judged.repairInvocation.invocationId, role: "critic" });
          s.invocations = [...s.invocations, judged.repairInvocation];
          if (deps.admission !== undefined) deps.admission.charge(judged.repairInvocation);
        } else if (judged.repairAttemptedInvocationId !== undefined) {
          lifecycle.record(runId, { kind: "invocation", id: judged.repairAttemptedInvocationId, role: "critic" });
        }
      } else if (judged.attemptedInvocationId !== undefined) {
        // The wire was reached and NOTHING came back. That is still a real provider call: ledger
        // it (so `receipt.evidence.invocations` counts it and the session reconcile prices it as
        // a failed-without-usage call), but fabricate no InvocationRecord and no CriticRecord.
        lifecycle.record(runId, { kind: "invocation", id: judged.attemptedInvocationId, role: "critic" });
      }
      if (!judged.ok) { s.failure = judged.failure; continue; }
      s.critic = judged.generation.record;
      lifecycle.record(runId, { kind: "critic", id: s.critic.criticId, candidateId: s.candidate.candidateId, verificationId: s.verification.verificationId });
    }
    }

    // Phase E — DISPOSITION (disposition). THE one adjudication authority, per candidate. No model,
    // no mutation, no promotion. A drift quarantine or a non-eligible verdict sets the candidate's
    // truthful stop outcome; an eligible candidate carries its disposition into selection.
    if (slots.some((s) => s.critic !== undefined)) {
    lifecycle.enter(runId, "disposition");
    for (const s of live()) {
      if (s.candidate === undefined || s.verification === undefined || s.critic === undefined) continue;
      const disposed = await judgeDisposition({ runId, taskId, candidate: s.candidate, verification: s.verification, critic: s.critic, policy: deps.dispositionPolicy ?? DEFAULT_DISPOSITION_POLICY, workspacePath: s.workspace!.path, probeTree: (path: string) => deps.treeProbe.treeOf(path) });
      if (!disposed.ok && disposed.kind === "mismatch") { s.failure = disposed.failure; continue; }
      if (!disposed.ok) { s.stopOutcome = { kind: "quarantined", reason: "safety_forensics", detail: disposed.detail }; s.status = "evaluated"; continue; }
      s.disposition = disposed.record;
      lifecycle.record(runId, { kind: "disposition", id: s.disposition.dispositionId, candidateId: s.candidate.candidateId, verificationId: s.verification.verificationId, criticId: s.critic.criticId, decision: s.disposition.decision });
      s.status = "evaluated";
      s.eligible = s.disposition.eligibleForPromotion;
      if (!s.eligible) s.stopOutcome = terminalOutcomeForDisposition(s.disposition, s.candidate.candidateId, s.verification.verificationId);
    }
    }

    // Aggregate cross-candidate accounting, then convert to immutable per-candidate results.
    for (const s of slots) {
      invocations = [...invocations, ...s.invocations];
      commands = [...commands, ...s.commands];
      workspaceObservations += s.observations;
      candidateResults.push({
        slot: s.slot, observations: s.observations, invocations: s.invocations, commands: s.commands, status: s.status, eligible: s.eligible,
        ...(s.workspace !== undefined ? { workspace: s.workspace } : {}),
        ...(s.candidate !== undefined ? { candidate: s.candidate } : {}),
        ...(s.verification !== undefined ? { verification: s.verification } : {}),
        ...(s.critic !== undefined ? { critic: s.critic } : {}),
        ...(s.disposition !== undefined ? { disposition: s.disposition } : {}),
        ...(s.stopOutcome !== undefined ? { stopOutcome: s.stopOutcome } : {}),
        ...(s.failure !== undefined ? { failure: s.failure } : {}),
      });
    }

    // SELECT — the ONE pure selector over the immutable canonical evaluations.
    const evaluations = candidateResults.map(candidateEvaluationOf).filter((e): e is CandidateEvaluation => e !== undefined);
    const selection = selectCandidate({ runId, policy: strat, evaluations, launchedCount: strat.candidateCount });
    selectionRecord = selection;

    const bindRep = (r: CandidateResult): void => {
      if (r.workspace !== undefined) workspace = r.workspace;
      if (r.candidate !== undefined) candidate = r.candidate;
      if (r.verification !== undefined) verification = r.verification;
      if (r.critic !== undefined) critic = r.critic;
      if (r.disposition !== undefined) dispositionRecord = r.disposition;
    };

    const selected = selection.selectedCandidateId !== undefined
      ? candidateResults.find((c) => c.candidate?.candidateId === selection.selectedCandidateId)
      : undefined;

    if (selected !== undefined && selected.candidate !== undefined && selected.verification !== undefined && selected.critic !== undefined && selected.disposition !== undefined && selected.workspace !== undefined) {
      bindRep(selected);
      const selVer = selected.verification; const selDisp = selected.disposition; const selWs = selected.workspace; const selCand = selected.candidate; const selCrit = selected.critic;
      // Stage 9 — PROMOTION of the selected candidate. EXACTLY ONE candidate reaches promotion.
      lifecycle.enter(runId, "promotion");

      /*
        THE PUBLICATION SCOPE RE-CHECK — the last, independent statement of the authority.

        The per-mutation gate in the tool executor already refused out-of-scope edits, so in an
        honest run this finds nothing. That is exactly why it runs: it is the ASSERTION that the
        upstream gate held, and it is derived from a different thing. The gate reasons about
        individual tool calls; this reasons about the TREE — the diff between the source
        snapshot and the candidate — so a path that reached the tree by any route the gate does
        not own is still caught here, before anything is published.

        It refuses; it never repairs. Dropping the offending file and publishing the rest would
        be publishing something no authority ever verified.
      */
      const publishedDiff = await deps.candidateDiff.diff({
        workspacePath: selWs.path,
        candidateId: selCand.candidateId,
        sourceSnapshotId: selCand.sourceSnapshotId,
        fromTree: selCand.tree.baseTreeId,
        toTree: selCand.tree.treeId,
        budget: DEFAULT_DIFF_BUDGET,
      });
      const scopeViolations = reviewChangedPaths(
        task.mutationScope,
        publishedDiff.files.map((f) => ({ path: f.path, operation: DIFF_KIND_TO_OPERATION[f.changeKind] })),
      );
      if (scopeViolations.length > 0) {
        return publicationScopeFailure(scopeViolations, task.mutationScope);
      }

      const promoted = await promoteAuthorized({
        taskId, candidate: selCand, verification: selVer, critic: selCrit, disposition: selDisp,
        target: { repositoryPath: selWs.source.repositoryPath, baseBranch: selWs.source.baseBranch, baseCommit: selWs.source.baseCommit },
        sourceClean: src.snapshot.clean, workspacePath: selWs.path, probeTree: (path: string) => deps.treeProbe.treeOf(path), publisher: deps.publisher, now,
      });
      if (promoted.kind === "promoted" || promoted.kind === "already_promoted" || promoted.kind === "promoted_degraded") {
        promotionRecord = promoted.record;
        lifecycle.record(runId, { kind: "promotion", id: promoted.record.promotionId, candidateId: selCand.candidateId, verificationId: selVer.verificationId, dispositionId: selDisp.dispositionId });
      }
      if (promoted.kind === "refused_wrong_evidence" || promoted.kind === "infrastructure_failure") return promoted.failure;
      dispositionOutcome = terminalOutcomeForPromotion(promoted, selCand.candidateId, selVer.verificationId);
      return null;
    }

    // NO SELECTION — no promotion. Bind the singular fields to the deterministic REPRESENTATIVE
    // candidate and derive the attempt's truthful terminal outcome. For `single` the representative
    // IS the one candidate, reproducing withheld/rejected/quarantined/failed exactly.
    if (selection.reason === "require_all_candidates_incomplete") {
      const failed = candidateResults.find((c) => c.status === "incomplete" && c.failure !== undefined);
      if (failed?.failure !== undefined) { bindRep(failed); return failed.failure; }
    }
    const adverse = [...candidateResults].filter((c) => c.stopOutcome !== undefined).sort((a, b) => representativeRank(a) - representativeRank(b) || a.slot - b.slot)[0];
    if (adverse?.stopOutcome !== undefined) { bindRep(adverse); dispositionOutcome = adverse.stopOutcome; return null; }
    const anyFailed = candidateResults.find((c) => c.failure !== undefined);
    if (anyFailed?.failure !== undefined) { bindRep(anyFailed); return anyFailed.failure; }
    return null;
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
    // A candidate that was ADJUDICATED is retained — no matter the decision. Even a rejected
    // or quarantined candidate is kept for now: a later recovery authority may reuse it, and
    // deleting evidence is not disposition's job. An eligible-for-promotion candidate is
    // likewise retained (eligibility is not promotion — the tree stays on disk for V2-012).
    // A candidate that reached only verification (disposition never ran) is still retained;
    // one that never reached verification leaves a half-built tree and is discarded.
    disposition =
      dispositionRecord !== undefined
        ? await deps.workspaces.retain(workspace, `candidate ${candidate!.candidateId} adjudicated ${dispositionRecord.decision} (${dispositionRecord.primaryReason}); retained`)
        : verification !== undefined
          ? await deps.workspaces.retain(workspace, `candidate ${candidate!.candidateId} verified ${verification.verdict}; awaits disposition`)
          : candidate !== undefined
            ? await deps.workspaces.retain(workspace, `candidate ${candidate.candidateId} awaits verification`)
            : await deps.workspaces.discard(workspace);
    // Record the representative's ACTUAL cleanup so the receipt never claims a discarded
    // (failed) representative workspace was retained.
    if (disposition !== undefined) candidateWorkspaceDisposition.set(workspace.workspaceId, disposition.kind === "retained" ? "retained" : disposition.kind === "discarded" ? "reclaimed" : "retain_failed");
  }

  // V2-017 — SUPERSEDED CANDIDATE CLEANUP. In a shadow/tournament attempt the SELECTED/representative
  // candidate's workspace is retained above; every OTHER (losing) candidate workspace is superseded.
  // A QUARANTINED loser is retained (safety forensics); an ordinary loser worktree is reclaimed now —
  // its EVIDENCE (candidate/verification/critic/disposition ids) stays on the receipt regardless.
  const selectedWorkspaceId = workspace?.workspaceId;
  for (const c of candidateResults) {
    if (c.workspace === undefined || c.workspace.workspaceId === selectedWorkspaceId) continue;
    if (c.stopOutcome?.kind === "quarantined") {
      const kept = await deps.workspaces.retain(c.workspace, `candidate ${c.candidate?.candidateId ?? c.workspace.workspaceId} quarantined (safety forensics); retained`);
      if (kept.kind === "retained") candidateWorkspaceDisposition.set(c.workspace.workspaceId, "retained");
    } else {
      const reclaimed = await deps.workspaces.discard(c.workspace);
      candidateWorkspaceDisposition.set(c.workspace.workspaceId, reclaimed.kind === "discarded" ? "reclaimed" : "retain_failed");
    }
  }

  // The ONE authoritative outcome: the disposition's lawful decision when the run reached
  // adjudication, otherwise `failed` with the recorded failure.
  const outcome: RunTerminalOutcome = dispositionOutcome ?? { kind: "failed", failure: failure as RunFailure };
  lifecycle.terminalize(runId, outcome);

  const endedAt = now();
  const receipt: V2RunReceipt = {
    receiptId: ids.mint("receipt"),
    taskId,
    runId,
    outcome,
    stagesEntered: lifecycle.stagesEntered,
    evidence: summarizeEvidence(lifecycle.ledger, outcome, commands.length,
      promotionRecord !== undefined
        ? { beforeRef: promotionRecord.beforeRef, afterRef: promotionRecord.afterRef }
        : undefined),
    // The authority this run held. Recorded whenever preflight got far enough to establish
    // one — a reader cannot judge "what changed" without knowing what was permitted to.
    ...(resolvedTask !== undefined ? { mutationScope: summarizeMutationScope(resolvedTask.mutationScope) } : {}),
    // Every formatter invocation, in order — including the refused and the timed out. A
    // formatter that changed nothing is evidence too; a formatter that was refused for scope is
    // the evidence that matters most.
    ...(formatterRecords.length > 0 ? { formatters: formatterRecords.map(summarizeFormatter) } : {}),
    ...(policy !== undefined ? { configuration: summarizeConfiguration(policy) } : {}),
    ...(source !== undefined ? { sourceSnapshot: summarizeSnapshot(source.snapshot) } : {}),
    ...(decision !== undefined ? { resolution: summarizeResolution(decision) } : {}),
    ...(contextPackage !== undefined ? { context: summarizeContext(contextPackage) } : {}),
    ...(retrieval !== undefined ? { retrieval } : {}),
    invocations: invocations.map(summarizeInvocation),
    commands: commands.map(summarizeCommand),
    ...(strategyPolicy !== undefined ? { strategy: summarizeStrategy(strategyPolicy) } : {}),
    ...(builderBudgetUsed !== undefined
      ? { builderBudget: summarizeBuilderBudget(builderBudgetUsed, deps.builderTurnSource ?? "default", deps.builderToolCallSource ?? "default", deps.builderCommandSource ?? "default") }
      : {}),
    ...(contextEnvelope !== undefined ? { contextEnvelope } : {}),
    ...(candidateResults.length > 0 ? { candidates: candidateResults.map((c) => candidateSummaryOf(c, selectionRecord?.selectedCandidateId, candidateWorkspaceDisposition)) } : {}),
    ...(selectionRecord !== undefined ? { selection: summarizeSelection(selectionRecord) } : {}),
    ...(candidate !== undefined ? { candidate: summarizeCandidate(candidate) } : {}),
    ...(verification !== undefined ? { verification: summarizeVerification(verification) } : {}),
    ...(critic !== undefined ? { critic: summarizeCritic(critic) } : {}),
    ...(dispositionRecord !== undefined ? { disposition: summarizeDisposition(dispositionRecord) } : {}),
    ...(promotionRecord !== undefined ? { promotion: summarizePromotion(promotionRecord) } : {}),
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
    commands,
    ...(workspace !== undefined ? { workspace } : {}),
    ...(candidate !== undefined ? { candidate } : {}),
    ...(verification !== undefined ? { verification } : {}),
    ...(critic !== undefined ? { critic } : {}),
    ...(dispositionRecord !== undefined ? { disposition: dispositionRecord } : {}),
    ...(promotionRecord !== undefined ? { promotion: promotionRecord } : {}),
    ...(selectionRecord !== undefined ? { selection: selectionRecord } : {}),
    journal: lifecycle.journal,
    receipt,
  };
}

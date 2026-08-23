/**
 * ikbi v2 — TERMINAL OUTCOMES, THE RUN RECEIPT, AND THE RUN RESULT.
 *
 * A v2 run ends in exactly ONE outcome object. The states that made v1's status
 * hard to trust — `success: true` next to `promotion: false` next to
 * `verification: "failed"` — are not merely discouraged here, they are
 * UNREPRESENTABLE: each outcome is a distinct variant carrying only the evidence it
 * is entitled to, and the lifecycle refuses to accept a variant whose evidence it
 * never saw recorded (see lifecycle.ts `terminalize`).
 *
 * THE FIVE OUTCOMES (named after v1's hard-won distinctions, which were right):
 *
 *   accepted     work was verified good and PROMOTED. The only outcome that may
 *                claim the repository changed.
 *   withheld     work was verified good and deliberately NOT promoted (a gate, a
 *                policy, an operator). v1's adjudication core calls this "retain"
 *                and is emphatic that it is NOT a failure — green work is never
 *                laundered into "the builder failed". v2 keeps that distinction.
 *   rejected     work was produced but is not verified-good (red checks, no work,
 *                vacuous green). v1's "discard".
 *   quarantined  the run was stopped and its state is being PRESERVED for a human
 *                or a forensic pass. Nothing promoted, nothing thrown away.
 *   failed       the run could not complete. Carries a structured RunFailure.
 *
 * THE RECEIPT is produced BY terminalization and derives every truth claim from the
 * lifecycle's own journal and evidence ledger. It is not assembled from what a
 * caller believes happened. That is why `providerInvoked`, `candidatesCreated`,
 * `verificationsPerformed`, `promoted` and `repositoryMutated` cannot be optimistic:
 * there is no code path that sets them, only a path that COUNTS them.
 */

import type { RunFailure } from "./failure.js";
import type { RunMutationScopeSummary } from "./mutation-scope.js";
import type { LifecycleStage, LifecycleTransition, RunLedgerView } from "./lifecycle.js";
import type {
  V2CandidateId,
  V2PolicyDigest,
  V2PromotionId,
  V2ReceiptId,
  V2RunId,
  V2TaskId,
  V2VerificationId,
} from "./identity.js";
import type { RuntimeModelPolicy } from "./config.js";
import type { ModelResolutionDecision } from "./resolver.js";
import type { ContextManifest, ContextPackage } from "./context.js";
import type { V2InvocationRecord } from "./invocation.js";
import type { BuilderCommandRecord } from "./command.js";
import type { BuilderBoundSource, BuilderBudget, BuilderTurnSource } from "./builder.js";
import type { CompactionEvent, ConversationCeiling } from "./conversation.js";
import type { SelectionRecord, StrategyPolicy } from "./strategy.js";
import type { V2WorkspaceRecord, WorkspaceDisposition } from "./workspace.js";
import type { SourceSnapshotSummary } from "./source.js";
import type { CandidateRecord, RunCandidateSummary } from "./candidate.js";
import type { RunVerificationSummary, VerificationRecord } from "./verification.js";
import type { RunCriticSummary, CriticRecord } from "./critic.js";
import type { RunDispositionSummary, DispositionRecord } from "./disposition.js";
import type { RunPromotionSummary, PromotionRecord } from "./promotion.js";
import type { RetrievalSummary } from "./retrieval.js";

/**
 * Why verified-good work was withheld instead of promoted. Closed set.
 *
 * `awaiting_promotion` was the V2-010 pre-promotion outcome. With V2-011 an eligible candidate
 * proceeds INTO promotion; it lands `accepted`, or it is withheld for a specific, truthful
 * reason: `target_moved` (the target ref advanced — no auto-merge; recovery must re-verify),
 * `unsupported_publication` (a dirty source checkout cannot use clean-ref CAS in this slice),
 * `operator` (the target worktree is dirty — a human must resolve it). In every withheld case
 * the source is unchanged, nothing was published, and the candidate is retained.
 */
export type WithheldReason =
  | "awaiting_promotion"
  | "target_moved"
  | "unsupported_publication"
  | "governance"
  | "operator"
  | "policy"
  | "dry_run";

/** Why produced work was rejected. Closed set (mirrors v1's DiscardReason vocabulary). */
export type RejectedReason = "verification_red" | "no_work" | "vacuous_green" | "unresolvable" | "aborted";

/** Why a run was quarantined. Closed set. */
export type QuarantineReason = "safety_forensics" | "operator_hold" | "adjudication_incomplete";

/**
 * THE authoritative end state of a run. Exactly one of these, exactly once.
 * Note what `accepted` requires and what the negative outcomes deliberately cannot
 * carry: a `failed` run has no candidate/verification/promotion fields at all, so it
 * has no vocabulary in which to imply work landed.
 */
export type RunTerminalOutcome =
  | {
      readonly kind: "accepted";
      readonly candidateId: V2CandidateId;
      readonly verificationId: V2VerificationId;
      readonly promotionId: V2PromotionId;
    }
  | {
      readonly kind: "withheld";
      readonly candidateId: V2CandidateId;
      readonly verificationId: V2VerificationId;
      readonly reason: WithheldReason;
    }
  | { readonly kind: "rejected"; readonly reason: RejectedReason; readonly candidateId?: V2CandidateId }
  | { readonly kind: "quarantined"; readonly reason: QuarantineReason; readonly detail: string }
  | { readonly kind: "failed"; readonly failure: RunFailure };

/** The outcome kinds, for exhaustive iteration in tests and renderers. */
export const RUN_TERMINAL_KINDS = ["accepted", "withheld", "rejected", "quarantined", "failed"] as const;

/** Did the repository change as a result of this run? True for exactly one outcome. */
export function outcomeChangedRepository(outcome: RunTerminalOutcome): boolean {
  return outcome.kind === "accepted";
}

/**
 * Process exit code for an outcome. `withheld` is 0 because withholding verified
 * work is a correct, intended result — not an error the operator must chase.
 */
export function exitCodeForOutcome(outcome: RunTerminalOutcome): number {
  switch (outcome.kind) {
    case "accepted":
    case "withheld":
      return 0;
    case "rejected":
      return 1;
    case "quarantined":
      return 2;
    case "failed":
      return 1;
  }
}

/** One-line operator rendering of an outcome. */
export function formatOutcome(outcome: RunTerminalOutcome): string {
  switch (outcome.kind) {
    case "accepted":
      return `accepted — promoted (${outcome.promotionId})`;
    case "withheld":
      return outcome.reason === "awaiting_promotion"
        ? "withheld — ELIGIBLE for promotion, retained pending the promotion authority (not yet enacted)"
        : `withheld — verified work retained, not promoted (${outcome.reason})`;
    case "rejected":
      return `rejected — ${outcome.reason}`;
    case "quarantined":
      return `quarantined — ${outcome.reason}: ${outcome.detail}`;
    case "failed":
      return `failed — [${outcome.failure.category}] ${outcome.failure.message}`;
  }
}

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

/**
 * The truth block. Every field is COUNTED from the lifecycle ledger, never asserted.
 * A stage that did not run cannot contribute to it, so a skeleton run reports
 * zeroes and falses — which is the entire point of shipping this in slice 001.
 */
export interface RunEvidenceSummary {
  /** True only when preflight actually built and recorded a runtime model policy. */
  readonly configurationResolved: boolean;
  /** True only when the resolver actually authorized a route. NOT an invocation. */
  readonly modelResolutionCompleted: boolean;
  /** How many routes were authorized. A skeleton run authorizes exactly one. */
  readonly modelResolutions: number;
  /** True only when preflight actually captured the run's source snapshot. */
  readonly sourceSnapshotCaptured: boolean;
  /** How many source snapshots exist. Exactly one, or none. */
  readonly sourceSnapshots: number;
  /** Isolated workspaces actually allocated. */
  readonly workspacesAllocated: number;
  /** State-bound observations actually taken. */
  readonly observationsTaken: number;
  /** Mutations actually APPLIED through the state-bound authority. */
  readonly mutationsApplied: number;
  /** True only when deterministic retrieval actually ran during context assembly. */
  readonly retrievalPerformed: boolean;
  /** True only when the assembler actually produced an authorized context package. */
  readonly contextAssemblyCompleted: boolean;
  /** How many context packages exist. Exactly one, or none. */
  readonly contextPackages: number;
  readonly providerInvoked: boolean;
  readonly invocations: number;
  /** How many READ-ONLY builder commands ran (V2-015). Every one left the candidate tree unchanged. */
  readonly commandsRun: number;
  readonly candidatesCreated: number;
  readonly verificationsPerformed: number;
  readonly promotionsAttempted: number;
  readonly promoted: boolean;
  /**
   * Did the builder change files IN THE ISOLATED CANDIDATE WORKSPACE?
   *
   * V2-007 SPLIT THIS. It used to be one field named `repositoryMutated`, which was
   * unambiguous only while nothing could write anywhere: with a real builder, "the
   * repository was mutated" would be read as the operator's repository, and it would be
   * TRUE on every successful build. Two facts, two fields, neither able to stand in for
   * the other.
   */
  readonly candidateMutated: boolean;
  /**
   * Did anything reach the OPERATOR'S repository? True only when a promotion both
   * happened and became the terminal outcome. Nothing in this build can make it true.
   */
  readonly sourceRepositoryMutated: boolean;
}

/**
 * The configuration a run actually used, as a receipt-safe summary.
 *
 * Present only when preflight really resolved one. Everything here is a digest, a
 * name or a count — never an endpoint credential and never a raw parameter value.
 */
export interface RunConfigurationSummary {
  readonly policyId: V2PolicyDigest;
  readonly inventoryDigest: string;
  /** The active profile's name, or null when the operator selected none. */
  readonly profile: string | null;
  readonly profileSource: string;
  readonly providersConfigured: number;
  readonly modelsInvocable: number;
  readonly rolesResolved: number;
  readonly unsatisfiableRequiredRoles: readonly string[];
}

/** Summarize a policy for a receipt. Derived from the policy — nothing is asserted. */
export function summarizeConfiguration(policy: RuntimeModelPolicy): RunConfigurationSummary {
  return {
    policyId: policy.policyId,
    inventoryDigest: policy.inventory.digest,
    profile: policy.profile?.name ?? null,
    profileSource: policy.profileSource,
    providersConfigured: policy.inventory.providersConfigured,
    modelsInvocable: policy.inventory.modelsInvocable,
    rolesResolved: policy.rolePreferences.length,
    unsatisfiableRequiredRoles: policy.unsatisfiableRequiredRoles,
  };
}

/**
 * The route this run was AUTHORIZED to invoke, as a receipt-safe summary.
 *
 * Present only when the resolver actually authorized one. An authorization is not an
 * invocation, and this block never implies otherwise — `providerInvoked` stays false
 * beside it until a real call happens.
 */
export interface RunResolutionSummary {
  readonly decisionId: string;
  readonly role: string;
  readonly modelId: string;
  readonly providerId: string;
  readonly providerModelId: string;
  readonly preferenceSource: string;
  readonly providerReadiness: string;
  readonly basis: string;
  readonly routeOrdinal: number;
  readonly routeCount: number;
}

/** Summarize a decision for a receipt. Derived from the decision — nothing is asserted. */
export function summarizeResolution(decision: ModelResolutionDecision): RunResolutionSummary {
  return {
    decisionId: decision.decisionId,
    role: decision.role,
    modelId: decision.modelId,
    providerId: decision.providerId,
    providerModelId: decision.providerModelId,
    preferenceSource: decision.preferenceSource,
    providerReadiness: decision.providerReadiness,
    basis: decision.basis,
    routeOrdinal: decision.routeOrdinal,
    routeCount: decision.routeCount,
  };
}

/**
 * The context a run authorized, as a receipt-safe summary. Counts and digests only —
 * the artifact bodies are never reproduced into a receipt.
 */
export interface RunContextSummary {
  readonly packageId: string;
  readonly resolutionDecisionId: string;
  readonly artifacts: number;
  readonly omissions: number;
  readonly estimatedInputTokens: number;
  readonly availableInputTokens: number;
  readonly contextWindowTokens: number;
  readonly sourcesConsulted: readonly string[];
}

/** Summarize a context package for a receipt. Derived — nothing is asserted. */
export function summarizeContext(pkg: ContextPackage): RunContextSummary {
  return {
    packageId: pkg.packageId,
    resolutionDecisionId: pkg.resolutionDecisionId,
    artifacts: pkg.artifacts.length,
    omissions: pkg.omissions.length,
    estimatedInputTokens: pkg.estimatedInputTokens,
    availableInputTokens: pkg.budget.availableInputTokens,
    contextWindowTokens: pkg.budget.contextWindowTokens,
    sourcesConsulted: pkg.sourcesConsulted,
  };
}

/**
 * The invocation a run actually performed. The four identities are kept apart because
 * they are four different facts; `servedModelId` is absent when the provider reported
 * none, and is never filled in from what was sent.
 */
export interface RunInvocationSummary {
  readonly invocationId: string;
  readonly role: string;
  readonly resolutionDecisionId: string;
  readonly contextPackageId: string;
  readonly promptId: string;
  readonly authorizedModelId: string;
  readonly sentProviderId: string;
  readonly sentProviderModelId: string;
  readonly servedModelId: string | null;
  readonly identityStatus: string;
  readonly attempts: number;
  readonly finishReason: string;
  readonly usage?: V2InvocationRecord["usage"];
}

/** Summarize an invocation for a receipt. Derived — nothing is asserted. */
export function summarizeInvocation(record: V2InvocationRecord): RunInvocationSummary {
  return {
    invocationId: record.invocationId,
    role: record.identity.requestedRole,
    resolutionDecisionId: record.resolutionDecisionId,
    contextPackageId: record.contextPackageId,
    promptId: record.promptId,
    authorizedModelId: record.identity.authorizedModelId,
    sentProviderId: record.identity.sentProviderId,
    sentProviderModelId: record.identity.sentProviderModelId,
    servedModelId: record.identity.servedModelId ?? null,
    identityStatus: record.identity.identityStatus,
    attempts: record.attempts,
    finishReason: record.finishReason,
    ...(record.usage !== undefined ? { usage: record.usage } : {}),
  };
}

/**
 * One READ-ONLY command a run's builder ran (V2-015), as a receipt-safe summary. The bounded
 * output EXCERPT is deliberately omitted from the receipt — only its hash, size and truncation
 * flag are kept, so a receipt never reproduces untrusted command output. `workspaceUnchanged`
 * (tree before == after) is the load-bearing read-only proof.
 */
export interface RunCommandSummary {
  readonly commandId: string;
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly commandPolicyId: string;
  readonly sandboxMode: string;
  readonly workspaceAccess: string;
  readonly network: string;
  readonly launched: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly outputSha256: string;
  readonly outputByteLength: number;
  readonly outputTruncated: boolean;
  readonly workspaceUnchanged: boolean;
}

/** Summarize a command for a receipt. Derived — nothing is asserted; the output body is not carried. */
export function summarizeCommand(record: BuilderCommandRecord): RunCommandSummary {
  return {
    commandId: record.commandId,
    program: record.program,
    args: [...record.args],
    cwd: record.cwd,
    commandPolicyId: record.commandPolicyId,
    sandboxMode: record.sandboxMode,
    workspaceAccess: record.workspaceAccess,
    network: record.network,
    launched: record.launched,
    exitCode: record.exitCode ?? null,
    timedOut: record.timedOut,
    durationMs: record.durationMs,
    outputSha256: record.outputSha256,
    outputByteLength: record.outputByteLength,
    outputTruncated: record.outputTruncated,
    workspaceUnchanged: record.treeBefore === record.treeAfter,
  };
}

// ---------------------------------------------------------------------------
// Candidate strategy (V2-017)
// ---------------------------------------------------------------------------

/** The frozen candidate strategy an attempt used — the answer to "how many candidates, and how chosen?". */
export interface RunStrategySummary {
  readonly kind: string;
  readonly policyId: string;
  readonly candidateCount: number;
  readonly partialCompletion: string;
  readonly selectionRule: string;
}

/** Summarize a strategy policy for a receipt. Derived — nothing asserted. */
export function summarizeStrategy(policy: StrategyPolicy): RunStrategySummary {
  return {
    kind: policy.kind,
    policyId: policy.policyId,
    candidateCount: policy.candidateCount,
    partialCompletion: policy.partialCompletion,
    selectionRule: policy.selectionRule,
  };
}

/**
 * ESTIMATE VERSUS OBSERVED, summarized.
 *
 * The only way an estimator is ever calibrated is by comparing what it predicted against
 * what the provider charged, and until now that comparison had to be reconstructed by
 * hand after a run went wrong. Twice it was, and twice it found a systematic error — one
 * in each direction.
 *
 * Bounded on purpose: a handful of ratios, never the per-turn series and never a prompt.
 * `ratio` is estimate ÷ observed, so above 1 is conservative and below 1 is the
 * dangerous direction.
 */
export interface RunEstimateCalibrationSummary {
  /** Invocations where the provider reported input usage AND we had an estimate. */
  readonly comparableInvocations: number;
  /** Largest estimate ÷ observed. The most conservative moment. */
  readonly maxOverestimateRatio: number;
  /** Smallest estimate ÷ observed. Below 1 means we undercounted a real request. */
  readonly minRatio: number;
  /** Mean ratio across comparable invocations. */
  readonly meanRatio: number;
  /** The estimator these predictions came from. */
  readonly charsPerToken: number;
  readonly estimatorProvenance: string;
}

/** Compare estimates against observed usage. Returns undefined when nothing is comparable. */
export function summarizeEstimateCalibration(
  invocations: readonly V2InvocationRecord[],
  charsPerToken: number,
  estimatorProvenance: string,
): RunEstimateCalibrationSummary | undefined {
  const ratios: number[] = [];
  for (const inv of invocations) {
    const observed = inv.usage?.promptTokens;
    if (inv.estimatedInputTokens === undefined || observed === undefined || observed <= 0) continue;
    ratios.push(inv.estimatedInputTokens / observed);
  }
  if (ratios.length === 0) return undefined;
  return {
    comparableInvocations: ratios.length,
    maxOverestimateRatio: Number(Math.max(...ratios).toFixed(4)),
    minRatio: Number(Math.min(...ratios).toFixed(4)),
    meanRatio: Number((ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(4)),
    charsPerToken,
    estimatorProvenance,
  };
}

/**
 * The EXECUTION ENVELOPE this attempt's builder ran inside.
 *
 * Here so that swapping models is an observable act rather than a mystery. Every number
 * is derived from the capability facts of the model resolved for THIS run, so the same
 * engine on an 8k local model and a 200k frontier model produces two different envelopes
 * and no different code path. An operator comparing two receipts can see exactly which
 * facts changed and what the engine did about them.
 *
 * `estimator` is carried because a token count that is a heuristic must never be read as
 * a measurement — and because the day a real tokenizer arrives, the receipts will say so.
 */
export interface RunContextEnvelopeSummary {
  readonly contextWindowTokens: number;
  readonly reservedCompletionTokens: number;
  readonly reservedOverheadTokens: number;
  readonly safetyMarginTokens: number;
  /** The ceiling a rendered request had to stay under. */
  readonly maxRenderedInputTokens: number;
  readonly estimator: string;
  /** Where the context-window fact came from. */
  readonly capabilityProvenance: string;
  /** Every fold, in order. Empty when the conversation always fitted. */
  readonly compactions: readonly CompactionEvent[];
  /** Turns the builder actually executed. */
  readonly turnsExecuted: number;
  /** The largest request it estimated — how close the run came to its own ceiling. */
  readonly maxEstimatedInputTokens: number;
  /**
   * Read-only commands the builder re-ran against a candidate it had not changed.
   * Reported so wasted exploration is visible; nothing is ever refused because of it.
   */
  readonly repeatedCommands: number;
  /** Estimate-vs-observed calibration, when any invocation reported input usage. */
  readonly calibration?: RunEstimateCalibrationSummary;
}

/** Summarize the envelope. Carries no prompt text, no source, no secret. */
export function summarizeContextEnvelope(
  ceiling: ConversationCeiling,
  compactions: readonly CompactionEvent[],
  turnsExecuted: number,
  maxEstimatedInputTokens: number,
  repeatedCommands: number,
  calibration: RunEstimateCalibrationSummary | undefined,
): RunContextEnvelopeSummary {
  return {
    contextWindowTokens: ceiling.contextWindowTokens,
    reservedCompletionTokens: ceiling.reservedCompletionTokens,
    reservedOverheadTokens: ceiling.reservedOverheadTokens,
    safetyMarginTokens: ceiling.safetyMarginTokens,
    maxRenderedInputTokens: ceiling.maxRenderedInputTokens,
    estimator: ceiling.estimator,
    capabilityProvenance: ceiling.capabilityProvenance,
    compactions,
    turnsExecuted,
    maxEstimatedInputTokens,
    repeatedCommands,
    ...(calibration !== undefined ? { calibration } : {}),
  };
}

/**
 * The BOUNDS this attempt's builder actually ran under.
 *
 * On the receipt because the turn budget became operator-settable, and a number an
 * operator can change is a number a receipt has to state. Without it, "why did this run
 * cost four times the last one?" is answerable only by knowing what the environment
 * happened to hold at the time — which is exactly the sort of thing a receipt exists to
 * stop being folklore.
 *
 * Every bound is carried, not just the settable one, so the record also shows what did
 * NOT move: raising turns leaves tools, mutations and commands where they were.
 */
export interface RunBuilderBudgetSummary {
  readonly maxTurns: number;
  /** `operator_env` when `IKBI_V2_MAX_BUILDER_TURNS` set it; `default` when shipped. */
  readonly turnSource: BuilderTurnSource;
  readonly maxToolCalls: number;
  /** `operator_env` when `IKBI_V2_MAX_TOOL_CALLS` set it; `default` when shipped. */
  readonly toolCallSource: BuilderBoundSource;
  readonly maxMutations: number;
  readonly maxCommands: number;
  /** `operator_env` when `IKBI_V2_MAX_COMMANDS` set it; `default` when shipped. */
  readonly commandSource: BuilderBoundSource;
  readonly maxOutputTokens: number;
  readonly turnTimeoutMs: number;
}

/** Summarize the frozen builder budget. `turnSource` is derived, never guessed at read time. */
export function summarizeBuilderBudget(
  budget: BuilderBudget,
  turnSource: BuilderTurnSource,
  toolCallSource: BuilderBoundSource,
  commandSource: BuilderBoundSource,
): RunBuilderBudgetSummary {
  return {
    maxTurns: budget.maxTurns,
    turnSource,
    maxToolCalls: budget.maxToolCalls,
    toolCallSource,
    maxMutations: budget.maxMutations,
    maxCommands: budget.maxCommands,
    commandSource,
    maxOutputTokens: budget.maxOutputTokens,
    turnTimeoutMs: budget.turnTimeoutMs,
  };
}

/**
 * ONE candidate's canonical evaluation, receipt-safe. Every loser stays visible here even after its
 * workspace is reclaimed — the evidence ids (candidate/verification/critic/disposition) are retained.
 */
export interface RunCandidateEvaluationSummary {
  readonly slot: number;
  readonly candidateId: string | null;
  readonly workspaceId: string | null;
  readonly status: string;
  readonly promotionEligible: boolean;
  readonly decision: string | null;
  readonly verificationId: string | null;
  readonly verificationVerdict: string | null;
  readonly criticId: string | null;
  readonly criticVerdict: string | null;
  readonly dispositionId: string | null;
  readonly knownCostMicroUsd: number;
  readonly hasUnknownCost: boolean;
  readonly mutationCount: number;
  readonly changedPathCount: number;
  readonly failureCode: string | null;
  /** Whether this candidate is the one selected for promotion. */
  readonly selected: boolean;
  /** The workspace cleanup outcome for a losing candidate (reclaimed/retained), or "retained" for the selected. */
  readonly workspaceCleanup: string;
}

/** THE winner selection, receipt-safe — the pure selector's immutable record. */
export interface RunSelectionSummary {
  readonly selectionId: string;
  readonly selectionRule: string;
  readonly selectedCandidateId: string | null;
  readonly reason: string;
  readonly candidateEvaluationIds: readonly string[];
  readonly eligiblePool: readonly string[];
}

/** Summarize a selection record for a receipt. Derived — nothing asserted. */
export function summarizeSelection(record: SelectionRecord): RunSelectionSummary {
  return {
    selectionId: record.selectionId,
    selectionRule: record.selectionRule,
    selectedCandidateId: record.selectedCandidateId ?? null,
    reason: record.reason,
    candidateEvaluationIds: [...record.candidateEvaluationIds],
    eligiblePool: [...record.eligiblePool],
  };
}

/**
 * The isolated workspace a run allocated, and what it observed there. Counts, identities
 * and the exact source binding — never file contents.
 */
export interface RunWorkspaceSummary {
  readonly workspaceId: string;
  readonly donorWorkspaceId: string;
  readonly baseCommit: string;
  readonly baseTree: string;
  readonly baseBranch: string;
  readonly sourceSnapshotId: string;
  readonly materializedEntries: number;
  readonly observations: number;
  /** How the workspace ended: discarded, retained, or a cleanup that did NOT finish. */
  readonly disposition: string;
  readonly dispositionDetail?: string;
}

/** Summarize a workspace for a receipt. Derived — nothing is asserted. */
export function summarizeWorkspace(input: {
  readonly workspace: V2WorkspaceRecord;
  readonly observations: number;
  readonly disposition: WorkspaceDisposition;
}): RunWorkspaceSummary {
  const detail =
    input.disposition.kind === "failed"
      ? `${input.disposition.attempted} failed: ${input.disposition.detail}`
      : input.disposition.kind === "retained"
        ? input.disposition.reason
        : undefined;
  return {
    workspaceId: input.workspace.workspaceId,
    donorWorkspaceId: input.workspace.donorWorkspaceId,
    baseCommit: input.workspace.source.baseCommit,
    baseTree: input.workspace.source.baseTree,
    baseBranch: input.workspace.source.baseBranch,
    sourceSnapshotId: input.workspace.source.sourceSnapshotId,
    materializedEntries: input.workspace.source.materializedEntries,
    observations: input.observations,
    disposition: input.disposition.kind,
    ...(detail !== undefined ? { dispositionDetail: detail } : {}),
  };
}

/** The durable account of ONE run: where it went, what it produced, how it ended. */
export interface V2RunReceipt {
  readonly receiptId: V2ReceiptId;
  readonly taskId: V2TaskId;
  readonly runId: V2RunId;
  readonly outcome: RunTerminalOutcome;
  readonly stagesEntered: readonly LifecycleStage[];
  readonly evidence: RunEvidenceSummary;
  /**
   * THE WRITE AUTHORITY this run held.
   *
   * On the receipt because it is a fact about what the run was ALLOWED to do, and a record of
   * what changed is not readable without it: "the build touched three files" means something
   * different under a two-file scope than under repository-wide authority. Absent only when
   * the run failed in preflight before a scope was validated — which is exactly the case where
   * there was no authority to record.
   */
  readonly mutationScope?: RunMutationScopeSummary;
  /** Absent when the run ended before configuration was established. */
  readonly configuration?: RunConfigurationSummary;
  /** Absent when the run ended before a route was authorized. */
  readonly resolution?: RunResolutionSummary;
  /** Absent when the run ended before context was assembled. */
  readonly context?: RunContextSummary;
  /** Absent when retrieval did not run. Present and empty when it ran and found nothing. */
  readonly retrieval?: RetrievalSummary;
  /**
   * Every model turn the builder took, in order. Empty when nothing reached a provider.
   *
   * V2-005 recorded ONE invocation because a run made one call. A builder takes as many
   * turns as the work needs, and a receipt that reported only the first — or only the
   * last — would understate what the run actually did and what it cost.
   */
  readonly invocations: readonly RunInvocationSummary[];
  /**
   * Every READ-ONLY command the builder ran, in order (V2-015). Empty when the terminal was
   * unused or unavailable. Each proves `workspaceUnchanged` (tree before == after).
   */
  readonly commands: readonly RunCommandSummary[];
  /**
   * V2-017 — the candidate strategy this attempt used. Absent only when the run failed before the
   * strategy was frozen. `single` is one candidate; `shadow`/`tournament` are >1.
   */
  readonly strategy?: RunStrategySummary;
  /**
   * The frozen builder bounds this attempt ran under. Present whenever the builder was
   * reached; absent when the run ended before candidate generation.
   */
  readonly builderBudget?: RunBuilderBudgetSummary;
  /**
   * The context window this attempt ran inside, and every fold it needed. Present
   * whenever the builder was reached.
   */
  readonly contextEnvelope?: RunContextEnvelopeSummary;
  /**
   * V2-017 — EVERY candidate the strategy generated, with its canonical evaluation. Losers stay
   * visible here even after their workspaces are reclaimed. Empty/absent for a failed-before-strategy
   * run; a single-candidate run lists exactly one (the same one as the singular `candidate` above).
   */
  readonly candidates?: readonly RunCandidateEvaluationSummary[];
  /** V2-017 — the ONE winner selection. Absent when the run failed before selection. */
  readonly selection?: RunSelectionSummary;
  /** Absent when preflight did not capture a source snapshot. */
  readonly sourceSnapshot?: SourceSnapshotSummary;
  /** Absent when no workspace was allocated. */
  readonly workspace?: RunWorkspaceSummary;
  /**
   * Absent unless the builder actually finished and a candidate was captured. A build
   * that failed mid-generation has invocations and possibly mutations, but no candidate —
   * and the receipt must not imply otherwise.
   */
  readonly candidate?: RunCandidateSummary;
  /**
   * Absent unless verification actually ran on a candidate. Present with a truthful
   * verdict (pass / fail / no_checks / candidate_drift / …) bound to the exact candidate
   * tree — never optimistic, always counted from the ledger.
   */
  readonly verification?: RunVerificationSummary;
  /**
   * Absent unless the critic actually judged the candidate. Present with a structured
   * semantic verdict and named material defects — a MODEL JUDGMENT (evidence, not proof),
   * bound to the exact candidate tree and verification the critic read.
   */
  readonly critic?: RunCriticSummary;
  /**
   * Absent unless the disposition authority actually adjudicated the candidate. Present with
   * the ONE lawful decision (acceptable_for_promotion / withhold / reject / quarantine), the
   * machine-readable reasons, and the derived flags — bound to the exact candidate,
   * verification, critic, and policy it weighed. `eligibleForPromotion=true` is an
   * authorization fact; NOTHING was promoted.
   */
  readonly disposition?: RunDispositionSummary;
  /**
   * Absent unless the promotion authority actually attempted publication. Present with the
   * landed facts — target branch, before/after ref, published tree (== candidate tree) —
   * ONLY when a publication landed (`accepted`). Its `degraded` flag marks a ref that moved
   * but whose post-CAS bookkeeping did not fully complete.
   */
  readonly promotion?: RunPromotionSummary;
  readonly startedAt: number;
  readonly endedAt: number;
}

/**
 * Count what a run actually produced. `promoted`/`repositoryMutated` are true only
 * when the run BOTH recorded a promotion AND terminalized as accepted — a recorded
 * promotion attempt that did not become the terminal outcome never reads as landed.
 */
export function summarizeEvidence(
  ledger: RunLedgerView,
  outcome: RunTerminalOutcome,
  commandsRun = 0,
  /**
   * The refs the promotion authority actually compared and swapped.
   *
   * `sourceRepositoryMutated` is a claim about the OPERATOR's repository, and a promotion is not
   * by itself a change to it: publishing a candidate whose tree equals the base tree is a lawful
   * no-op, and the CAS records `beforeRef === afterRef`. Without this, the field was a second copy
   * of `promoted` and read `true` for a run that moved nothing — a receipt asserting a mutation
   * that did not happen. `run.ts` always supplies this when a promotion landed; when it is absent
   * there is no ref evidence to judge by and the promotion fact is all that can be claimed.
   */
  promotionRefs?: { readonly beforeRef: string; readonly afterRef: string },
): RunEvidenceSummary {
  const accepted = outcome.kind === "accepted";
  const refMoved = promotionRefs === undefined ? true : promotionRefs.beforeRef !== promotionRefs.afterRef;
  return {
    commandsRun,
    configurationResolved: ledger.configurations.length > 0,
    modelResolutionCompleted: ledger.resolutions.length > 0,
    modelResolutions: ledger.resolutions.length,
    retrievalPerformed: ledger.retrievals.length > 0,
    contextAssemblyCompleted: ledger.contexts.length > 0,
    contextPackages: ledger.contexts.length,
    sourceSnapshotCaptured: ledger.snapshots.length > 0,
    sourceSnapshots: ledger.snapshots.length,
    workspacesAllocated: ledger.workspaces.length,
    observationsTaken: ledger.observations.length,
    mutationsApplied: ledger.mutations.length,
    providerInvoked: ledger.invocations.length > 0,
    invocations: ledger.invocations.length,
    candidatesCreated: ledger.candidates.length,
    verificationsPerformed: ledger.verifications.length,
    promotionsAttempted: ledger.promotions.length,
    promoted: accepted && ledger.promotions.length > 0,
    // The candidate workspace was written to iff a builder mutation was applied. This is
    // the model's work, in isolation — it says nothing about the operator's checkout.
    candidateMutated: ledger.mutations.length > 0,
    // The operator's repository. Reachable ONLY through a landed promotion (V2-011) that
    // produced an `accepted` outcome — and true exactly when the target ref actually moved, which
    // a no-op promotion (candidate tree == base tree) does not do.
    sourceRepositoryMutated: accepted && ledger.promotions.length > 0 && refMoved,
  };
}

// ---------------------------------------------------------------------------
// Run result
// ---------------------------------------------------------------------------

/** What the canonical run function returns to any caller (CLI, server, REPL, tests). */
export interface V2RunResult {
  readonly taskId: V2TaskId;
  readonly runId: V2RunId;
  readonly goal: string;
  readonly repoPath: string;
  readonly outcome: RunTerminalOutcome;
  /**
   * THE normalized configuration this run resolved — the single input a future model
   * resolver receives. Absent when the run failed before configuration was built.
   */
  readonly policy?: RuntimeModelPolicy;
  /**
   * THE authorized route for this run's demonstrated role. An authorization only —
   * no invocation has occurred. Absent when resolution did not complete.
   */
  readonly decision?: ModelResolutionDecision;
  /**
   * THE authorized context — published as a MANIFEST: every artifact's provenance,
   * observed digest, size and admission reason, without reproducing the repository into
   * terminals, logs and receipts. The full package (with content) is the assembler's
   * return value, and is what a future builder consumes at the same call site.
   */
  readonly context?: ContextManifest;
  /** The full records of every model turn this run performed, in order. */
  readonly invocations: readonly V2InvocationRecord[];
  /** The full records of every READ-ONLY command the builder ran, in order (V2-015). */
  readonly commands: readonly BuilderCommandRecord[];
  /**
   * The isolated workspace this run allocated, when one was (V2-016). Present so the SESSION can
   * reclaim a SUPERSEDED non-authoritative attempt's worktree under its cleanup policy — the
   * receipt/evidence identities are unaffected, only the on-disk material is reclaimed.
   */
  readonly workspace?: V2WorkspaceRecord;
  /** The candidate this run produced, when the builder finished and it was captured. */
  readonly candidate?: CandidateRecord;
  /** The verification this run performed, when a candidate reached verification. */
  readonly verification?: VerificationRecord;
  /** The critic judgment this run performed, when a candidate reached criticism. */
  readonly critic?: CriticRecord;
  /** The lawful disposition this run adjudicated, when a candidate reached disposition. */
  readonly disposition?: DispositionRecord;
  /** The publication this run landed, when an eligible candidate was actually promoted. */
  readonly promotion?: PromotionRecord;
  /** V2-017 — the ONE winner selection record, when the strategy reached selection. */
  readonly selection?: SelectionRecord;
  /** Every transition the run made, in order. The run's own account of itself. */
  readonly journal: readonly LifecycleTransition[];
  readonly receipt: V2RunReceipt;
}

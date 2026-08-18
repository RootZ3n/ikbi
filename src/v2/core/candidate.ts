/**
 * ikbi v2 — THE CANDIDATE CONTRACT.
 *
 * A candidate is the WORK PRODUCT: the exact state of an isolated workspace after the
 * builder finished generating. Everything else that has an id is deliberately not one —
 * a workspace is a place, an invocation is a call, a mutation is one write, and a model
 * response is an opinion. Only after the builder explicitly finishes does the thing that
 * verification will judge exist.
 *
 * WHAT A CANDIDATE MUST BE ABLE TO ANSWER, later, without re-reading anything:
 *
 *     "What changed BECAUSE OF THE MODEL, relative to the operator's exact starting state?"
 *
 * which is why the record binds both ends —
 *
 *     SourceSnapshot  +  BuilderMutations  =  CandidateState
 *
 * — and why source MATERIALIZATION is accounted separately from builder MUTATION.
 * Reproducing the operator's uncommitted work inside the workspace is setting up the
 * agreed starting state; it is not something the model did, and a candidate that counted
 * it would overstate the model's work by exactly the operator's work in progress.
 *
 * NO FILE BODIES. The record carries identities, paths and counts. The bytes are in the
 * retained workspace, which is where verification will look for them.
 */

import { contentDigest, type V2CandidateId, type V2DecisionDigest, type V2InvocationId, type V2MutationDigest, type V2RunId, type V2SnapshotDigest, type V2WorkspaceId } from "./identity.js";
import { runFailure, type RunFailure } from "./failure.js";

// ---------------------------------------------------------------------------
// The builder's own claim
// ---------------------------------------------------------------------------

/**
 * What the builder said when it finished. Deliberately NOT a verdict.
 *
 * The builder is allowed to believe it is done — that belief is what ends the loop — and
 * it is recorded verbatim as a CLAIM. It is never allowed to say the work is verified,
 * tested or correct, because verification is a different authority that has not run yet.
 * Keeping the two apart in the type is what stops a confident model from promoting
 * itself by wording.
 */
export interface BuilderCompletionClaim {
  /** The builder's own summary of what it did. Free text, bounded, untrusted. */
  readonly summary: string;
  /** The builder's belief about completeness. A belief, not a finding. */
  readonly believesComplete: boolean;
}

/** Max characters retained from a builder's summary. It is a note, not a report. */
export const MAX_COMPLETION_SUMMARY_CHARS = 2_000;

// ---------------------------------------------------------------------------
// Tree identity
// ---------------------------------------------------------------------------

/**
 * The exact repository state verification will inspect.
 *
 * `treeId` is a real git tree object over the whole candidate workspace — tracked
 * modifications, created files and deletions alike — so "the candidate state" is a thing
 * git itself can address rather than a claim v2 makes about itself. See
 * `runtime/candidate-capture.ts` for how it is produced without touching any
 * operator-visible index, branch or commit.
 */
export interface CandidateTreeIdentity {
  /** Git tree object id of the candidate workspace. */
  readonly treeId: string;
  /** The tree the workspace started from: HEAD's tree, before materialization. */
  readonly baseTreeId: string;
  /**
   * Digest over the materialized source state — the operator's uncommitted work as it was
   * reproduced. Recorded so the model's delta can be separated from the operator's.
   */
  readonly materializedStateDigest: string;
  /** True when the candidate tree differs from the state the builder started from. */
  readonly changed: boolean;
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/** How generation ended. Only `finished` produces a candidate. */
export type BuilderCompletionStatus = "finished";

/** Counts a receipt can state without inspecting anything. */
export interface CandidateGenerationMetadata {
  /** Model turns actually taken. */
  readonly turns: number;
  /** Tool calls actually dispatched, successful or not. */
  readonly toolCalls: number;
  /** Tool calls that FAILED — a stale write, a bad path, an unknown tool. */
  readonly toolFailures: number;
  readonly startedAt: number;
  readonly endedAt: number;
}

/**
 * THE immutable account of one candidate.
 *
 * Every id here is one a later authority can follow: the invocations are in the ledger,
 * the mutations are in the ledger, the workspace is retained on disk, and the tree is in
 * git. Nothing is asserted that cannot be checked.
 */
export interface CandidateRecord {
  readonly candidateId: V2CandidateId;
  readonly runId: V2RunId;
  /** The exact source state this candidate was built from. */
  readonly sourceSnapshotId: V2SnapshotDigest;
  readonly workspaceId: V2WorkspaceId;
  /** The ONE builder route this candidate was generated by. */
  readonly builderDecisionId: V2DecisionDigest;
  /** Every model turn, in order. */
  readonly invocationIds: readonly V2InvocationId[];
  /** Every applied builder mutation, in order. Source materialization is NOT here. */
  readonly mutationIds: readonly V2MutationDigest[];
  /** Distinct paths the builder mutated, sorted. */
  readonly changedPaths: readonly string[];
  readonly tree: CandidateTreeIdentity;
  readonly completion: BuilderCompletionStatus;
  readonly claim: BuilderCompletionClaim;
  readonly metadata: CandidateGenerationMetadata;
}

/**
 * Content address of a candidate: WHAT STATE IT STARTED FROM, and WHAT STATE IT PRODUCED.
 *
 * Deliberately nothing else. The run, the workspace, the model that wrote it, the number
 * of turns it took and the exact sequence of mutations are all PROVENANCE — they belong on
 * the record, where a later authority can read them, and they are all things that can
 * differ while the work is identical. Two models that arrive at the same tree from the
 * same source have produced the same candidate, and an identity that said otherwise would
 * hide exactly the fact a tournament exists to notice.
 *
 * The corollary is worth stating: a candidate id is NOT a unique event id. Re-running the
 * same task on unchanged source legitimately yields the same candidate, because it is the
 * same work.
 */
export function candidateDigest(input: {
  readonly sourceSnapshotId: V2SnapshotDigest;
  readonly tree: CandidateTreeIdentity;
}): V2CandidateId {
  return contentDigest("candidate", { sourceSnapshotId: input.sourceSnapshotId, treeId: input.tree.treeId });
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export const V2_BUILD_FAILURE_CODES = {
  turnLimitExceeded: "build.turn_limit_exceeded",
  toolLimitExceeded: "build.tool_limit_exceeded",
  mutationLimitExceeded: "build.mutation_limit_exceeded",
  stoppedWithoutFinishing: "build.stopped_without_finishing",
  contextExhausted: "build.context_exhausted",
  treeCaptureFailed: "build.candidate_tree_capture_failed",
  invocationFailed: "build.invocation_failed",
} as const;

/** Build a candidate-generation failure. Identities and counts only — never file bytes. */
export function buildFailure(input: {
  readonly code: string;
  readonly message: string;
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}): RunFailure {
  return runFailure({
    category: "build",
    code: input.code,
    message: input.message,
    stage: "candidate_generation",
    retryable: false,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  });
}

/** What capturing a candidate workspace's exact state produced. */
export type TreeCaptureResult =
  | { readonly ok: true; readonly tree: CandidateTreeIdentity }
  | { readonly ok: false; readonly failure: RunFailure };

// ---------------------------------------------------------------------------
// Receipt view
// ---------------------------------------------------------------------------

/** A receipt-safe account of a candidate. Ids, paths and counts; no bodies, no prompts. */
export interface RunCandidateSummary {
  readonly candidateId: string;
  readonly workspaceId: string;
  readonly sourceSnapshotId: string;
  readonly builderDecisionId: string;
  readonly treeId: string;
  readonly baseTreeId: string;
  readonly changed: boolean;
  readonly invocations: number;
  readonly invocationIds: readonly string[];
  readonly mutations: number;
  readonly mutationIds: readonly string[];
  readonly changedPaths: readonly string[];
  readonly turns: number;
  readonly toolCalls: number;
  readonly toolFailures: number;
  /** The builder's own words. A claim, labelled as one. */
  readonly claimSummary: string;
  readonly claimBelievesComplete: boolean;
}

export function summarizeCandidate(record: CandidateRecord): RunCandidateSummary {
  return {
    candidateId: record.candidateId,
    workspaceId: record.workspaceId,
    sourceSnapshotId: record.sourceSnapshotId,
    builderDecisionId: record.builderDecisionId,
    treeId: record.tree.treeId,
    baseTreeId: record.tree.baseTreeId,
    changed: record.tree.changed,
    invocations: record.invocationIds.length,
    invocationIds: record.invocationIds,
    mutations: record.mutationIds.length,
    mutationIds: record.mutationIds,
    changedPaths: record.changedPaths,
    turns: record.metadata.turns,
    toolCalls: record.metadata.toolCalls,
    toolFailures: record.metadata.toolFailures,
    claimSummary: record.claim.summary,
    claimBelievesComplete: record.claim.believesComplete,
  };
}

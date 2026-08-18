/**
 * ikbi v2 — THE WORKSPACE AND STATE-BOUND MUTATION AUTHORITIES.
 *
 * Two responsibilities, one file because they are inseparable in practice: a mutation is
 * only meaningful inside the workspace it was observed in.
 *
 *   WorkspaceAuthority          where does candidate work happen, and what exact source
 *                               state is it bound to?
 *   StateBoundMutationAuthority what were the bytes when we looked, and may this edit
 *                               proceed against them?
 *
 * THE RULE THIS EXISTS TO ENFORCE: no v2 component may write a repository or workspace
 * file except through `mutate`, and `mutate` requires an OBSERVATION — never a path.
 * There is deliberately no `writeFile(path, content)` anywhere in this contract, because
 * an API that can be called with only a path is an API that can overwrite work someone
 * else did between the read and the write.
 *
 *   observe  →  propose against that observation  →  re-read under lock
 *            →  identical? apply : STALE, and refuse
 *
 * A stale observation is never merged, never overwritten anyway, never silently
 * re-observed and never retried. The authority reports the truth and stops; deciding what
 * to do about it is a recovery concern that does not exist yet.
 *
 * OBSERVATIONS ARE WORKSPACE-SCOPED. Two candidate workspaces cut from the same base tree
 * hold byte-identical files, and an observation of one still may not authorize a mutation
 * in the other. That is what makes shadow and tournament candidates safe to add later
 * without either of them acquiring a private write path.
 *
 * This file is PURE: it declares contracts and performs binding validation. The I/O — git
 * worktrees, file reads, atomic writes, cross-process locks — lives in `src/v2/runtime/`,
 * adapting v1's proven primitives rather than reimplementing them.
 */

import { contentDigest, type V2MutationDigest, type V2ObservationDigest, type V2RunId, type V2WorkspaceId } from "./identity.js";
import { runFailure, type RunFailure } from "./failure.js";
import type { SourceSnapshot } from "./source.js";

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/** The lifecycle states a v2 workspace can be in, as this slice uses them. */
export type WorkspaceStatus = "allocated" | "discarded" | "retained";

/**
 * The exact source state a workspace was cut from.
 *
 * A BRANCH NAME IS NOT A BINDING — it moves. The commit and its tree are what a future
 * promotion must compare against, and they stay true even after the source repository
 * moves on.
 */
export interface WorkspaceSourceBinding {
  /** Absolute path of the target repository at allocation time. */
  readonly repositoryPath: string;
  /** The branch the workspace was based on and would promote into. */
  readonly baseBranch: string;
  /** The exact commit the workspace started from. */
  readonly baseCommit: string;
  /** The exact tree of that commit — content identity, independent of commit metadata. */
  readonly baseTree: string;
  /**
   * The SOURCE SNAPSHOT this workspace was materialized from — the operator-visible
   * starting state, which on a dirty checkout is NOT the same thing as HEAD. The commit
   * and tree above remain valuable ancestry; this is what the workspace actually holds.
   */
  readonly sourceSnapshotId: string;
  /** Proof the workspace really matches that snapshot, produced by verifying it. */
  readonly materializedStateDigest: string;
  /** How many delta entries were reproduced. Zero for a clean snapshot. */
  readonly materializedEntries: number;
}

/** The durable account of one allocated workspace. */
export interface V2WorkspaceRecord {
  readonly workspaceId: V2WorkspaceId;
  readonly runId: V2RunId;
  /**
   * The id the donor workspace manager assigned. Carried so an operator can find this
   * workspace with the existing `ikbi workspace ls` / `ikbi diff` tooling.
   */
  readonly donorWorkspaceId: string;
  readonly source: WorkspaceSourceBinding;
  /** Absolute path of the isolated worktree. Operator-facing, not part of any digest. */
  readonly path: string;
  readonly status: WorkspaceStatus;
  readonly allocatedAt: number;
}

/**
 * Content address of what a workspace IS, semantically: the source state it was cut from
 * and the run that owns it. The filesystem PATH is excluded — relocating a scratch root
 * does not change which source state a candidate is being built against.
 */
export function workspaceBindingDigest(record: Pick<V2WorkspaceRecord, "runId" | "source">): string {
  return contentDigest("artifact", {
    runId: record.runId,
    baseBranch: record.source.baseBranch,
    baseCommit: record.source.baseCommit,
    baseTree: record.source.baseTree,
    sourceSnapshotId: record.source.sourceSnapshotId,
  });
}

/** How a workspace ended. `failed` means cleanup did NOT complete — never claimed silently. */
export type WorkspaceDisposition =
  | { readonly kind: "discarded" }
  | { readonly kind: "retained"; readonly reason: string }
  | { readonly kind: "failed"; readonly attempted: "discard" | "retain"; readonly detail: string };

/** The workspace lifecycle seam. One implementation; no component allocates its own worktree. */
export interface WorkspaceAuthority {
  /**
   * Allocate an isolated workspace and materialize the run's source snapshot into it.
   *
   * The snapshot is REQUIRED: there is no way to ask for a workspace without saying what
   * source state it must hold, which is what stops a candidate from starting from a
   * different reality than the context that described it.
   */
  allocate(input: {
    readonly runId: V2RunId;
    readonly source: SourceSnapshot;
    readonly label?: string;
  }): Promise<WorkspaceAllocationResult>;
  discard(record: V2WorkspaceRecord): Promise<WorkspaceDisposition>;
  retain(record: V2WorkspaceRecord, reason: string): Promise<WorkspaceDisposition>;
}

export type WorkspaceAllocationResult =
  | { readonly ok: true; readonly workspace: V2WorkspaceRecord }
  | { readonly ok: false; readonly failure: RunFailure };

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

/**
 * The filesystem kinds the authority distinguishes. Deliberately NOT collapsed: an empty
 * regular file and a missing file are different states, and confusing them turns
 * "create" into "truncate".
 */
export type ObservedStateKind = "missing" | "empty" | "regular" | "directory" | "symlink";

/** The content identity of an observed path. Mode is not identity; content is. */
export interface ObservedState {
  readonly kind: ObservedStateKind;
  /** SHA-256 of the exact bytes (or of a symlink's raw target). Null when there are none. */
  readonly contentSha256: string | null;
  readonly byteLength: number | null;
  readonly symlinkTarget: string | null;
}

/**
 * One observation. THE capability a mutation must name.
 *
 * `observationId` is content-addressed over the workspace, the path and the observed
 * state, so the same bytes in a DIFFERENT workspace are a different observation — the
 * property that keeps future shadow/tournament candidates from authorizing each other's
 * edits. Observed BYTES are deliberately absent: they stay inside the authority, so a
 * caller cannot alter what it claims to have seen.
 */
export interface V2FileObservation {
  readonly observationId: V2ObservationDigest;
  readonly runId: V2RunId;
  readonly workspaceId: V2WorkspaceId;
  /** Workspace-relative, already normalized and confinement-checked. */
  readonly path: string;
  readonly state: ObservedState;
  readonly observedAt: number;
}

/** Content address of an observation: workspace + path + exact state. */
export function observationDigest(input: {
  readonly workspaceId: V2WorkspaceId;
  readonly path: string;
  readonly state: ObservedState;
}): V2ObservationDigest {
  return contentDigest("observation", {
    workspaceId: input.workspaceId,
    path: input.path,
    kind: input.state.kind,
    contentSha256: input.state.contentSha256,
    byteLength: input.state.byteLength,
    symlinkTarget: input.state.symlinkTarget,
  });
}

/** Do two states describe the same content? Mode is excluded — see `ObservedState`. */
export function sameObservedState(left: ObservedState, right: ObservedState): boolean {
  return (
    left.kind === right.kind &&
    left.contentSha256 === right.contentSha256 &&
    left.byteLength === right.byteLength &&
    left.symlinkTarget === right.symlinkTarget
  );
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

/**
 * The complete operation vocabulary. Three verbs, each requiring an observation.
 * Not an edit DSL: a partial edit is expressed by replacing with the complete resulting
 * bytes, which is what makes the compare-and-swap meaningful.
 */
export type MutationOperation =
  | { readonly kind: "create"; readonly content: Readonly<Uint8Array> }
  | { readonly kind: "replace"; readonly content: Readonly<Uint8Array> }
  | { readonly kind: "delete" };

/** The durable account of one applied mutation. */
export interface V2MutationRecord {
  readonly mutationId: V2MutationDigest;
  readonly runId: V2RunId;
  readonly workspaceId: V2WorkspaceId;
  /** The observation that authorized this write. */
  readonly observationId: V2ObservationDigest;
  readonly path: string;
  readonly operation: MutationOperation["kind"];
  readonly before: ObservedState;
  readonly after: ObservedState;
  /**
   * Whether the CONTENT actually differs. A replace with byte-identical content is an
   * applied, recorded mutation with `changed: false` — see the note on `mutate`.
   */
  readonly changed: boolean;
  readonly appliedAt: number;
}

/** Content address of a mutation: which observation authorized what transition. */
export function mutationDigest(input: Omit<V2MutationRecord, "mutationId" | "appliedAt">): V2MutationDigest {
  return contentDigest("mutation", {
    runId: input.runId,
    workspaceId: input.workspaceId,
    observationId: input.observationId,
    path: input.path,
    operation: input.operation,
    before: input.before,
    after: input.after,
  });
}

export type MutationOutcome =
  | { readonly ok: true; readonly record: V2MutationRecord }
  | { readonly ok: false; readonly failure: RunFailure };

export type ObservationOutcome =
  | { readonly ok: true; readonly observation: V2FileObservation }
  | { readonly ok: false; readonly failure: RunFailure };

/**
 * THE single state-bound mutation authority.
 *
 * Note what the signature makes impossible: `mutate` takes an OBSERVATION, not a path.
 * There is no overload, no escape hatch and no convenience wrapper — a caller that has
 * not looked cannot write.
 */
export interface StateBoundMutationAuthority {
  observe(input: {
    readonly runId: V2RunId;
    readonly workspace: V2WorkspaceRecord;
    readonly path: string;
  }): Promise<ObservationOutcome>;
  /**
   * Apply an operation against an observation.
   *
   * BYTE-IDENTICAL REPLACEMENT is an explicit decision, not an accident: it is APPLIED
   * and RECORDED, with `changed: false`. Rejecting it would make a legitimate idempotent
   * write look like a failure; treating it as a change would make the record lie.
   */
  mutate(input: {
    readonly runId: V2RunId;
    readonly workspace: V2WorkspaceRecord;
    readonly observation: V2FileObservation;
    readonly operation: MutationOperation;
  }): Promise<MutationOutcome>;
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export const V2_WORKSPACE_FAILURE_CODES = {
  allocationFailed: "workspace.allocation_failed",
  sourceUnreadable: "workspace.source_unreadable",
  observationFailed: "workspace.observation_failed",
  pathEscapesWorkspace: "workspace.path_escapes_workspace",
  unsupportedTargetKind: "workspace.unsupported_target_kind",
  workspaceMismatch: "workspace.observation_workspace_mismatch",
  runMismatch: "workspace.observation_run_mismatch",
  unknownObservation: "workspace.unknown_observation",
  staleObservation: "mutation.stale_observation",
  mutationRejected: "mutation.rejected",
  mutationIoFailure: "mutation.io_failure",
  contextDrift: "workspace.context_artifact_drift",
} as const;

/** Build a workspace/mutation failure. Never carries file CONTENT — only identities. */
export function workspaceFailure(input: {
  readonly code: string;
  readonly message: string;
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}): RunFailure {
  return runFailure({
    // Mutation and workspace faults share the `mutation` domain: both describe a state
    // the engine refused to write to, and neither is a build or provider fault.
    category: "mutation",
    code: input.code,
    message: input.message,
    stage: "candidate_strategy",
    retryable: false,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  });
}

// ---------------------------------------------------------------------------
// Binding validation (pure)
// ---------------------------------------------------------------------------

/**
 * Refuse an observation that does not belong to this run AND this workspace.
 *
 * Checked before any I/O. An observation of the same path with the same bytes in a
 * sibling candidate workspace is still the wrong capability, and saying so is the whole
 * point: identical content is not identical authority.
 */
export function validateObservationBinding(input: {
  readonly runId: V2RunId;
  readonly workspace: V2WorkspaceRecord;
  readonly observation: V2FileObservation;
}): RunFailure | undefined {
  if (input.observation.runId !== input.runId) {
    return workspaceFailure({
      code: V2_WORKSPACE_FAILURE_CODES.runMismatch,
      message: `observation ${input.observation.observationId} belongs to a different run`,
      detail: { observationId: input.observation.observationId, path: input.observation.path },
    });
  }
  if (input.observation.workspaceId !== input.workspace.workspaceId) {
    return workspaceFailure({
      code: V2_WORKSPACE_FAILURE_CODES.workspaceMismatch,
      message:
        `observation ${input.observation.observationId} was taken in workspace ${input.observation.workspaceId} ` +
        `and cannot authorize a mutation in ${input.workspace.workspaceId} — identical bytes are not identical authority`,
      detail: {
        observationId: input.observation.observationId,
        observedIn: input.observation.workspaceId,
        mutatingIn: input.workspace.workspaceId,
        path: input.observation.path,
      },
    });
  }
  if (input.workspace.runId !== input.runId) {
    return workspaceFailure({
      code: V2_WORKSPACE_FAILURE_CODES.runMismatch,
      message: `workspace ${input.workspace.workspaceId} belongs to a different run`,
      detail: { workspaceId: input.workspace.workspaceId },
    });
  }
  return undefined;
}

/** The stale-observation failure. Carries state IDENTITIES, never file contents. */
export function staleObservationFailure(input: {
  readonly workspaceId: V2WorkspaceId;
  readonly observationId: V2ObservationDigest;
  readonly path: string;
  readonly expected: ObservedState;
  readonly actual: ObservedState;
}): RunFailure {
  return workspaceFailure({
    code: V2_WORKSPACE_FAILURE_CODES.staleObservation,
    message:
      `the workspace state of ${input.path} changed after it was observed: expected ` +
      `${input.expected.kind}/${input.expected.contentSha256 ?? "none"}, found ${input.actual.kind}/${input.actual.contentSha256 ?? "none"}`,
    detail: {
      workspaceId: input.workspaceId,
      observationId: input.observationId,
      path: input.path,
      expectedKind: input.expected.kind,
      expectedSha256: input.expected.contentSha256 ?? "none",
      actualKind: input.actual.kind,
      actualSha256: input.actual.contentSha256 ?? "none",
    },
  });
}

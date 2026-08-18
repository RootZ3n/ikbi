/**
 * ikbi v2 — THE CANONICAL SOURCE SNAPSHOT AUTHORITY.
 *
 * ONE RUN = ONE SOURCE SNAPSHOT. A `SourceSnapshot` is the authoritative answer to
 * "exactly what repository state did this run start from?", and every downstream
 * component — context assembly, workspace materialization, and later retrieval and the
 * builder — reads that answer instead of asking the filesystem again.
 *
 * WHY THIS EXISTS. Before it, two components disagreed about what "the source" meant:
 * context assembly read the operator's WORKING TREE while workspace allocation cut a
 * worktree from HEAD. On a clean checkout those agree; on a dirty one they do not, and
 * v2 correctly refused to proceed rather than let a model reason about bytes the
 * workspace did not contain. Refusing is safe but useless — an operator with
 * work-in-progress is the normal case, not an error.
 *
 * WHAT THE SNAPSHOT IS. Git already knows the truth, so the snapshot uses git's own
 * categories rather than inventing its own: HEAD is the immutable base, and the snapshot
 * records the DELTA the operator currently sees on top of it — tracked modifications,
 * tracked deletions, and untracked files git does not ignore. Only the delta's bytes are
 * captured; everything unchanged is served from HEAD, which cannot drift.
 *
 * THAT CHOICE IS ALSO THE DRIFT POLICY. Because reads resolve to either captured delta
 * bytes or an immutable HEAD blob, a source repository that changes mid-run cannot leak
 * into either context or the workspace. There is no recapture, silent or otherwise: the
 * run stays bound to the state it started from.
 *
 * MATERIALIZATION IS NOT MUTATION. Reproducing the operator's existing uncommitted work
 * inside an isolated workspace is setting up the agreed starting state. It is not a
 * model-produced edit and never counts as one — see `runtime/source-materializer.ts` and
 * the receipt's separate `sourceSnapshot` block.
 *
 * This file is PURE: contracts, policy vocabulary and identity. The git work lives in
 * `src/v2/runtime/`.
 */

import { contentDigest, type V2SnapshotDigest } from "./identity.js";
import { runFailure, type RunFailure } from "./failure.js";

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/**
 * How one path differs from HEAD. `unchanged` files are deliberately NOT enumerated:
 * HEAD already describes them, and listing a whole tree would make the snapshot's size
 * a function of the repository rather than of the operator's work in progress.
 */
export type SourceEntryStatus = "modified" | "deleted" | "untracked";

/** The filesystem kinds a snapshot entry can have. Mirrors the observation vocabulary. */
export type SourceEntryKind = "regular" | "empty" | "symlink" | "deleted";

/** One path the operator has changed relative to HEAD. */
export interface SourceEntry {
  /** Repository-relative, forward-slashed, canonical. */
  readonly path: string;
  readonly status: SourceEntryStatus;
  readonly kind: SourceEntryKind;
  /** SHA-256 of the exact bytes (or of a symlink's raw target). Null for a deletion. */
  readonly contentSha256: string | null;
  readonly byteLength: number | null;
  /** Whether the file carries the executable bit — a real source fact git tracks. */
  readonly executable: boolean;
  readonly symlinkTarget: string | null;
}

/** Why a path present on disk was left out of the snapshot. */
export type SourceExclusionReason = "git_ignored" | "git_internal" | "unsupported_type" | "unreadable";

/** One recorded exclusion. A snapshot can always explain what it left behind. */
export interface SourceExclusion {
  readonly path: string;
  readonly reason: SourceExclusionReason;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * The inclusion policy, recorded on every snapshot so it is visible rather than implied.
 *
 * The default is "what the operator currently sees": tracked modifications, tracked
 * deletions, and untracked files. Git's own ignore rules do the excluding — v2 does not
 * invent a second opinion about what counts as build debris, and does not scan for
 * secrets here.
 */
export interface SourceSnapshotPolicy {
  readonly includeTrackedModifications: boolean;
  readonly includeTrackedDeletions: boolean;
  readonly includeUntracked: boolean;
  /** Ignored files are excluded. Flipping this would be an operator decision, not a default. */
  readonly includeIgnored: boolean;
}

export const DEFAULT_SOURCE_POLICY: SourceSnapshotPolicy = Object.freeze({
  includeTrackedModifications: true,
  includeTrackedDeletions: true,
  includeUntracked: true,
  includeIgnored: false,
});

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/** Counts an operator (and a receipt) can read at a glance. */
export interface SourceSnapshotCounts {
  readonly modified: number;
  readonly deleted: number;
  readonly untrackedIncluded: number;
  readonly excluded: number;
}

/**
 * THE authoritative source state for one run. Immutable and content-addressed.
 *
 * `clean` means the delta is empty — HEAD alone describes what the operator sees.
 */
export interface SourceSnapshot {
  readonly snapshotId: V2SnapshotDigest;
  /** Absolute path of the repository. Operator-facing; NOT part of the identity. */
  readonly repositoryRoot: string;
  readonly headCommit: string;
  readonly headTree: string;
  readonly clean: boolean;
  readonly policy: SourceSnapshotPolicy;
  /** The delta vs HEAD, sorted by path. Empty for a clean checkout. */
  readonly entries: readonly SourceEntry[];
  /** What was deliberately left out, and why. */
  readonly exclusions: readonly SourceExclusion[];
  readonly counts: SourceSnapshotCounts;
  readonly capturedAt: number;
}

/**
 * Content address of the source state.
 *
 * Binds HEAD (the immutable base) and every included delta entry — path, status, kind,
 * content hash, executability and symlink target — in canonical path order. The
 * repository's location on disk and the capture time are excluded: the same work in a
 * different checkout is the same source state.
 */
export function sourceSnapshotDigest(input: {
  readonly headCommit: string;
  readonly headTree: string;
  readonly entries: readonly SourceEntry[];
  readonly policy: SourceSnapshotPolicy;
}): V2SnapshotDigest {
  return contentDigest("snapshot", {
    headCommit: input.headCommit,
    headTree: input.headTree,
    policy: input.policy,
    entries: [...input.entries]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((e) => ({
        path: e.path,
        status: e.status,
        kind: e.kind,
        contentSha256: e.contentSha256,
        byteLength: e.byteLength,
        executable: e.executable,
        symlinkTarget: e.symlinkTarget,
      })),
  });
}

// ---------------------------------------------------------------------------
// Reading through the snapshot
// ---------------------------------------------------------------------------

/** What a snapshot read produced. `missing` covers both "never existed" and "deleted". */
export type SourceReadOutcome =
  | {
      readonly ok: true;
      readonly content: string;
      readonly byteLength: number;
      readonly contentSha256: string;
      /** Where the bytes came from: the captured delta, or the immutable HEAD blob. */
      readonly origin: "snapshot_delta" | "head_blob";
    }
  | { readonly ok: false; readonly reason: "missing" | "not_a_regular_file" | "outside_repository" | "unreadable"; readonly detail: string };

/**
 * THE only way v2 reads repository content.
 *
 * A reader resolves a path against the snapshot — captured delta bytes, or the HEAD blob
 * — and never against the live working tree. That is what makes a mid-run edit to the
 * source repository incapable of reaching either context or the workspace.
 */
export interface SourceSnapshotReader {
  readonly snapshot: SourceSnapshot;
  read(path: string): Promise<SourceReadOutcome>;
}

/** The seam that captures source state. Exactly one implementation. */
export interface SourceSnapshotAuthority {
  capture(input: { readonly repoPath: string; readonly policy?: SourceSnapshotPolicy }): Promise<SourceCaptureResult>;
}

export type SourceCaptureResult =
  | { readonly ok: true; readonly reader: SourceSnapshotReader }
  | { readonly ok: false; readonly failure: RunFailure };

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export const V2_SOURCE_FAILURE_CODES = {
  captureFailed: "preflight.source_snapshot_failed",
  notAGitRepository: "preflight.source_not_a_git_repository",
  materializationFailed: "workspace.source_materialization_failed",
  materializationMismatch: "workspace.source_materialization_mismatch",
  snapshotMismatch: "workspace.source_snapshot_mismatch",
} as const;

/** Build a source failure. Carries paths and identities — never file contents. */
export function sourceFailure(input: {
  readonly code: string;
  readonly message: string;
  readonly stage: "preflight" | "candidate_strategy";
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}): RunFailure {
  return runFailure({
    category: input.stage === "preflight" ? "preflight" : "workspace",
    code: input.code,
    message: input.message,
    stage: input.stage,
    retryable: false,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  });
}

/** A receipt-safe account of the source state. Counts and identities, no contents. */
export interface SourceSnapshotSummary {
  readonly snapshotId: string;
  readonly headCommit: string;
  readonly headTree: string;
  readonly clean: boolean;
  readonly counts: SourceSnapshotCounts;
}

export function summarizeSnapshot(snapshot: SourceSnapshot): SourceSnapshotSummary {
  return {
    snapshotId: snapshot.snapshotId,
    headCommit: snapshot.headCommit,
    headTree: snapshot.headTree,
    clean: snapshot.clean,
    counts: snapshot.counts,
  };
}

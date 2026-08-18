/**
 * ikbi v2 — THE CANDIDATE DIFF: model-caused change, and nothing else.
 *
 * The critic must judge what the MODEL did, not what the operator had already done. The
 * builder starts from `candidate.tree.startTree` — HEAD plus the operator's materialized
 * uncommitted work — and produces `candidate.tree.treeId`. The diff between exactly those
 * two trees is the model's contribution:
 *
 *     diff( startTree , candidateTreeId )   ⇒   MODEL-CAUSED change
 *
 * NOT `diff(HEAD, candidate)`, which v1's critic used: on a dirty checkout that would
 * blame the model for the operator's own work in progress. If the operator had already
 * written `widget = 2` and the builder changed nothing, this diff is empty; if the
 * operator's dirty `B` became the builder's `C`, this diff is `B→C`.
 *
 * This file is PURE: the artifact shape, its content identity, and the seam. The git work
 * (diffing two tree objects that share an object store) lives in `runtime/candidate-diff.ts`.
 */

import { contentDigest, type V2CandidateId, type V2DiffDigest, type V2SnapshotDigest } from "./identity.js";

/** How one path changed between the two trees. */
export type DiffChangeKind = "added" | "modified" | "deleted";

/**
 * One changed file. The hunk TEXT is bounded and untrusted (it is repository content); its
 * hash is what participates in identity, so the diff's identity is stable while the text
 * can be truncated for the model without changing what the diff IS.
 */
export interface DiffFile {
  readonly path: string;
  readonly changeKind: DiffChangeKind;
  /** SHA-256 of the FULL unified-diff hunk for this file, before any excerpt truncation. */
  readonly hunkSha256: string;
  /** A bounded unified-diff excerpt for the model. Absent when omitted for size. */
  readonly hunk?: string;
  /** True when `hunk` was truncated or omitted for the per-file budget. */
  readonly truncated: boolean;
}

/**
 * THE immutable account of the model's change to a candidate. Content-addressed, so the
 * same model change from the same start is the same diff — a property a later disposition
 * or recovery authority can rely on.
 */
export interface CandidateDiff {
  readonly diffId: V2DiffDigest;
  readonly candidateId: V2CandidateId;
  readonly sourceSnapshotId: V2SnapshotDigest;
  /** The builder's starting tree (HEAD + operator materialized work). */
  readonly fromTree: string;
  /** The candidate tree. */
  readonly toTree: string;
  readonly files: readonly DiffFile[];
  /** True when the diff describes NO model-caused change (an empty, legitimate candidate). */
  readonly empty: boolean;
  /** True when files were dropped for the whole-diff budget. */
  readonly truncated: boolean;
}

/**
 * Content address of a candidate diff.
 *
 * Binds the endpoints (which start, which candidate) and, per file in path order, the
 * change kind and the FULL-hunk hash — never the truncated excerpt text and never a clock.
 */
export function candidateDiffDigest(input: {
  readonly candidateId: V2CandidateId;
  readonly sourceSnapshotId: V2SnapshotDigest;
  readonly fromTree: string;
  readonly toTree: string;
  readonly files: readonly DiffFile[];
}): V2DiffDigest {
  return contentDigest("candidate_diff", {
    candidateId: input.candidateId,
    sourceSnapshotId: input.sourceSnapshotId,
    fromTree: input.fromTree,
    toTree: input.toTree,
    files: [...input.files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => ({ path: f.path, changeKind: f.changeKind, hunkSha256: f.hunkSha256 })),
  });
}

/** Bounds on how much diff text is carried for the model. Separate from any token budget. */
export interface DiffBudget {
  /** Files above this many are summarized (path + kind) without a hunk. */
  readonly maxFilesWithHunks: number;
  /** Per-file hunk character cap. */
  readonly maxHunkChars: number;
}

export const DEFAULT_DIFF_BUDGET: DiffBudget = Object.freeze({ maxFilesWithHunks: 40, maxHunkChars: 4_000 });

/**
 * The diff seam. Given the two trees a candidate spans, produce the model-caused diff.
 * Implemented once, in the runtime layer, over git.
 */
export interface CandidateDiffSource {
  diff(input: {
    readonly workspacePath: string;
    readonly candidateId: V2CandidateId;
    readonly sourceSnapshotId: V2SnapshotDigest;
    readonly fromTree: string;
    readonly toTree: string;
    readonly budget: DiffBudget;
  }): Promise<CandidateDiff>;
}

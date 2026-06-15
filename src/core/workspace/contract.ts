/**
 * ikbi workspace primitive — THE FROZEN CORE disposable-workspace mechanism (contract).
 *
 * A workspace is an ISOLATED, DISPOSABLE execution space: a git worktree on a
 * scratch branch, off a target repo at a base ref. Work happens in it without
 * touching the real repo or other workspaces; the result is then either PROMOTED
 * (integrated into the target branch) or DISCARDED (torn down cleanly).
 *
 * This is the GENERAL primitive that later modules build on — competitive build
 * (N workspaces + a judge picks), trust-probation (a sandboxed agent confined to
 * a workspace), sandboxed experimentation, deterministic subagent spawning (each
 * gets its own), and the deferred concurrency feature (many at once). This phase
 * builds the PRIMITIVE + the seams, NOT those uses.
 *
 * SEAMS (documented for the modules that plug in later):
 *   - EVALUATION / JUDGE seam: a workspace's result can be assessed before
 *     promote. The caller runs the judge (async; it reads `diff()` / the worktree
 *     path) and passes a `WorkspaceEvaluation` to `promote`. The primitive does
 *     NOT call the judge — it ACCEPTS the verdict and refuses to promote without
 *     approval. (Competitive build evaluates N workspaces and promotes the winner.)
 *   - PROMOTE-GOVERNANCE seam: `promote` additionally accepts a `PromoteGovernance`
 *     decision (the gate / trust). A probation/sandboxed agent's workspace cannot
 *     promote unless governance allows — the primitive provides the seam; the
 *     gate enforcement is a later module.
 *
 * PROMOTE ATOMICITY (honest): git operations are not transactional, so promote is
 * built to be atomic AT THE REF LEVEL and to never leave a half-merged target:
 * the merge result is computed OFF-worktree (`git merge-tree --write-tree`), and
 * the ONLY target-mutating step is a single compare-and-swap `git update-ref`
 * (old->new). A clean fast-forward/merge lands atomically or fails cleanly; a
 * CONFLICTING merge is NOT auto-resolved — promote returns the conflict + diff for
 * governed resolution (the safe fallback), leaving the target untouched.
 */

import type { AgentIdentity } from "../provider/contract.js";

/** Semantic version of the workspace contract. Bump on breaking change. */
export const WORKSPACE_CONTRACT_VERSION = "1.0.0";

/** Scratch branch namespace — recognizable so crash-reclaim can find orphans. */
export const SCRATCH_BRANCH_PREFIX = "ikbi/ws/";

/**
 * Lifecycle states. The crash-durable intent states are internal:
 *   allocating -> allocated -> promoting -> promoted, with discarded/failed terminal.
 * "allocating" = record written before the worktree exists (crash-reclaimable).
 * "promoting"  = promote intent written before the CAS (crash-reconcilable).
 */
export type WorkspaceState = "allocating" | "allocated" | "promoting" | "promoted" | "discarded" | "failed";

/** Workspace ids must be safe in a filesystem path AND a git branch name. */
export const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/;

/** True if `id` is a structurally safe workspace id (no traversal / branch-unsafe chars). */
export function isValidWorkspaceId(id: string): boolean {
  return typeof id === "string" && id !== "." && id !== ".." && WORKSPACE_ID_PATTERN.test(id);
}

/** A live workspace handle (the isolated worktree + its lifecycle metadata). */
export interface WorkspaceHandle {
  readonly id: string;
  /** Absolute path to the TARGET git repo this workspace isolates from. */
  readonly targetRepo: string;
  /** Branch that `promote` integrates the result into. */
  readonly baseBranch: string;
  /** The commit the scratch branch started from (the isolation base). */
  readonly baseRef: string;
  /** The scratch branch holding the workspace's work (SCRATCH_BRANCH_PREFIX + id). */
  readonly scratchBranch: string;
  /** Absolute path to the isolated worktree (where work happens). */
  readonly path: string;
  /** The allocating identity (attribution). */
  readonly identity: AgentIdentity;
  readonly state: WorkspaceState;
  readonly createdAt: number;
  readonly label?: string;
}

/** The durable persisted record (handle + bookkeeping). */
export interface WorkspaceRecord extends WorkspaceHandle {
  readonly updatedAt: number;
  /** When promoted, the target head the result landed at. */
  readonly promotedTo?: string;
  /**
   * Promote intent, written BEFORE the CAS so a crash mid-promote is reconcilable:
   * on restart, if the target ref equals `afterRef` the landing is reconciled to
   * "promoted"; otherwise the promote did not land and the record reverts.
   */
  readonly promoteIntent?: { readonly beforeRef: string; readonly afterRef: string; readonly mergeCommit?: string };
  /** Set when the worktree of an already-promoted workspace was cleaned up. */
  readonly cleanedAt?: number;
  /**
   * Durability of the promote's normal RECEIPT (separate from this registry record, which is the
   * landing proof). "recorded" = the promote receipt appended; "failed" = the branch MOVED but the
   * receipt append failed afterwards (PROMOTED_BUT_RECEIPT_FAILED). When "failed", `ikbi undo` still
   * recovers from THIS record's `promoteIntent.beforeRef` / `promotedTo`. Searchable in status/ls.
   */
  readonly receiptStatus?: "recorded" | "failed";
  readonly note?: string;
}

export interface AllocateOptions {
  /** Absolute path to the target git repo. */
  readonly targetRepo: string;
  /** Attribution — the allocating agent identity. */
  readonly identity: AgentIdentity;
  /** Branch to base on + promote into. Default: the target repo's current branch. */
  readonly baseBranch?: string;
  readonly label?: string;
}

// ---------------------------------------------------------------------------
// Evaluation (judge) + governance (gate) seams
// ---------------------------------------------------------------------------

/** The judge's verdict on a workspace's result. Produced by a later module. */
export interface WorkspaceEvaluation {
  readonly approved: boolean;
  /** Optional score (e.g. for competitive ranking). */
  readonly score?: number;
  readonly reason?: string;
  /** Who/what produced the verdict (e.g. a critic agent id). */
  readonly evaluatorId?: string;
}

/** The gate's governance decision on a promote. Produced by a later module. */
export interface PromoteGovernance {
  readonly allow: boolean;
  readonly reason?: string;
  readonly gateId?: string;
}

/** What `promote` requires: a judge verdict (required) + optional governance + merge message. */
export interface PromoteApproval {
  readonly evaluation: WorkspaceEvaluation;
  readonly governance?: PromoteGovernance;
  readonly message?: string;
}

export type PromoteStrategy = "noop" | "fast_forward" | "merge";

/** Result of a promote. `promoted` is false on conflict (safe fallback: governed resolution). */
export interface PromoteResult {
  readonly promoted: boolean;
  readonly workspaceId: string;
  readonly targetBranch: string;
  /** Target head before promote (reversibility: undo = reset to this). */
  readonly beforeRef: string;
  /** Target head after promote (present when promoted). */
  readonly afterRef?: string;
  readonly mergeCommit?: string;
  readonly strategy?: PromoteStrategy;
  /** Files with merge conflicts (present when NOT promoted due to conflict). */
  readonly conflicts?: readonly string[];
  /**
   * Durability of the promote RECEIPT when `promoted` is true. "recorded" = the durable promote
   * receipt landed; "failed" = PROMOTED_BUT_RECEIPT_FAILED — the target ref MOVED but the receipt
   * append failed. A "failed" promote is NOT a clean success: the landing is real (recoverable from
   * the durable workspace registry record / `ikbi undo`), but the normal audit receipt is missing.
   * Absent when no receipt sink is wired (nothing to record).
   */
  readonly receiptStatus?: "recorded" | "failed";
  readonly reason?: string;
}

export interface DiscardResult {
  readonly workspaceId: string;
  readonly removed: boolean;
}

export interface ReclaimResult {
  readonly worktreesPruned: number;
  readonly branchesDeleted: number;
  readonly recordsReconciled: number;
}

/** A typed workspace failure. */
export class WorkspaceError extends Error {
  readonly kind: "limit" | "not_approved" | "git" | "not_found" | "invalid_state" | "config";
  constructor(kind: WorkspaceError["kind"], message: string, opts?: { cause?: unknown }) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "WorkspaceError";
    this.kind = kind;
  }
}

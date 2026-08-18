/**
 * CANDIDATE TREE CAPTURE — turning a workspace into an address verification can hold.
 *
 * THE MECHANISM, stated exactly because it touches git:
 *
 *     GIT_INDEX_FILE=<a fresh temp file>  git add -A
 *     GIT_INDEX_FILE=<that same file>     git write-tree
 *
 * `git add -A` stages every difference in the candidate worktree — modifications,
 * newly created files, and deletions alike — and `write-tree` turns that staging into a
 * real git tree object. The result is an id git itself can resolve, so "the candidate
 * state" is not a claim v2 makes about itself.
 *
 * WHY A THROWAWAY INDEX. The worktree has its own `.git/worktrees/<name>/index`, and
 * staging into it would leave the candidate checkout with everything staged — visible,
 * confusing, and a change to state an operator may later look at. Pointing
 * `GIT_INDEX_FILE` at a temp file leaves that index untouched and the temp file is
 * deleted afterwards. NOTHING is committed, no ref moves, no branch is created.
 *
 * WHAT THIS DOES WRITE. Blob and tree objects, into the object database the candidate
 * worktree shares with the source repository. That is unavoidable for any git-addressable
 * answer and is harmless: unreachable objects are the ordinary state of every repository
 * and are collected in due course. What is NOT written is anything an operator can see —
 * their working tree, HEAD, branches, index and stash are all untouched, which is the
 * property the tests actually assert.
 *
 * IGNORED FILES ARE EXCLUDED, because `git add -A` honours `.gitignore` — the same policy
 * the source snapshot already applies. Build output is not part of a candidate.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGit } from "../../core/workspace/git.js";
import { V2_BUILD_FAILURE_CODES, buildFailure, type TreeCaptureResult } from "../core/candidate.js";
import type { V2WorkspaceRecord } from "../core/workspace.js";

/**
 * Write a git tree object for a worktree's CURRENT state, via a throwaway index.
 *
 * Used twice: once at allocation, to record exactly what the builder starts from, and
 * once at finish, to record what it produced. Same mechanism both times, so the two ids
 * are directly comparable.
 */
export async function writeWorktreeTree(worktreePath: string): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), "ikbi-v2-candidate-index-"));
  const env = { GIT_INDEX_FILE: join(scratch, "index") } as const;
  try {
    // Seed from HEAD so `add -A` records DELETIONS as deletions rather than as an index
    // that simply never knew the file.
    await runGit(worktreePath, ["read-tree", "HEAD"], { env });
    await runGit(worktreePath, ["add", "-A"], { env });
    return (await runGit(worktreePath, ["write-tree"], { env })).stdout.trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Capture the exact state of a candidate workspace.
 *
 * `changed` compares the resulting tree against the tree the BUILDER started from — that
 * is, the base tree with the operator's materialized work already applied. Comparing
 * against HEAD instead would report the operator's uncommitted work as something the model
 * did, which is exactly the conflation the candidate record exists to prevent.
 */
export async function captureCandidateTree(workspace: V2WorkspaceRecord): Promise<TreeCaptureResult> {
  try {
    const treeId = await writeWorktreeTree(workspace.path);
    return {
      ok: true,
      tree: {
        treeId,
        baseTreeId: workspace.source.baseTree,
        startTree: workspace.source.startTree,
        materializedStateDigest: workspace.source.materializedStateDigest,
        // Compared against the tree recorded at ALLOCATION — HEAD plus the operator's
        // materialized work. Comparing against HEAD instead would report the operator's
        // uncommitted work as something the model did.
        changed: treeId !== workspace.source.startTree,
      },
    };
  } catch (err) {
    return {
      ok: false,
      failure: buildFailure({
        code: V2_BUILD_FAILURE_CODES.treeCaptureFailed,
        message: `could not capture the candidate tree for ${workspace.workspaceId}: ${err instanceof Error ? err.message : String(err)}`,
        detail: { workspaceId: workspace.workspaceId },
      }),
    };
  }
}

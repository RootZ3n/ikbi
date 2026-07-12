/**
 * ikbi worker-model — THE ADJUDICATION CORE (WorkProduct producer).
 *
 * Computes WHAT IS PHYSICALLY ON DISK in a build worktree from `git` — the ground truth that replaces
 * the builder's self-reported `filesWritten` ledger (which desyncs when files are produced via governed
 * `terminal`, or when the tool loop is cut off mid-write). The `treeHash` is a content identifier of the
 * ENTIRE working tree (tracked + untracked, .gitignore-respecting): identical content ⇒ identical hash,
 * any change ⇒ a different hash. It is what binds a verifier verdict to exactly the tree it judged.
 */

import type { WorkProduct } from "./contract.js";

/**
 * Minimal git surface. `env` lets the caller point `GIT_INDEX_FILE` at a throwaway index so a tree can
 * be written WITHOUT touching the worktree's real index or working tree. Injectable for tests.
 */
export type GitRunner = (args: readonly string[], opts?: { readonly env?: Readonly<Record<string, string>> }) => Promise<string>;

function sumNumstat(numstat: string): { insertions: number; deletions: number; tracked: number } {
  let insertions = 0;
  let deletions = 0;
  let tracked = 0;
  for (const line of numstat.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const [ins, del] = trimmed.split(/\t/);
    // Binary files show "-\t-"; count the file but not lines.
    if (ins !== undefined && ins !== "-") insertions += Number.parseInt(ins, 10) || 0;
    if (del !== undefined && del !== "-") deletions += Number.parseInt(del, 10) || 0;
    tracked += 1;
  }
  return { insertions, deletions, tracked };
}

/**
 * Compute the worktree's WorkProduct.
 *
 * `treeHash` is written from a THROWAWAY index (`GIT_INDEX_FILE = tempIndexPath`, built fresh via
 * `add -A`) so it reflects the full current content (tracked + untracked, .gitignore-respecting) without
 * mutating the real index.
 *
 * `nonEmpty` is the CONTENT truth — `candidateTree !== baseTree` (the throwaway tree hash vs the tree of
 * `baseRef`) — NOT `git status --porcelain`. This is load-bearing (Codex C1a): the worktree state and the
 * base state are compared as immutable tree objects, so `nonEmpty` agrees exactly with the thing that gets
 * promoted. `git status` is the wrong oracle in both directions: after the build COMMITS its edits to the
 * scratch branch, status shows a clean tree (nothing uncommitted) and would falsely report "no work" even
 * though the committed tree differs from base; conversely a stat-cache/mode/CRLF flutter can make status
 * dirty when the content tree is byte-identical to base. `filesChanged` still comes from `git status`
 * (untracked-inclusive telemetry); `insertions`/`deletions` from the tracked-file numstat vs `baseRef`.
 */
export async function computeWorkProduct(
  git: GitRunner,
  opts: { readonly baseRef: string; readonly tempIndexPath: string },
): Promise<WorkProduct> {
  // Tree hash of the FULL working tree, via a throwaway index (does not touch the real index/worktree).
  const env = { GIT_INDEX_FILE: opts.tempIndexPath };
  await git(["add", "-A"], { env });
  const treeHash = (await git(["write-tree"], { env })).trim();

  // The base's tree object — the content baseline `nonEmpty` compares against. `^{tree}` peels a commit
  // (or a ref/tree) to its tree, so this works whether baseRef is a commit sha, a branch, or a tree.
  const baseTree = (await git(["rev-parse", `${opts.baseRef}^{tree}`])).trim();
  const nonEmpty = treeHash !== baseTree;

  const porcelain = (await git(["status", "--porcelain"])).trim();
  const changedLines = porcelain.split(/\r?\n/).filter((l) => l.trim().length > 0);

  const numstat = (await git(["diff", "--numstat", opts.baseRef, "--", "."])).trim();
  const { insertions, deletions } = sumNumstat(numstat);

  return {
    treeHash,
    diffStat: { filesChanged: changedLines.length, insertions, deletions },
    nonEmpty,
  };
}

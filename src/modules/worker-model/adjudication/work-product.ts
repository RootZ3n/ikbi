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
 * `nonEmpty` and `filesChanged` come from `git status --porcelain` so a brand-new untracked file (the
 * common greenfield case — a whole new module) counts as work. `treeHash` is written from a THROWAWAY
 * index (`GIT_INDEX_FILE = tempIndexPath`, built fresh via `add -A`) so it reflects the full current
 * content without mutating the real index. `insertions`/`deletions` are the tracked-file numstat vs
 * `baseRef` (untracked additions are not double-counted there — they surface in `filesChanged`).
 */
export async function computeWorkProduct(
  git: GitRunner,
  opts: { readonly baseRef: string; readonly tempIndexPath: string },
): Promise<WorkProduct> {
  const porcelain = (await git(["status", "--porcelain"])).trim();
  const changedLines = porcelain.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const nonEmpty = changedLines.length > 0;

  // Tree hash of the FULL working tree, via a throwaway index (does not touch the real index/worktree).
  const env = { GIT_INDEX_FILE: opts.tempIndexPath };
  await git(["add", "-A"], { env });
  const treeHash = (await git(["write-tree"], { env })).trim();

  const numstat = (await git(["diff", "--numstat", opts.baseRef, "--", "."])).trim();
  const { insertions, deletions } = sumNumstat(numstat);

  return {
    treeHash,
    diffStat: { filesChanged: changedLines.length, insertions, deletions },
    nonEmpty,
  };
}

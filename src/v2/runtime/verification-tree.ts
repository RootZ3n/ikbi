/**
 * THE VERIFICATION TREE PROBE — the SAME git tree capture the candidate was frozen with.
 *
 * The whole point of the before/after rechecks is that they are comparable to
 * `candidate.tree.treeId`, and they only are if they are computed the identical way. So
 * this reuses `writeWorktreeTree` (a throwaway `GIT_INDEX_FILE` + `git add -A` +
 * `write-tree`, honouring `.gitignore`, touching no operator-visible index/branch/commit)
 * — the exact mechanism `candidate-capture.ts` used to mint the candidate tree id. Any
 * other tree computation could disagree for reasons that have nothing to do with drift.
 */

import { writeWorktreeTree } from "./candidate-capture.js";
import type { TreeProbe } from "../core/verification.js";

/** Build THE tree probe. Stateless — one is fine to share. */
export function createTreeProbe(): TreeProbe {
  return {
    treeOf(workspacePath: string): Promise<string> {
      return writeWorktreeTree(workspacePath);
    },
  };
}

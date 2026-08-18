/**
 * THE CANDIDATE DIFF adapter — `git diff <startTree> <candidateTree>`, bounded.
 *
 * Both trees are real git objects the candidate worktree's object store already holds
 * (`candidate-capture.ts` wrote the candidate tree; the start tree was written at
 * allocation). So the diff is a pure read of the object database — it checks out nothing,
 * touches no index, and cannot alter the candidate. `--find-renames` is deliberately OFF:
 * a rename shows as delete+add, which is the honest model-caused change and keeps the
 * per-file identity simple.
 */

import { createHash } from "node:crypto";

import { runGit } from "../../core/workspace/git.js";
import { candidateDiffDigest, type CandidateDiff, type CandidateDiffSource, type DiffChangeKind, type DiffFile } from "../core/candidate-diff.js";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Map a `git diff --name-status` status letter to the diff change kind. */
function changeKindOf(status: string): DiffChangeKind {
  if (status.startsWith("A")) return "added";
  if (status.startsWith("D")) return "deleted";
  return "modified";
}

/** Split a full `git diff` into per-file sections keyed by the b-side path. */
function splitByFile(fullDiff: string): Map<string, string> {
  const sections = new Map<string, string>();
  const parts = fullDiff.split(/(?=^diff --git )/m);
  for (const part of parts) {
    if (!part.startsWith("diff --git ")) continue;
    // `diff --git a/<path> b/<path>` — take the b-side path (post-change name).
    const m = /^diff --git a\/.+? b\/(.+)$/m.exec(part);
    if (m?.[1] !== undefined) sections.set(m[1].trim(), part);
  }
  return sections;
}

export function createCandidateDiffSource(): CandidateDiffSource {
  return {
    async diff(input): Promise<CandidateDiff> {
      // Trees are identical ⇒ the model changed nothing. A legitimate empty candidate.
      if (input.fromTree === input.toTree) {
        return {
          diffId: candidateDiffDigest({ candidateId: input.candidateId, sourceSnapshotId: input.sourceSnapshotId, fromTree: input.fromTree, toTree: input.toTree, files: [] }),
          candidateId: input.candidateId,
          sourceSnapshotId: input.sourceSnapshotId,
          fromTree: input.fromTree,
          toTree: input.toTree,
          files: [],
          empty: true,
          truncated: false,
        };
      }

      // The change SET (path + kind), independent of the hunk text.
      const nameStatus = (await runGit(input.workspacePath, ["diff", "--name-status", "--no-renames", input.fromTree, input.toTree])).stdout;
      const changed: { path: string; kind: DiffChangeKind }[] = [];
      for (const line of nameStatus.split("\n")) {
        if (line.trim().length === 0) continue;
        const tab = line.indexOf("\t");
        if (tab < 0) continue;
        changed.push({ path: line.slice(tab + 1).trim(), kind: changeKindOf(line.slice(0, tab)) });
      }
      changed.sort((a, b) => a.path.localeCompare(b.path));

      // The hunks, split per file. Diffing whole trees once is cheaper than N git calls.
      const full = (await runGit(input.workspacePath, ["diff", "--no-color", "--no-renames", input.fromTree, input.toTree])).stdout;
      const sections = splitByFile(full);

      const files: DiffFile[] = [];
      let truncated = false;
      changed.forEach((c, index) => {
        const hunk = sections.get(c.path) ?? "";
        const hunkSha256 = sha256(hunk);
        // Only the first N files carry a hunk; the rest are named without text.
        if (index >= input.budget.maxFilesWithHunks) {
          truncated = true;
          files.push({ path: c.path, changeKind: c.kind, hunkSha256, truncated: true });
          return;
        }
        const capped = hunk.length > input.budget.maxHunkChars;
        if (capped) truncated = true;
        files.push({
          path: c.path,
          changeKind: c.kind,
          hunkSha256,
          hunk: capped ? hunk.slice(0, input.budget.maxHunkChars) : hunk,
          truncated: capped,
        });
      });

      return {
        diffId: candidateDiffDigest({ candidateId: input.candidateId, sourceSnapshotId: input.sourceSnapshotId, fromTree: input.fromTree, toTree: input.toTree, files }),
        candidateId: input.candidateId,
        sourceSnapshotId: input.sourceSnapshotId,
        fromTree: input.fromTree,
        toTree: input.toTree,
        files,
        empty: files.length === 0,
        truncated,
      };
    },
  };
}

/**
 * THE CANDIDATE DIFF — model-caused change over real git trees.
 *
 * Real trees written via `writeWorktreeTree`, diffed by the adapter. The load-bearing
 * property: the diff spans start→candidate (NOT HEAD→candidate), so an operator's dirty
 * starting state is never attributed to the model.
 *
 * Capability: git (registered in scripts/test-runner.sh).
 */

import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { initGitRepo } from "../cli/fixture-repo.js";
import { writeWorktreeTree } from "./candidate-capture.js";
import { createCandidateDiffSource } from "./candidate-diff.js";
import type { V2CandidateId, V2SnapshotDigest } from "../core/identity.js";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const CANDIDATE = "cand".repeat(16) as V2CandidateId;
const SNAP = ("snap" + "0".repeat(60)) as V2SnapshotDigest;
const source = createCandidateDiffSource();
const budget = { maxFilesWithHunks: 40, maxHunkChars: 4000 };

/** A repo, its start tree, and a helper to write files + capture the candidate tree. */
function repo(files: Readonly<Record<string, string>>) {
  const dir = initGitRepo(files);
  dirs.push(dir);
  return dir;
}

test("diff: a one-line modification is reported as a modified file with a hunk", async () => {
  const dir = repo({ "src/a.ts": "export const a = 1;\n" });
  const from = await writeWorktreeTree(dir);
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
  const to = await writeWorktreeTree(dir);

  const diff = await source.diff({ workspacePath: dir, candidateId: CANDIDATE, sourceSnapshotId: SNAP, fromTree: from, toTree: to, budget });
  assert.equal(diff.empty, false);
  assert.equal(diff.files.length, 1);
  assert.equal(diff.files[0]?.path, "src/a.ts");
  assert.equal(diff.files[0]?.changeKind, "modified");
  assert.match(diff.files[0]?.hunk ?? "", /-export const a = 1;/);
  assert.match(diff.files[0]?.hunk ?? "", /\+export const a = 2;/);
});

test("diff: added and deleted files are classified", async () => {
  const dir = repo({ "keep.ts": "keep\n", "gone.ts": "gone\n" });
  const from = await writeWorktreeTree(dir);
  writeFileSync(join(dir, "new.ts"), "new\n");
  rmSync(join(dir, "gone.ts"));
  const to = await writeWorktreeTree(dir);

  const diff = await source.diff({ workspacePath: dir, candidateId: CANDIDATE, sourceSnapshotId: SNAP, fromTree: from, toTree: to, budget });
  const byPath = new Map(diff.files.map((f) => [f.path, f.changeKind]));
  assert.equal(byPath.get("new.ts"), "added");
  assert.equal(byPath.get("gone.ts"), "deleted");
});

test("diff: identical trees are an EMPTY model-caused diff", async () => {
  const dir = repo({ "a.ts": "a\n" });
  const tree = await writeWorktreeTree(dir);
  const diff = await source.diff({ workspacePath: dir, candidateId: CANDIDATE, sourceSnapshotId: SNAP, fromTree: tree, toTree: tree, budget });
  assert.equal(diff.empty, true);
  assert.deepEqual([...diff.files], []);
});

test("diff: MODEL-CAUSED ONLY — a change already present at the start is not attributed", async () => {
  // The 'start' tree already contains `a = 2` (the operator's dirty work). The candidate
  // ALSO has `a = 2` (the builder changed nothing). The diff must be empty — the operator's
  // work is not the model's.
  const dir = repo({ "a.ts": "a = 1\n" });
  writeFileSync(join(dir, "a.ts"), "a = 2\n"); // operator's dirty start
  const start = await writeWorktreeTree(dir);
  // builder changes nothing → candidate tree == start tree
  const candidateTree = await writeWorktreeTree(dir);
  const diff = await source.diff({ workspacePath: dir, candidateId: CANDIDATE, sourceSnapshotId: SNAP, fromTree: start, toTree: candidateTree, budget });
  assert.equal(diff.empty, true, "the operator's own change is not the model's");
});

test("diff: identity is deterministic and bound to the trees", async () => {
  const dir = repo({ "a.ts": "1\n" });
  const from = await writeWorktreeTree(dir);
  writeFileSync(join(dir, "a.ts"), "2\n");
  const to = await writeWorktreeTree(dir);
  const a = await source.diff({ workspacePath: dir, candidateId: CANDIDATE, sourceSnapshotId: SNAP, fromTree: from, toTree: to, budget });
  const b = await source.diff({ workspacePath: dir, candidateId: CANDIDATE, sourceSnapshotId: SNAP, fromTree: from, toTree: to, budget });
  assert.equal(a.diffId, b.diffId, "same trees, same diff identity");
  assert.match(a.diffId, /^[0-9a-f]{64}$/);
});

test("diff: a large hunk is truncated but the file is still reported", async () => {
  const dir = repo({ "big.ts": "x\n" });
  const from = await writeWorktreeTree(dir);
  writeFileSync(join(dir, "big.ts"), "y\n".repeat(5000));
  const to = await writeWorktreeTree(dir);
  const diff = await source.diff({ workspacePath: dir, candidateId: CANDIDATE, sourceSnapshotId: SNAP, fromTree: from, toTree: to, budget: { maxFilesWithHunks: 40, maxHunkChars: 200 } });
  assert.equal(diff.files[0]?.truncated, true);
  assert.ok((diff.files[0]?.hunk?.length ?? 0) <= 200);
  assert.equal(diff.truncated, true);
});

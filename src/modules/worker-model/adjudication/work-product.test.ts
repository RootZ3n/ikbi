import assert from "node:assert/strict";
import { test } from "node:test";

import { computeWorkProduct, type GitRunner } from "./work-product.js";

function fakeGit(responses: { porcelain?: string; writeTree?: string; numstat?: string }): {
  git: GitRunner;
  calls: Array<{ args: string[]; env?: Readonly<Record<string, string>> }>;
} {
  const calls: Array<{ args: string[]; env?: Readonly<Record<string, string>> }> = [];
  const git: GitRunner = async (args, opts) => {
    calls.push({ args: [...args], ...(opts?.env !== undefined ? { env: opts.env } : {}) });
    switch (args[0]) {
      case "status": return responses.porcelain ?? "";
      case "add": return "";
      case "write-tree": return `${responses.writeTree ?? "deadbeef"}\n`;
      case "diff": return responses.numstat ?? "";
      default: return "";
    }
  };
  return { git, calls };
}

const OPTS = { baseRef: "base-sha", tempIndexPath: "/tmp/adj.index" };

test("nonEmpty + filesChanged from porcelain; treeHash from write-tree", async () => {
  const { git } = fakeGit({
    porcelain: " M src/a.ts\n?? src/new.ts\n M src/b.ts",
    writeTree: "abc123tree",
    numstat: "10\t2\tsrc/a.ts\n5\t0\tsrc/b.ts",
  });
  const wp = await computeWorkProduct(git, OPTS);
  assert.equal(wp.nonEmpty, true);
  assert.equal(wp.treeHash, "abc123tree");
  assert.equal(wp.diffStat.filesChanged, 3);
  assert.equal(wp.diffStat.insertions, 15);
  assert.equal(wp.diffStat.deletions, 2);
});

test("empty worktree ⇒ nonEmpty false", async () => {
  const { git } = fakeGit({ porcelain: "", writeTree: "emptytree" });
  const wp = await computeWorkProduct(git, OPTS);
  assert.equal(wp.nonEmpty, false);
  assert.equal(wp.diffStat.filesChanged, 0);
});

test("untracked-only work (new module, all ?? lines) still counts as nonEmpty", async () => {
  const { git } = fakeGit({
    porcelain: "?? src/modules/abina/types.ts\n?? src/modules/abina/document.ts",
    writeTree: "newmoduletree",
  });
  const wp = await computeWorkProduct(git, OPTS);
  assert.equal(wp.nonEmpty, true);
  assert.equal(wp.diffStat.filesChanged, 2);
});

test("treeHash is written from a THROWAWAY index (GIT_INDEX_FILE), never the real one", async () => {
  const { git, calls } = fakeGit({ porcelain: " M src/a.ts", writeTree: "t" });
  await computeWorkProduct(git, OPTS);
  const add = calls.find((c) => c.args[0] === "add");
  const writeTree = calls.find((c) => c.args[0] === "write-tree");
  assert.equal(add?.env?.GIT_INDEX_FILE, "/tmp/adj.index", "add uses the throwaway index");
  assert.equal(writeTree?.env?.GIT_INDEX_FILE, "/tmp/adj.index", "write-tree uses the throwaway index");
  assert.deepEqual(add?.args, ["add", "-A"], "stages the full tree incl. untracked");
  // status/diff read the REAL tree (no override).
  const status = calls.find((c) => c.args[0] === "status");
  assert.equal(status?.env, undefined, "status reads the real worktree");
});

test("binary files (numstat '-') are counted without inflating line stats", async () => {
  const { git } = fakeGit({
    porcelain: " M img.png\n M src/a.ts",
    numstat: "-\t-\timg.png\n7\t1\tsrc/a.ts",
  });
  const wp = await computeWorkProduct(git, OPTS);
  assert.equal(wp.diffStat.insertions, 7);
  assert.equal(wp.diffStat.deletions, 1);
  assert.equal(wp.diffStat.filesChanged, 2);
});

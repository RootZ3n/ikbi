import assert from "node:assert/strict";
import { test } from "node:test";

import { computeWorkProduct, type GitRunner } from "./work-product.js";

function fakeGit(responses: { porcelain?: string; writeTree?: string; baseTree?: string; numstat?: string }): {
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
      case "rev-parse": return `${responses.baseTree ?? "basetree"}\n`;
      case "diff": return responses.numstat ?? "";
      default: return "";
    }
  };
  return { git, calls };
}

const OPTS = { baseRef: "base-sha", tempIndexPath: "/lab-fake/adj.index" };

test("nonEmpty from tree comparison; filesChanged from porcelain; treeHash from write-tree", async () => {
  const { git } = fakeGit({
    porcelain: " M src/a.ts\n?? src/new.ts\n M src/b.ts",
    writeTree: "abc123tree",
    baseTree: "basetree",
    numstat: "10\t2\tsrc/a.ts\n5\t0\tsrc/b.ts",
  });
  const wp = await computeWorkProduct(git, OPTS);
  assert.equal(wp.nonEmpty, true, "candidate tree differs from base tree ⇒ nonEmpty");
  assert.equal(wp.treeHash, "abc123tree");
  assert.equal(wp.diffStat.filesChanged, 3);
  assert.equal(wp.diffStat.insertions, 15);
  assert.equal(wp.diffStat.deletions, 2);
});

test("candidate tree === base tree ⇒ nonEmpty false (no real work)", async () => {
  const { git } = fakeGit({ porcelain: "", writeTree: "sametree", baseTree: "sametree" });
  const wp = await computeWorkProduct(git, OPTS);
  assert.equal(wp.nonEmpty, false);
});

// C1a regression — the two directions `git status` gets WRONG:

test("C1a: committed work with a CLEAN worktree still counts as nonEmpty (status would say no-work)", async () => {
  // After the build commits its edits to the scratch branch, `git status --porcelain` is empty — but the
  // committed tree differs from base. The OLD status-based nonEmpty falsely reported "no-work" here; the
  // tree comparison correctly sees the divergence. This is the real false-"no-work" C1a closes.
  const { git } = fakeGit({ porcelain: "", writeTree: "committedtree", baseTree: "basetree" });
  const wp = await computeWorkProduct(git, OPTS);
  assert.equal(wp.nonEmpty, true, "committed-but-clean-worktree work is NOT empty");
});

test("C1a: a dirty status whose content matches base ⇒ nonEmpty false (no promotable divergence)", async () => {
  // A stat-cache / mode / CRLF flutter can make `git status` show a file as modified while the content
  // tree is byte-identical to base. The OLD nonEmpty would say "there is work"; the tree comparison sees
  // there is nothing to promote.
  const { git } = fakeGit({ porcelain: " M src/a.ts", writeTree: "basetree", baseTree: "basetree" });
  const wp = await computeWorkProduct(git, OPTS);
  assert.equal(wp.nonEmpty, false, "byte-identical-to-base tree is empty regardless of status noise");
});

test("untracked-only work (new module) counts as nonEmpty via the tree hash", async () => {
  const { git } = fakeGit({
    porcelain: "?? src/modules/abina/types.ts\n?? src/modules/abina/document.ts",
    writeTree: "newmoduletree",
    baseTree: "basetree",
  });
  const wp = await computeWorkProduct(git, OPTS);
  assert.equal(wp.nonEmpty, true);
  assert.equal(wp.diffStat.filesChanged, 2);
});

test("nonEmpty compares against baseRef's TREE (peels the commit via ^{tree})", async () => {
  const { git, calls } = fakeGit({ porcelain: " M src/a.ts", writeTree: "t", baseTree: "b" });
  await computeWorkProduct(git, OPTS);
  const revParse = calls.find((c) => c.args[0] === "rev-parse");
  assert.deepEqual(revParse?.args, ["rev-parse", "base-sha^{tree}"], "peels baseRef to its tree object");
});

test("treeHash is written from a THROWAWAY index (GIT_INDEX_FILE), never the real one", async () => {
  const { git, calls } = fakeGit({ porcelain: " M src/a.ts", writeTree: "t", baseTree: "b" });
  await computeWorkProduct(git, OPTS);
  const add = calls.find((c) => c.args[0] === "add");
  const writeTree = calls.find((c) => c.args[0] === "write-tree");
  assert.equal(add?.env?.GIT_INDEX_FILE, "/lab-fake/adj.index", "add uses the throwaway index");
  assert.equal(writeTree?.env?.GIT_INDEX_FILE, "/lab-fake/adj.index", "write-tree uses the throwaway index");
  assert.deepEqual(add?.args, ["add", "-A"], "stages the full tree incl. untracked");
  // status/diff/rev-parse read the REAL tree (no override).
  const status = calls.find((c) => c.args[0] === "status");
  assert.equal(status?.env, undefined, "status reads the real worktree");
});

test("binary files (numstat '-') are counted without inflating line stats", async () => {
  const { git } = fakeGit({
    porcelain: " M img.png\n M src/a.ts",
    writeTree: "candidate",
    baseTree: "basetree",
    numstat: "-\t-\timg.png\n7\t1\tsrc/a.ts",
  });
  const wp = await computeWorkProduct(git, OPTS);
  assert.equal(wp.diffStat.insertions, 7);
  assert.equal(wp.diffStat.deletions, 1);
  assert.equal(wp.diffStat.filesChanged, 2);
});

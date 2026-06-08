/**
 * HB-2 acceptance: after a real promote, the target's working tree matches HEAD and
 * `git status` is clean (no phantom revert); a dirty checked-out target refuses the promote.
 */

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentIdentity } from "../core/provider/contract.js";
import { runGit } from "../core/workspace/git.js";
import { cleanup, makeGitRepo, makeManager } from "./harness.js";

const ID: AgentIdentity = { agentId: "lead", functionalRole: "operator", trustTier: "operator" };
const APPROVE = { evaluation: { approved: true }, governance: { allow: true } } as const;
const porcelain = async (repo: string): Promise<string> => (await runGit(repo, ["status", "--porcelain"])).stdout.trim();

test("HB-2: after promote, the target working tree == HEAD and `git status` is clean", async () => {
  const repo = await makeGitRepo();
  const { manager, root } = makeManager();
  try {
    const ws = await manager.allocate({ targetRepo: repo, identity: ID });
    await writeFile(join(ws.path, "feature.txt"), "feature\n");
    assert.equal(await manager.commit(ws, "add feature"), true);

    const r = await manager.promote(ws, APPROVE);
    assert.equal(r.promoted, true);

    assert.equal((await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim(), r.afterRef, "HEAD moved to the promoted ref");
    assert.equal(await porcelain(repo), "", "git status is clean — the working tree was synced to the new HEAD");
    assert.equal(await readFile(join(repo, "feature.txt"), "utf8"), "feature\n", "the promoted file is materialized in the working tree");
  } finally {
    await cleanup(repo, root);
  }
});

test("HB-2: a dirty checked-out target REFUSES the promote (no clobber, ref unmoved)", async () => {
  const repo = await makeGitRepo();
  const { manager, root } = makeManager();
  try {
    const ws = await manager.allocate({ targetRepo: repo, identity: ID });
    await writeFile(join(ws.path, "feature.txt"), "feature\n");
    await manager.commit(ws, "add feature");

    // Operator has uncommitted work in the target's main worktree.
    await writeFile(join(repo, "wip.txt"), "uncommitted\n");
    const before = (await runGit(repo, ["rev-parse", "main"])).stdout.trim();

    const r = await manager.promote(ws, APPROVE);
    assert.equal(r.promoted, false, "refused — never clobbers uncommitted work");
    assert.match(r.reason ?? "", /uncommitted changes/);
    assert.equal((await runGit(repo, ["rev-parse", "main"])).stdout.trim(), before, "the target ref was NOT moved");
    assert.equal(await readFile(join(repo, "wip.txt"), "utf8"), "uncommitted\n", "the operator's WIP is untouched");
  } finally {
    await cleanup(repo, root);
  }
});

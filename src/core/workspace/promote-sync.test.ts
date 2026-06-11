/**
 * Fix 3 (audit): after a successful promote, the target's checked-out working tree must be
 * brought in sync with the new HEAD — never left with HEAD ahead of the tree (a phantom
 * revert in `git status`). If the checked-out tree is dirty, promote refuses (clear report).
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino, type Logger } from "pino";

import type { AgentIdentity } from "../provider/contract.js";
import { LockManager } from "../substrate/lock.js";
import { DocumentStore } from "../substrate/store.js";
import type { WorkspaceRecord } from "./contract.js";
import { runGit, syncWorktreeToRef } from "./git.js";
import { WorkspaceManager } from "./manager.js";

const silent: Logger = pino({ level: "silent" });
const ID: AgentIdentity = { agentId: "builder-3", functionalRole: "builder", trustTier: "verified" };
const APPROVE = { evaluation: { approved: true }, governance: { allow: true } } as const;

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "ikbi-promsync-repo-"));
  await runGit(repo, ["init", "-b", "main", "--quiet"]);
  await runGit(repo, ["config", "user.email", "test@ikbi.local"]);
  await runGit(repo, ["config", "user.name", "ikbi test"]);
  await writeFile(join(repo, "README.md"), "initial\n");
  await runGit(repo, ["add", "-A"]);
  await runGit(repo, ["commit", "--quiet", "-m", "initial"]);
  return repo;
}

function makeManager() {
  const root = join(tmpdir(), `ikbi-promsync-ws-${randomBytes(8).toString("hex")}`);
  const locks = new LockManager({ logger: silent, defaultTimeoutMs: 5000, defaultStaleMs: 30_000 });
  const store = new DocumentStore<WorkspaceRecord>({ dir: join(root, "registry"), locks, logger: silent, fsync: false });
  const mgr = new WorkspaceManager({ root, max: 32, locks, store, logger: silent });
  return { mgr, root };
}

async function cleanup(repo: string, root: string): Promise<void> {
  await rm(repo, { recursive: true, force: true }).catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

const porcelain = async (repo: string) => (await runGit(repo, ["status", "--porcelain"])).stdout.trim();

test("after a fast-forward promote, the target working tree == HEAD and `git status` is clean", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
    await writeFile(join(ws.path, "feature.txt"), "feature\n");
    assert.equal(await mgr.commit(ws, "add feature"), true);

    const r = await mgr.promote(ws, APPROVE);
    assert.equal(r.promoted, true);
    assert.equal(r.strategy, "fast_forward");

    // The MAIN working tree (on `main`) is now in sync with the new HEAD:
    const head = (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
    assert.equal(head, r.afterRef, "HEAD moved to the promoted ref");
    assert.equal(await porcelain(repo), "", "git status is CLEAN — no phantom revert");
    // The promoted file is actually present in the target's working tree (not just in HEAD).
    const onDisk = (await runGit(repo, ["status", "--porcelain", "feature.txt"])).stdout.trim();
    assert.equal(onDisk, "", "feature.txt is materialized in the working tree, matching HEAD");
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(join(repo, "feature.txt"), "utf8"), "feature\n", "working-tree content equals the promoted blob");
  } finally {
    await cleanup(repo, root);
  }
});

test("after a MERGE promote, the target working tree is synced to the merge commit (clean status)", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
    // Target moves independently (clean tree after the commit).
    await writeFile(join(repo, "main-change.txt"), "main\n");
    await runGit(repo, ["add", "-A"]);
    await runGit(repo, ["commit", "--quiet", "-m", "main change"]);
    // Workspace does its own non-conflicting work.
    await writeFile(join(ws.path, "ws-change.txt"), "ws\n");
    await mgr.commit(ws, "ws change");

    const r = await mgr.promote(ws, APPROVE);
    assert.equal(r.promoted, true);
    assert.equal(r.strategy, "merge");
    const head = (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
    assert.equal(head, r.afterRef, "HEAD is the merge commit");
    assert.equal(await porcelain(repo), "", "git status is CLEAN after the merge promote");
  } finally {
    await cleanup(repo, root);
  }
});

test("promote REFUSES when the target branch is checked out with uncommitted changes (no clobber, no silent desync)", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
    await writeFile(join(ws.path, "feature.txt"), "feature\n");
    await mgr.commit(ws, "add feature");

    // The operator has uncommitted work in the target's main worktree.
    await writeFile(join(repo, "wip.txt"), "uncommitted work\n");
    const before = (await runGit(repo, ["rev-parse", "main"])).stdout.trim();

    const r = await mgr.promote(ws, APPROVE);
    assert.equal(r.promoted, false, "promote refused — never clobbers uncommitted work");
    assert.match(r.reason ?? "", /uncommitted changes/);
    assert.equal((await runGit(repo, ["rev-parse", "main"])).stdout.trim(), before, "the target ref was NOT moved");
    // The operator's uncommitted file is untouched.
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(join(repo, "wip.txt"), "utf8"), "uncommitted work\n");
  } finally {
    await cleanup(repo, root);
  }
});

// M7 (TOCTOU): syncWorktreeToRef runs AFTER the promote clean-check. If a user writes new
// uncommitted work into the tree in the window between the check and the destructive reset,
// `reset --hard` would clobber it. The fix stashes any late work FIRST (preserved, recoverable)
// and only then resets — never silent data loss.
test("M7: syncWorktreeToRef STASHES late uncommitted work before the reset (no clobber)", async () => {
  const repo = await makeRepo();
  try {
    const base = (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
    // Advance the ref we will sync the tree forward TO.
    await writeFile(join(repo, "advanced.txt"), "advanced\n");
    await runGit(repo, ["add", "-A"]);
    await runGit(repo, ["commit", "--quiet", "-m", "advance"]);
    const advanced = (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
    // Move the worktree back to base (so a sync-forward is a real change), then dirty it —
    // this simulates work that appeared AFTER promote's clean-check but BEFORE the reset.
    await runGit(repo, ["reset", "--hard", "--quiet", base]);
    await writeFile(join(repo, "late-work.txt"), "PRECIOUS uncommitted work\n");

    await syncWorktreeToRef(repo, advanced);

    // The tree is now AT the target ref and `git status` is clean (the reset happened).
    assert.equal((await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim(), advanced, "tree synced to the target ref");
    assert.equal(await porcelain(repo), "", "git status is clean after sync");
    // The late work was NOT clobbered — it is preserved in the stash list and recoverable.
    const stashList = (await runGit(repo, ["stash", "list"])).stdout.trim();
    assert.match(stashList, /auto-stashed late uncommitted work/, "late work was stashed, not destroyed");
    await runGit(repo, ["stash", "pop", "--quiet"]);
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(join(repo, "late-work.txt"), "utf8"), "PRECIOUS uncommitted work\n", "the stashed work is fully recoverable");
  } finally {
    await rm(repo, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("M7: syncWorktreeToRef on an already-clean tree resets with NO stash (unchanged fast path)", async () => {
  const repo = await makeRepo();
  try {
    const base = (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(repo, "next.txt"), "next\n");
    await runGit(repo, ["add", "-A"]);
    await runGit(repo, ["commit", "--quiet", "-m", "next"]);
    const next = (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
    await runGit(repo, ["reset", "--hard", "--quiet", base]); // clean tree at base

    await syncWorktreeToRef(repo, next);

    assert.equal((await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim(), next, "tree synced forward");
    assert.equal((await runGit(repo, ["stash", "list"])).stdout.trim(), "", "no stash created for a clean tree");
  } finally {
    await rm(repo, { recursive: true, force: true }).catch(() => undefined);
  }
});

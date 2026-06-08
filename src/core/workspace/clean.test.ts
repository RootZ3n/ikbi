/**
 * SG-7 (audit): worktree cleanup — promote removes the source worktree directory (keeping the
 * scratch branch so a post-build diff still works), discard removes it, and `cleanOrphans`
 * reclaims leftover worktree dirs of terminal workspaces.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino, type Logger } from "pino";

import type { AgentIdentity } from "../provider/contract.js";
import { LockManager } from "../substrate/lock.js";
import { DocumentStore } from "../substrate/store.js";
import { SCRATCH_BRANCH_PREFIX, type WorkspaceRecord } from "./contract.js";
import { listBranches, runGit } from "./git.js";
import { WorkspaceManager } from "./manager.js";

const silent: Logger = pino({ level: "silent" });
const ID: AgentIdentity = { agentId: "builder-3", functionalRole: "builder", trustTier: "verified" };
const APPROVE = { evaluation: { approved: true }, governance: { allow: true } } as const;

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}
async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "ikbi-clean-repo-"));
  await runGit(repo, ["init", "-b", "main", "--quiet"]);
  await runGit(repo, ["config", "user.email", "t@ikbi.local"]);
  await runGit(repo, ["config", "user.name", "ikbi test"]);
  await writeFile(join(repo, "README.md"), "base\n");
  await runGit(repo, ["add", "-A"]);
  await runGit(repo, ["commit", "--quiet", "-m", "base"]);
  return repo;
}
function makeManager() {
  const root = join(tmpdir(), `ikbi-clean-ws-${randomBytes(8).toString("hex")}`);
  const locks = new LockManager({ logger: silent, defaultTimeoutMs: 5000, defaultStaleMs: 30_000 });
  const store = new DocumentStore<WorkspaceRecord>({ dir: join(root, "registry"), locks, logger: silent, fsync: false });
  return { mgr: new WorkspaceManager({ root, max: 32, locks, store, logger: silent }), root, store };
}
async function cleanup(repo: string, root: string): Promise<void> {
  await rm(repo, { recursive: true, force: true }).catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

test("promote removes the source worktree DIRECTORY but keeps the scratch branch (diff still works)", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
    assert.ok(await exists(ws.path), "worktree dir exists after allocate");
    await writeFile(join(ws.path, "feature.txt"), "feature\n");
    await mgr.commit(ws, "add feature");

    const r = await mgr.promote(ws, APPROVE);
    assert.equal(r.promoted, true);
    assert.equal(await exists(ws.path), false, "the source worktree dir is removed on promote");
    // The scratch branch is KEPT so a post-build `ikbi diff <id>` can still compute base..scratch.
    assert.ok((await listBranches(repo, SCRATCH_BRANCH_PREFIX)).includes(ws.scratchBranch), "scratch branch kept");
    assert.ok((await mgr.diff(ws)).includes("feature.txt"), "the diff is still computable after promote");
    assert.ok((await mgr.get(ws.id))?.cleanedAt, "the promoted record notes the cleanup");
  } finally {
    await cleanup(repo, root);
  }
});

test("cleanOrphans reclaims a terminal workspace whose worktree dir lingered", async () => {
  const repo = await makeRepo();
  const { mgr, root, store } = makeManager();
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
    assert.ok(await exists(ws.path), "dir present");
    // Simulate a crash that left a TERMINAL record but never removed the worktree dir.
    await store.put(ws.id, { ...(await mgr.get(ws.id))!, state: "discarded" });

    const res = await mgr.cleanOrphans();
    assert.ok(res.removed >= 1, "an orphan was reclaimed");
    assert.equal(await exists(ws.path), false, "the lingering worktree dir is removed");
    assert.ok((await mgr.get(ws.id))?.cleanedAt, "the record is marked cleaned");

    // Idempotent: a second clean finds nothing to remove.
    const again = await mgr.cleanOrphans();
    assert.equal(again.removed, 0, "clean is idempotent");
  } finally {
    await cleanup(repo, root);
  }
});

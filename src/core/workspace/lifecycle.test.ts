/**
 * BLOCKER 3 (audit): state lifecycle — `ikbi diff` must surface UNCOMMITTED retained work,
 * `cleanOrphans` must NOT destroy retained work without --force, and `list` exposes records
 * (for `ikbi workspace ls`). These cover the manager-level fixes.
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
import type { WorkspaceRecord } from "./contract.js";
import { runGit } from "./git.js";
import { WorkspaceManager } from "./manager.js";

const silent: Logger = pino({ level: "silent" });
const ID: AgentIdentity = { agentId: "builder-9", functionalRole: "builder", trustTier: "verified" };

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}
async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "ikbi-life-repo-"));
  await runGit(repo, ["init", "-b", "main", "--quiet"]);
  await runGit(repo, ["config", "user.email", "t@ikbi.local"]);
  await runGit(repo, ["config", "user.name", "ikbi test"]);
  await writeFile(join(repo, "README.md"), "base\n");
  await runGit(repo, ["add", "-A"]);
  await runGit(repo, ["commit", "--quiet", "-m", "base"]);
  return repo;
}
function makeManager() {
  const root = join(tmpdir(), `ikbi-life-ws-${randomBytes(8).toString("hex")}`);
  const locks = new LockManager({ logger: silent, defaultTimeoutMs: 5000, defaultStaleMs: 30_000 });
  const store = new DocumentStore<WorkspaceRecord>({ dir: join(root, "registry"), locks, logger: silent, fsync: false });
  return { mgr: new WorkspaceManager({ root, max: 32, locks, store, logger: silent }), root };
}
async function cleanup(repo: string, root: string): Promise<void> {
  await rm(repo, { recursive: true, force: true }).catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

test("diff falls back to the WORKING-TREE diff for uncommitted retained work (not 'no changes')", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
    // The builder wrote a NEW (untracked) file and modified a tracked one — but never committed.
    await writeFile(join(ws.path, "index.html"), "<html>built before the timeout</html>\n");
    await writeFile(join(ws.path, "README.md"), "base\nedited by the build\n");
    await mgr.retain(ws, "build timed out");

    // The committed base..scratch range is empty (nothing was committed); the fallback must show it.
    const d = await mgr.diff(ws);
    assert.ok(d.trim().length > 0, "diff is NOT empty for uncommitted retained work");
    assert.ok(d.includes("index.html"), "the untracked new file appears in the diff");
    assert.ok(d.includes("built before the timeout"), "its content appears");
    assert.ok(d.includes("README.md"), "the tracked modification appears");
  } finally {
    await cleanup(repo, root);
  }
});

test("cleanOrphans({force:false}) PRESERVES retained work; {force:true} sweeps it", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
    await writeFile(join(ws.path, "index.html"), "<html>work</html>\n");
    await mgr.retain(ws, "build timed out");
    assert.ok(await exists(ws.path), "retained worktree present");

    // Without force, the retained worktree is PRESERVED (the only copy of its uncommitted work).
    const safe = await mgr.cleanOrphans({ force: false });
    assert.equal(safe.removed, 0, "no retained worktree removed without --force");
    assert.ok(safe.skipped >= 1, "the retained workspace is reported as skipped");
    assert.ok(safe.skippedIds.includes(ws.id), "by id");
    assert.ok(await exists(ws.path), "the retained worktree still exists");

    // With force, it is swept.
    const forced = await mgr.cleanOrphans({ force: true });
    assert.ok(forced.removed >= 1, "--force removes the retained worktree");
    assert.equal(await exists(ws.path), false, "the worktree dir is gone after --force");
  } finally {
    await cleanup(repo, root);
  }
});

test("list() exposes retained workspaces with their on-disk path", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
    await writeFile(join(ws.path, "index.html"), "<html>work</html>\n");
    await mgr.retain(ws, "build timed out");

    const records = await mgr.list();
    const rec = records.find((r) => r.id === ws.id);
    assert.ok(rec !== undefined, "the retained workspace is listed");
    assert.equal(rec?.state, "failed");
    assert.equal(rec?.path, ws.path, "with its on-disk path");
    assert.match(rec?.note ?? "", /retained: build timed out/);
  } finally {
    await cleanup(repo, root);
  }
});

/**
 * ikbi workspace — isolation properties (Phase 5 external repo readiness).
 *
 * Verifies that worktrees do not share state with each other or the parent repo,
 * that path confinement prevents escaping the workspace root, and that stale
 * worktrees from interrupted builds are correctly detected and handled.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";

import { pino, type Logger } from "pino";

import type { AgentIdentity } from "../provider/contract.js";
import { LockManager } from "../substrate/lock.js";
import { DocumentStore } from "../substrate/store.js";
import { WorkspaceError, type WorkspaceRecord } from "./contract.js";
import { runGit } from "./git.js";
import { WorkspaceManager } from "./manager.js";

const silent: Logger = pino({ level: "silent" });
const ID: AgentIdentity = { agentId: "builder-iso", functionalRole: "builder", trustTier: "verified" };
const APPROVE = { evaluation: { approved: true }, governance: { allow: true } } as const;

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function makeRepo(name = "iso"): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), `ikbi-${name}-repo-`));
  await runGit(repo, ["init", "-b", "main", "--quiet"]);
  await runGit(repo, ["config", "user.email", "t@ikbi.local"]);
  await runGit(repo, ["config", "user.name", "ikbi test"]);
  await writeFile(join(repo, "README.md"), "base\n");
  await runGit(repo, ["add", "-A"]);
  await runGit(repo, ["commit", "--quiet", "-m", "base"]);
  return repo;
}

function makeManager() {
  const root = join(tmpdir(), `ikbi-iso-ws-${randomBytes(8).toString("hex")}`);
  const locks = new LockManager({ logger: silent, defaultTimeoutMs: 5000, defaultStaleMs: 30_000 });
  const store = new DocumentStore<WorkspaceRecord>({ dir: join(root, "registry"), locks, logger: silent, fsync: false });
  return { mgr: new WorkspaceManager({ root, max: 32, locks, store, logger: silent }), root, store };
}

async function cleanup(...paths: string[]): Promise<void> {
  for (const p of paths) {
    await rm(p, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ── path confinement ──────────────────────────────────────────────────────────

test("worktree path is confined to workspace root — path traversal ID rejected", () => {
  const { mgr } = makeManager();
  // These IDs are invalid: they contain path separators or traversal sequences.
  const badIds = ["../escape", "../../etc", "a/b", `a${sep}b`, "a\0b"];
  for (const id of badIds) {
    assert.throws(
      () => {
        // Access the private method via a dynamic property to test the guard.
        (mgr as unknown as { resolveWorktreePath: (id: string) => string }).resolveWorktreePath(id);
      },
      WorkspaceError,
      `invalid id "${id}" should throw WorkspaceError`,
    );
  }
});

test("allocate places each worktree in a distinct directory under the workspace root", async () => {
  const repo = await makeRepo("distinct");
  const { mgr, root } = makeManager();
  try {
    const ws1 = await mgr.allocate({ targetRepo: repo, identity: ID });
    const ws2 = await mgr.allocate({ targetRepo: repo, identity: ID });

    assert.notEqual(ws1.path, ws2.path, "each allocation gets a distinct directory");
    assert.ok(ws1.path.startsWith(join(root, "wt") + sep), "ws1 is inside workspace root");
    assert.ok(ws2.path.startsWith(join(root, "wt") + sep), "ws2 is inside workspace root");
  } finally {
    await cleanup(repo, root);
  }
});

// ── inter-worktree isolation ──────────────────────────────────────────────────

test("work in worktree A does not appear in worktree B (no shared working directory)", async () => {
  const repo = await makeRepo("inter");
  const { mgr, root } = makeManager();
  try {
    const wsA = await mgr.allocate({ targetRepo: repo, identity: ID });
    const wsB = await mgr.allocate({ targetRepo: repo, identity: ID });

    await writeFile(join(wsA.path, "file-a.txt"), "only in A\n");
    await writeFile(join(wsB.path, "file-b.txt"), "only in B\n");

    assert.equal(await exists(join(wsA.path, "file-b.txt")), false, "A does not see B's file");
    assert.equal(await exists(join(wsB.path, "file-a.txt")), false, "B does not see A's file");
  } finally {
    await cleanup(repo, root);
  }
});

test("node_modules in the parent repo are not visible in the worktree", async () => {
  const repo = await makeRepo("nm");
  const { mgr, root } = makeManager();
  try {
    // Simulate a node_modules directory at the parent repo root.
    await mkdir(join(repo, "node_modules", "some-pkg"), { recursive: true });
    await writeFile(join(repo, "node_modules", "some-pkg", "index.js"), "// parent\n");

    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });

    // git worktrees do not include node_modules (it is in .gitignore by convention and
    // is not tracked). Even if node_modules exists at the parent, the fresh worktree
    // will not have it because git checkout only restores tracked files.
    assert.equal(
      await exists(join(ws.path, "node_modules", "some-pkg")),
      false,
      "node_modules from parent repo is NOT present in the fresh worktree",
    );
  } finally {
    await cleanup(repo, root);
  }
});

// ── stale worktree detection and cleanup ─────────────────────────────────────

test("stale 'allocating' record from an interrupted build is reclaimed by cleanOrphans", async () => {
  const repo = await makeRepo("stale-alloc");
  const { mgr, root, store } = makeManager();
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });

    // Simulate a crash mid-allocate: force the record back to 'allocating'.
    const rec = await mgr.get(ws.id);
    assert.ok(rec);
    await store.put(ws.id, { ...rec, state: "allocating" as const });

    // cleanOrphans should detect the stale allocating record and mark it failed.
    const result = await mgr.cleanOrphans();
    const after = await mgr.get(ws.id);
    assert.equal(after?.state, "failed", "stale allocating record is marked failed");
    assert.match(after?.note ?? "", /reclaimed|allocate/, "note explains why it was reclaimed");
    // The slot is freed (live count is 0 after clean).
    assert.equal(mgr.liveCount(), 0, "live count freed after stale cleanup");
    void result;
  } finally {
    await cleanup(repo, root);
  }
});

test("cleanOrphans is idempotent — running it twice does not double-remove", async () => {
  const repo = await makeRepo("idempotent");
  const { mgr, root, store } = makeManager();
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
    await store.put(ws.id, { ...(await mgr.get(ws.id))!, state: "discarded" as const });

    const first = await mgr.cleanOrphans();
    assert.ok(first.removed >= 1, "first clean removes the orphan");

    const second = await mgr.cleanOrphans();
    assert.equal(second.removed, 0, "second clean finds nothing new to remove");
  } finally {
    await cleanup(repo, root);
  }
});

test("retained worktree is skipped by default clean and only removed with --force", async () => {
  const repo = await makeRepo("retained");
  const { mgr, root } = makeManager();
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
    await writeFile(join(ws.path, "partial-work.ts"), "// in progress\n");
    await mgr.retain(ws, "build interrupted");

    // Default clean skips retained work.
    const safe = await mgr.cleanOrphans({ force: false });
    assert.equal(safe.removed, 0, "retained work preserved without --force");
    assert.ok(safe.skipped >= 1, "retained workspace appears in skipped count");
    assert.ok(safe.skippedIds.includes(ws.id), "retained workspace ID is in skippedIds");
    assert.ok(await exists(ws.path), "worktree directory still exists");

    // Force clean removes it.
    const forced = await mgr.cleanOrphans({ force: true });
    assert.ok(forced.removed >= 1, "force clean removes retained worktree");
    assert.equal(await exists(ws.path), false, "directory removed by force clean");
  } finally {
    await cleanup(repo, root);
  }
});

test("promoted workspace worktree directory is absent (cleanup is automatic on promote)", async () => {
  const repo = await makeRepo("auto-clean");
  const { mgr, root } = makeManager();
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
    await writeFile(join(ws.path, "feature.txt"), "feature\n");
    await mgr.commit(ws, "add feature");

    const result = await mgr.promote(ws, APPROVE);
    assert.equal(result.promoted, true);
    assert.equal(await exists(ws.path), false, "promote auto-removes the worktree directory");
  } finally {
    await cleanup(repo, root);
  }
});

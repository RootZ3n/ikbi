import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { access, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino, type Logger } from "pino";

import { EventBus } from "../events/bus.js";
import type { IkbiEvent } from "../events/contract.js";
import type { AgentIdentity } from "../provider/contract.js";
import type { ReceiptInput } from "../receipt/contract.js";
import { LockManager } from "../substrate/lock.js";
import { DocumentStore } from "../substrate/store.js";
import { SCRATCH_BRANCH_PREFIX, type WorkspaceRecord, WorkspaceError } from "./contract.js";
import { listBranches, runGit } from "./git.js";
import { WorkspaceManager, type WorkspaceReceiptSink } from "./manager.js";

const silent: Logger = pino({ level: "silent" });
const ID: AgentIdentity = { agentId: "builder-3", functionalRole: "builder", trustTier: "verified" };

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** A fresh git repo with one commit on branch `main`. */
async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "ikbi-repo-"));
  await runGit(repo, ["init", "-b", "main", "--quiet"]);
  await runGit(repo, ["config", "user.email", "test@ikbi.local"]);
  await runGit(repo, ["config", "user.name", "ikbi test"]);
  await writeFile(join(repo, "README.md"), "initial\n");
  await runGit(repo, ["add", "-A"]);
  await runGit(repo, ["commit", "--quiet", "-m", "initial"]);
  return repo;
}

function makeManager(opts?: { root?: string; max?: number; events?: EventBus; receipts?: WorkspaceReceiptSink; idGen?: () => string }) {
  const root = opts?.root ?? join(tmpdir(), `ikbi-ws-${randomBytes(8).toString("hex")}`);
  const locks = new LockManager({ logger: silent, defaultTimeoutMs: 5000, defaultStaleMs: 30_000 });
  const store = new DocumentStore<WorkspaceRecord>({ dir: join(root, "registry"), locks, logger: silent, fsync: false });
  const mgr = new WorkspaceManager({
    root,
    max: opts?.max ?? 32,
    locks,
    store,
    logger: silent,
    ...(opts?.events ? { events: opts.events } : {}),
    ...(opts?.receipts ? { receipts: opts.receipts } : {}),
    ...(opts?.idGen ? { idGen: opts.idGen } : {}),
  });
  return { mgr, root, store, locks };
}

/** A standard approval: judge approved + governance allowed (fail-closed requires both). */
const APPROVE = { evaluation: { approved: true }, governance: { allow: true } } as const;

async function cleanup(repo: string, root: string): Promise<void> {
  await rm(repo, { recursive: true, force: true }).catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

test("allocate creates an isolated worktree; work in it does not touch main", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
    assert.ok(await exists(ws.path), "worktree path exists");
    assert.ok(await exists(join(ws.path, "README.md")), "worktree has a full checkout");
    assert.equal(ws.scratchBranch, SCRATCH_BRANCH_PREFIX + ws.id);
    assert.equal(ws.identity.agentId, "builder-3");

    await writeFile(join(ws.path, "feature.txt"), "work\n");
    assert.equal(await exists(join(repo, "feature.txt")), false, "main repo untouched by work in the worktree");
  } finally {
    await cleanup(repo, root);
  }
});

test("multiple workspaces coexist in isolation (concurrency-ready)", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const [a, b, c] = await Promise.all([
      mgr.allocate({ targetRepo: repo, identity: ID }),
      mgr.allocate({ targetRepo: repo, identity: ID }),
      mgr.allocate({ targetRepo: repo, identity: ID }),
    ]);
    assert.equal(new Set([a.path, b.path, c.path]).size, 3, "distinct worktree paths");
    assert.equal(new Set([a.scratchBranch, b.scratchBranch, c.scratchBranch]).size, 3, "distinct scratch branches");
    assert.equal(mgr.liveCount(), 3);

    await writeFile(join(a.path, "a.txt"), "a\n");
    await writeFile(join(b.path, "b.txt"), "b\n");
    assert.equal(await exists(join(b.path, "a.txt")), false, "a's work does not appear in b");
    assert.equal(await exists(join(a.path, "b.txt")), false, "b's work does not appear in a");
  } finally {
    await cleanup(repo, root);
  }
});

test("allocation is BOUNDED (cannot exhaust disk)", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager({ max: 2 });
  try {
    await mgr.allocate({ targetRepo: repo, identity: ID });
    await mgr.allocate({ targetRepo: repo, identity: ID });
    await assert.rejects(mgr.allocate({ targetRepo: repo, identity: ID }), (e: unknown) => e instanceof WorkspaceError && e.kind === "limit");
  } finally {
    await cleanup(repo, root);
  }
});

test("promote (fast-forward): the result lands on the target branch atomically", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
    await writeFile(join(ws.path, "feature.txt"), "feature\n");
    assert.equal(await mgr.commit(ws, "add feature"), true);

    const diff = await mgr.diff(ws);
    assert.ok(diff.includes("feature.txt"), "diff exposes the work for the judge seam");

    const r = await mgr.promote(ws, APPROVE);
    assert.equal(r.promoted, true);
    assert.equal(r.strategy, "fast_forward");
    // The target branch now contains the work.
    assert.equal((await runGit(repo, ["cat-file", "-e", "main:feature.txt"], { okCodes: [128] })).code, 0);
    assert.equal((await runGit(repo, ["rev-parse", "main"])).stdout.trim(), r.afterRef);
  } finally {
    await cleanup(repo, root);
  }
});

test("promote (merge): integrates with a moved target; both changes present", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
    // Target moves independently.
    await writeFile(join(repo, "main-change.txt"), "main\n");
    await runGit(repo, ["add", "-A"]);
    await runGit(repo, ["commit", "--quiet", "-m", "main change"]);
    // Workspace does its own (non-conflicting) work.
    await writeFile(join(ws.path, "ws-change.txt"), "ws\n");
    await mgr.commit(ws, "ws change");

    const r = await mgr.promote(ws, APPROVE);
    assert.equal(r.promoted, true);
    assert.equal(r.strategy, "merge");
    assert.ok(r.mergeCommit);
    assert.equal((await runGit(repo, ["cat-file", "-e", "main:main-change.txt"], { okCodes: [128] })).code, 0);
    assert.equal((await runGit(repo, ["cat-file", "-e", "main:ws-change.txt"], { okCodes: [128] })).code, 0);
  } finally {
    await cleanup(repo, root);
  }
});

test("promote (conflict): NOT promoted, target left untouched, conflict reported", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
    // Conflicting edits to the same file on main and in the workspace.
    await writeFile(join(repo, "README.md"), "MAIN version\n");
    await runGit(repo, ["add", "-A"]);
    await runGit(repo, ["commit", "--quiet", "-m", "main edit"]);
    await writeFile(join(ws.path, "README.md"), "WORKSPACE version\n");
    await mgr.commit(ws, "ws edit");

    const before = (await runGit(repo, ["rev-parse", "main"])).stdout.trim();
    const r = await mgr.promote(ws, APPROVE);
    assert.equal(r.promoted, false);
    assert.ok((r.conflicts ?? []).includes("README.md"), "conflict reported for governed resolution");
    assert.equal((await runGit(repo, ["rev-parse", "main"])).stdout.trim(), before, "target untouched on conflict");
  } finally {
    await cleanup(repo, root);
  }
});

test("the evaluation/governance seam gates promote", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
    await writeFile(join(ws.path, "f.txt"), "x\n");
    await mgr.commit(ws, "work");
    const before = (await runGit(repo, ["rev-parse", "main"])).stdout.trim();

    await assert.rejects(mgr.promote(ws, { evaluation: { approved: false } }), (e: unknown) => e instanceof WorkspaceError && e.kind === "not_approved");
    await assert.rejects(
      mgr.promote(ws, { evaluation: { approved: true }, governance: { allow: false } }),
      (e: unknown) => e instanceof WorkspaceError && e.kind === "not_approved",
    );
    // FAIL-CLOSED: missing governance refuses (must not silently promote).
    await assert.rejects(
      mgr.promote(ws, { evaluation: { approved: true } }),
      (e: unknown) => e instanceof WorkspaceError && e.kind === "not_approved",
    );
    assert.equal((await runGit(repo, ["rev-parse", "main"])).stdout.trim(), before, "target untouched while ungated");
  } finally {
    await cleanup(repo, root);
  }
});

test("discard tears down completely (no leaked worktree or branch)", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
    await writeFile(join(ws.path, "tmp.txt"), "x\n");
    await mgr.discard(ws);
    assert.equal(await exists(ws.path), false, "worktree dir removed");
    assert.equal((await listBranches(repo, SCRATCH_BRANCH_PREFIX)).includes(ws.scratchBranch), false, "scratch branch deleted");
    assert.equal(mgr.liveCount(), 0);
    assert.equal((await mgr.get(ws.id))?.state, "discarded");
  } finally {
    await cleanup(repo, root);
  }
});

test("crash/abandon is reclaimable (no orphaned worktrees/branches)", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
    // Simulate a crash: the worktree dir vanishes WITHOUT a clean discard.
    await rm(ws.path, { recursive: true, force: true }).catch(() => rmdir(ws.path).catch(() => undefined));

    const result = await mgr.reclaim(repo);
    assert.ok(result.branchesDeleted >= 1 || result.worktreesPruned >= 1, "orphan reclaimed");
    assert.equal((await listBranches(repo, SCRATCH_BRANCH_PREFIX)).includes(ws.scratchBranch), false, "orphan scratch branch deleted");
    assert.equal((await mgr.get(ws.id))?.state, "failed", "registry record reconciled");
    assert.equal(mgr.liveCount(), 0);
  } finally {
    await cleanup(repo, root);
  }
});

test("attribution + lifecycle events are emitted; promote records a receipt", async () => {
  const repo = await makeRepo();
  const bus = new EventBus({ logger: silent, defaultMaxQueue: 1000 });
  const seen: IkbiEvent[] = [];
  bus.subscribe({ typePrefix: "workspace." }, (e) => {
    seen.push(e);
  });
  const receiptCalls: Array<{ input: ReceiptInput; identity: AgentIdentity }> = [];
  const receipts: WorkspaceReceiptSink = {
    append: async (input, identity) => {
      receiptCalls.push({ input, identity });
      return {};
    },
  };
  const { mgr, root } = makeManager({ events: bus, receipts });
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
    await writeFile(join(ws.path, "f.txt"), "x\n");
    await mgr.commit(ws, "work");
    await mgr.promote(ws, APPROVE);
    await mgr.discard(ws);
    await bus.flush();

    const types = seen.map((e) => e.type);
    assert.ok(types.includes("workspace.allocated"));
    assert.ok(types.includes("workspace.promoted"));
    assert.ok(types.includes("workspace.discarded"));
    const allocated = seen.find((e) => e.type === "workspace.allocated");
    assert.equal(allocated?.attribution?.identity?.agentId, "builder-3", "events attributed to the allocating identity");

    assert.equal(receiptCalls.length, 1, "promote recorded a receipt");
    const rc = receiptCalls[0];
    assert.equal(rc?.input.operation, "workspace.promote");
    assert.equal(rc?.identity.agentId, "builder-3");
    const change = rc?.input.changes?.[0];
    assert.ok(change?.before?.ref, "receipt carries the pre-promote ref (reversibility)");
    assert.equal(change?.inverse?.operation, "git.update-ref", "receipt carries the inverse op for undo");
  } finally {
    await cleanup(repo, root);
  }
});

test("DURABILITY: restart preloads the registry — the bound + existing workspaces survive", async () => {
  const repo = await makeRepo();
  const root = join(tmpdir(), `ikbi-ws-${randomBytes(8).toString("hex")}`);
  try {
    const first = makeManager({ root, max: 2 });
    await first.mgr.allocate({ targetRepo: repo, identity: ID });
    await first.mgr.allocate({ targetRepo: repo, identity: ID });

    // "Restart": a brand-new manager over the SAME root/registry.
    const restarted = makeManager({ root, max: 2 });
    assert.equal(await restarted.mgr.preload(), 2, "preloaded the two persisted workspaces");
    assert.equal(restarted.mgr.liveCount(), 2);
    await assert.rejects(
      restarted.mgr.allocate({ targetRepo: repo, identity: ID }),
      (e: unknown) => e instanceof WorkspaceError && e.kind === "limit",
      "the bound counts persisted workspaces after restart",
    );
  } finally {
    await cleanup(repo, root);
  }
});

test("DURABILITY: crash mid-allocate leaves a reclaimable record (no orphan)", async () => {
  const repo = await makeRepo();
  const { mgr, root, store } = makeManager();
  try {
    // Simulate a crash AFTER the intent record but BEFORE the worktree existed.
    const ts = Date.now();
    const id = "crashalloc01";
    await store.put(id, {
      id, targetRepo: repo, baseBranch: "main", baseRef: (await runGit(repo, ["rev-parse", "main"])).stdout.trim(),
      scratchBranch: SCRATCH_BRANCH_PREFIX + id, path: join(root, "wt", id), identity: ID, state: "allocating", createdAt: ts, updatedAt: ts,
    });
    const result = await mgr.reclaim(repo);
    assert.ok(result.recordsReconciled >= 1);
    assert.equal((await mgr.get(id))?.state, "failed", "incomplete allocate reconciled to failed");
  } finally {
    await cleanup(repo, root);
  }
});

test("DURABILITY: a crashed promote that LANDED reconciles to promoted (no unrecorded mutation)", async () => {
  const repo = await makeRepo();
  const { mgr, root, store } = makeManager();
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
    await writeFile(join(ws.path, "f.txt"), "x\n");
    await mgr.commit(ws, "work");
    const before = (await runGit(repo, ["rev-parse", "main"])).stdout.trim();
    const scratchHead = (await runGit(repo, ["rev-parse", ws.scratchBranch])).stdout.trim();

    // Simulate: the CAS landed but the process crashed before recording "promoted".
    await runGit(repo, ["update-ref", "refs/heads/main", scratchHead, before]);
    await store.put(ws.id, { ...(await mgr.get(ws.id))!, state: "promoting", promoteIntent: { beforeRef: before, afterRef: scratchHead } });

    const result = await mgr.reclaim(repo);
    assert.ok(result.recordsReconciled >= 1);
    const rec = await mgr.get(ws.id);
    assert.equal(rec?.state, "promoted", "the landed mutation is reconciled to promoted");
    assert.equal(rec?.promotedTo, scratchHead);
  } finally {
    await cleanup(repo, root);
  }
});

test("DURABILITY: a crashed promote that did NOT land reverts to allocated", async () => {
  const repo = await makeRepo();
  const { mgr, root, store } = makeManager();
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
    const before = (await runGit(repo, ["rev-parse", "main"])).stdout.trim();
    // promoting intent with an afterRef the target never reached (CAS didn't land).
    await store.put(ws.id, { ...(await mgr.get(ws.id))!, state: "promoting", promoteIntent: { beforeRef: before, afterRef: "0".repeat(40) } });
    await mgr.reclaim(repo);
    assert.equal((await mgr.get(ws.id))?.state, "allocated", "un-landed promote reverts to allocated (promotable again)");
  } finally {
    await cleanup(repo, root);
  }
});

test("LOCKING: discard shares the per-workspace lock with promote (no interleaved teardown)", async () => {
  const repo = await makeRepo();
  const { mgr, root, locks } = makeManager();
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
    // Hold the per-workspace lock (as an in-flight promote would) and confirm discard waits.
    const release = await locks.acquire(`workspace:ws:${ws.id}`);
    let discardDone = false;
    const p = mgr.discard(ws).then(() => {
      discardDone = true;
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(discardDone, false, "discard blocked on the shared per-workspace lock");
    await release();
    await p;
    assert.equal(discardDone, true, "discard proceeds once the lock is free");
  } finally {
    await cleanup(repo, root);
  }
});

test("LOCKING: reclaim skips an active (locked) workspace, then reclaims once idle", async () => {
  const repo = await makeRepo();
  const { mgr, root, store, locks } = makeManager();
  try {
    const ts = Date.now();
    const id = "lockedalloc1";
    await store.put(id, {
      id, targetRepo: repo, baseBranch: "main", baseRef: (await runGit(repo, ["rev-parse", "main"])).stdout.trim(),
      scratchBranch: SCRATCH_BRANCH_PREFIX + id, path: join(root, "wt", id), identity: ID, state: "allocating", createdAt: ts, updatedAt: ts,
    });
    // Hold the workspace lock => reclaim must skip it.
    const release = await locks.acquire(`workspace:ws:${id}`);
    await mgr.reclaim(repo);
    assert.equal((await mgr.get(id))?.state, "allocating", "active/locked workspace was NOT reclaimed");
    await release();
    await mgr.reclaim(repo);
    assert.equal((await mgr.get(id))?.state, "failed", "reclaimed once idle");
  } finally {
    await cleanup(repo, root);
  }
});

test("discard after promote preserves the terminal 'promoted' record", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
    await writeFile(join(ws.path, "f.txt"), "x\n");
    await mgr.commit(ws, "work");
    const r = await mgr.promote(ws, APPROVE);
    assert.equal(r.promoted, true);
    await mgr.discard(ws);
    const rec = await mgr.get(ws.id);
    assert.equal(rec?.state, "promoted", "promoted is terminal — discard does not overwrite it");
    assert.equal(rec?.promotedTo, r.afterRef);
    assert.ok(rec?.cleanedAt, "worktree cleanup is noted without losing the promoted state");
  } finally {
    await cleanup(repo, root);
  }
});

test("BOUNDARY: a malicious workspace id is rejected (path/branch safety not dependent on idGen)", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager({ idGen: () => "../../etc/evil" });
  try {
    await assert.rejects(mgr.allocate({ targetRepo: repo, identity: ID }), (e: unknown) => e instanceof WorkspaceError && e.kind === "config");
  } finally {
    await cleanup(repo, root);
  }
});

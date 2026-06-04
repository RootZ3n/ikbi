import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino, type Logger } from "pino";

import { SubstrateError } from "./contract.js";
import { acquireFileLock, KeyedMutex, LockManager } from "./lock.js";

const silent: Logger = pino({ level: "silent" });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ikbi-lock-"));
}

function captureLogger(): { logger: Logger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const logger = pino({ level: "trace" }, { write: (s: string) => void lines.push(JSON.parse(s) as Record<string, unknown>) });
  return { logger, lines };
}

// --- in-process mutex -------------------------------------------------------

test("KeyedMutex serializes: never two holders in the critical section at once", async () => {
  const m = new KeyedMutex();
  let active = 0;
  let maxActive = 0;
  const op = async (): Promise<void> => {
    const release = await m.acquire("k", 2000);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(2);
    active -= 1;
    await release();
  };
  await Promise.all(Array.from({ length: 25 }, op));
  assert.equal(maxActive, 1, "mutual exclusion held under concurrency");
});

test("KeyedMutex grants in FIFO order", async () => {
  const m = new KeyedMutex();
  const hold = await m.acquire("k", 2000);
  const got: number[] = [];
  const mk = (i: number): Promise<void> =>
    m.acquire("k", 2000).then(async (rel) => {
      got.push(i);
      await sleep(1);
      await rel();
    });
  const all = Promise.all([mk(1), mk(2), mk(3)]);
  await sleep(10); // let all three queue
  await hold();
  await all;
  assert.deepEqual(got, [1, 2, 3]);
});

test("KeyedMutex acquire times out while held", async () => {
  const m = new KeyedMutex();
  const release = await m.acquire("k", 2000);
  await assert.rejects(
    m.acquire("k", 20),
    (e: unknown) => e instanceof SubstrateError && e.kind === "lock_timeout",
  );
  await release();
  // After release the key is free again.
  const r2 = await m.acquire("k", 50);
  await r2();
});

test("different keys do not block each other", async () => {
  const m = new KeyedMutex();
  const r1 = await m.acquire("a", 1000);
  const r2 = await m.acquire("b", 50); // different key — not blocked
  await r1();
  await r2();
  assert.ok(true);
});

// --- LockManager ------------------------------------------------------------

function makeManager(logger: Logger = silent): LockManager {
  return new LockManager({ logger, defaultTimeoutMs: 2000, defaultStaleMs: 30_000 });
}

test("LockManager.withLock releases the lock even when fn throws", async () => {
  const lm = makeManager();
  await assert.rejects(lm.withLock("k", async () => {
    throw new Error("boom");
  }));
  assert.equal(lm.isLocked("k"), false, "lock released after failure");
  // Re-acquirable.
  const rel = await lm.acquire("k");
  await rel();
});

test("LockManager logs contention and timeout", async () => {
  const { logger, lines } = captureLogger();
  const lm = new LockManager({ logger, defaultTimeoutMs: 2000, defaultStaleMs: 30_000 });
  const hold = await lm.acquire("k");
  await assert.rejects(lm.acquire("k", { timeoutMs: 20 }));
  await hold();
  assert.ok(lines.some((l) => l.event === "lock_contended"));
  assert.ok(lines.some((l) => l.event === "lock_timeout"));
  assert.ok(lines.some((l) => l.event === "lock_acquired"));
});

// --- cross-process file lock ------------------------------------------------

test("file lock serializes; a second acquire times out while held, succeeds after release", async () => {
  const dir = await tmp();
  try {
    const lockPath = join(dir, "x.lock");
    const deps = { logger: silent, staleMs: 30_000 };
    const rel1 = await acquireFileLock(lockPath, 1000, deps);
    await assert.rejects(
      acquireFileLock(lockPath, 40, deps),
      (e: unknown) => e instanceof SubstrateError && e.kind === "lock_timeout",
    );
    await rel1();
    const rel2 = await acquireFileLock(lockPath, 1000, deps);
    await rel2();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file lock recovers a stale lock from a dead PID", async () => {
  const dir = await tmp();
  try {
    const lockPath = join(dir, "y.lock");
    const { logger, lines } = captureLogger();
    // A lock left by a (this-host) process that is no longer alive.
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 1 << 30, host: hostname(), acquiredAt: Date.now(), nonce: "dead" }),
    );
    const rel = await acquireFileLock(lockPath, 1000, { logger, staleMs: 30_000 });
    await rel();
    assert.ok(lines.some((l) => l.event === "stale_lock_recovered"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file lock recovers a lock that is stale by age", async () => {
  const dir = await tmp();
  try {
    const lockPath = join(dir, "z.lock");
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, host: hostname(), acquiredAt: Date.now() - 100_000, nonce: "old" }),
    );
    // staleMs small => the existing lock is too old even though our PID is alive.
    const rel = await acquireFileLock(lockPath, 1000, { logger: silent, staleMs: 1000 });
    await rel();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt lock file is treated as recoverable", async () => {
  const dir = await tmp();
  try {
    const lockPath = join(dir, "c.lock");
    await writeFile(lockPath, "not json at all");
    const rel = await acquireFileLock(lockPath, 1000, { logger: silent, staleMs: 30_000 });
    await rel();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

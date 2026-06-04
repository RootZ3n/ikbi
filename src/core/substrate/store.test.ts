import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino, type Logger } from "pino";

import { atomicWriteJson } from "./atomic.js";
import { SubstrateError } from "./contract.js";
import { LockManager } from "./lock.js";
import { DocumentStore, readModifyWrite, type RmwDeps } from "./store.js";

const silent: Logger = pino({ level: "silent" });

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ikbi-store-"));
}

function manager(logger: Logger = silent): LockManager {
  return new LockManager({ logger, defaultTimeoutMs: 5000, defaultStaleMs: 30_000 });
}

interface Counter {
  n: number;
}

test("readModifyWrite: 100 concurrent increments lose NO updates", async () => {
  const dir = await tmp();
  try {
    const path = join(dir, "counter.json");
    await atomicWriteJson(path, { n: 0 });
    const deps: RmwDeps = { locks: manager(), logger: silent, defaultFsync: false };

    const N = 100;
    await Promise.all(
      Array.from({ length: N }, () =>
        readModifyWrite<Counter>(path, (cur) => ({ n: (cur?.n ?? 0) + 1 }), deps),
      ),
    );

    const final = JSON.parse(await readFile(path, "utf8")) as Counter;
    assert.equal(final.n, N, "every concurrent increment was applied (no lost update)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readModifyWrite creates the file when absent (mutate receives undefined)", async () => {
  const dir = await tmp();
  try {
    const path = join(dir, "new.json");
    const deps: RmwDeps = { locks: manager(), logger: silent, defaultFsync: false };
    let sawUndefined = false;
    const out = await readModifyWrite<Counter>(
      path,
      (cur) => {
        if (cur === undefined) sawUndefined = true;
        return { n: (cur?.n ?? 0) + 1 };
      },
      deps,
    );
    assert.equal(sawUndefined, true);
    assert.deepEqual(out, { n: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- DocumentStore ----------------------------------------------------------

function store<T>(dir: string, logger: Logger = silent, corruptPolicy?: "throw" | "quarantine"): DocumentStore<T> {
  return new DocumentStore<T>({ dir, locks: manager(logger), logger, fsync: false, ...(corruptPolicy ? { corruptPolicy } : {}) });
}

test("DocumentStore: put / get / has / update / list / delete", async () => {
  const dir = await tmp();
  try {
    const s = store<Counter>(dir);
    assert.equal(await s.get("a"), undefined);
    assert.equal(await s.has("a"), false);

    await s.put("a", { n: 1 });
    assert.deepEqual(await s.get("a"), { n: 1 });
    assert.equal(await s.has("a"), true);

    await s.update("a", (c) => ({ n: (c?.n ?? 0) + 41 }));
    assert.deepEqual(await s.get("a"), { n: 42 });

    await s.put("b", { n: 7 });
    assert.deepEqual((await s.list()).sort(), ["a", "b"]);

    assert.equal(await s.delete("a"), true);
    assert.equal(await s.delete("a"), false);
    assert.equal(await s.get("a"), undefined);
    assert.deepEqual(await s.list(), ["b"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("DocumentStore.update: concurrent updates to one doc lose no writes", async () => {
  const dir = await tmp();
  try {
    const s = store<Counter>(dir);
    await s.put("c", { n: 0 });
    await Promise.all(Array.from({ length: 60 }, () => s.update("c", (v) => ({ n: (v?.n ?? 0) + 1 }))));
    assert.deepEqual(await s.get("c"), { n: 60 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("DocumentStore rejects unsafe ids (path traversal / separators)", async () => {
  const dir = await tmp();
  try {
    const s = store<Counter>(dir);
    for (const bad of ["..", ".", "../evil", "a/b", "a\\b", "", "x".repeat(300)]) {
      await assert.rejects(s.put(bad, { n: 1 }), (e: unknown) => e instanceof SubstrateError && e.kind === "invalid_key");
    }
    // A safe id with dots/dashes/underscores is fine.
    await s.put("ok_id-1.v2", { n: 1 });
    assert.deepEqual(await s.get("ok_id-1.v2"), { n: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("DocumentStore corrupt policy: throw (fail-closed) vs quarantine", async () => {
  const dir = await tmp();
  try {
    await writeFile(join(dir, "bad.json"), "{ this is not json");

    const failClosed = store<Counter>(dir, silent, "throw");
    await assert.rejects(failClosed.get("bad"), (e: unknown) => e instanceof SubstrateError && e.kind === "corrupt_state");

    const recovering = store<Counter>(dir, silent, "quarantine");
    assert.equal(await recovering.get("bad"), undefined, "quarantine treats corrupt as missing");
    const entries = await readdir(dir);
    assert.ok(!entries.includes("bad.json"), "corrupt file moved aside");
    assert.ok(entries.some((n) => n.startsWith("bad.json.corrupt.")), "quarantined sidecar exists");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("DocumentStore.list ignores temp and corrupt sidecar files", async () => {
  const dir = await tmp();
  try {
    const s = store<Counter>(dir);
    await s.put("real", { n: 1 });
    await writeFile(join(dir, "real.json.ikbi-tmp.1.aa"), "x");
    await writeFile(join(dir, "old.json.corrupt.123"), "x");
    assert.deepEqual(await s.list(), ["real"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

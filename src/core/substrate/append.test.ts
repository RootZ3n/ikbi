import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino, type Logger } from "pino";

import { AtomicAppendLog } from "./append.js";
import { SubstrateError } from "./contract.js";
import { LockManager } from "./lock.js";

const silent: Logger = pino({ level: "silent" });

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ikbi-append-"));
}

function makeLog<T>(path: string): AtomicAppendLog<T> {
  const locks = new LockManager({ logger: silent, defaultTimeoutMs: 5000, defaultStaleMs: 30_000 });
  return new AtomicAppendLog<T>({ path, locks, logger: silent, fsync: false });
}

interface Entry {
  i: number;
}

test("append + readAll round-trips entries in order", async () => {
  const dir = await tmp();
  try {
    const log = makeLog<Entry>(join(dir, "log.ndjson"));
    await log.append({ i: 1 });
    await log.append({ i: 2 });
    await log.append({ i: 3 });
    assert.deepEqual(await log.readAll(), [{ i: 1 }, { i: 2 }, { i: 3 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readAll on a missing log returns []", async () => {
  const dir = await tmp();
  try {
    const log = makeLog<Entry>(join(dir, "nope.ndjson"));
    assert.deepEqual(await log.readAll(), []);
    assert.equal(await log.size(), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CONCURRENCY: N concurrent appends => all N present, none lost, no torn lines", async () => {
  const dir = await tmp();
  try {
    const path = join(dir, "hot.ndjson");
    const log = makeLog<Entry>(path);
    const N = 200;
    await Promise.all(Array.from({ length: N }, (_unused, i) => log.append({ i })));

    const all = await log.readAll();
    assert.equal(all.length, N, "every append is present (no lost entries)");
    // No torn lines: the raw file is exactly N complete JSON lines.
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, N);
    for (const l of lines) JSON.parse(l); // each parses (no interleaved/torn bytes)
    // Every i in [0, N) appears exactly once.
    const seen = new Set(all.map((e) => e.i));
    assert.equal(seen.size, N);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readFrom(offset) returns only entries after the offset, with a resumable nextOffset", async () => {
  const dir = await tmp();
  try {
    const log = makeLog<Entry>(join(dir, "off.ndjson"));
    const a = await log.append({ i: 1 });
    await log.append({ i: 2 });
    await log.append({ i: 3 });

    // From the start: all three; nextOffset == size.
    const fromStart = await log.readFrom(0);
    assert.deepEqual(fromStart.entries, [{ i: 1 }, { i: 2 }, { i: 3 }]);
    assert.equal(fromStart.nextOffset, await log.size());

    // From after the first entry: only entries 2 and 3.
    const fromSecond = await log.readFrom(a.nextOffset);
    assert.deepEqual(fromSecond.entries, [{ i: 2 }, { i: 3 }]);

    // Incremental tailing: read, append, read-from-nextOffset gets only the new one.
    const tail = await log.readFrom(fromStart.nextOffset);
    assert.deepEqual(tail.entries, []);
    await log.append({ i: 4 });
    const tail2 = await log.readFrom(tail.nextOffset);
    assert.deepEqual(tail2.entries, [{ i: 4 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("torn-tail repair: an unterminated partial line is dropped, not merged into the next entry", async () => {
  const dir = await tmp();
  try {
    const path = join(dir, "torn.ndjson");
    const log = makeLog<Entry>(path);
    await log.append({ i: 1 });
    // Simulate a crash mid-append: a partial line with no trailing newline.
    await appendFile(path, '{"i":2'); // torn, never confirmed
    // The next append repairs the tail (drops the partial) then appends cleanly.
    await log.append({ i: 3 });
    assert.deepEqual(await log.readAll(), [{ i: 1 }, { i: 3 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt COMPLETE line fails closed by default, or is skipped under quarantine", async () => {
  const dir = await tmp();
  try {
    const path = join(dir, "corrupt.ndjson");
    const log = makeLog<Entry>(path);
    await log.append({ i: 1 });
    await appendFile(path, "this is not json\n"); // a complete but malformed line
    await log.append({ i: 3 });

    await assert.rejects(log.readAll(), (e: unknown) => e instanceof SubstrateError && e.kind === "corrupt_state");
    assert.deepEqual(await log.readAll({ corruptPolicy: "quarantine" }), [{ i: 1 }, { i: 3 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendBatch writes multiple entries atomically", async () => {
  const dir = await tmp();
  try {
    const log = makeLog<Entry>(join(dir, "batch.ndjson"));
    const r = await log.appendBatch([{ i: 1 }, { i: 2 }, { i: 3 }]);
    assert.equal(r.offset, 0);
    assert.deepEqual(await log.readAll(), [{ i: 1 }, { i: 2 }, { i: 3 }]);
    assert.equal(r.nextOffset, await log.size());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("blank lines are tolerated and skipped", async () => {
  const dir = await tmp();
  try {
    const path = join(dir, "blank.ndjson");
    const log = makeLog<Entry>(path);
    await writeFile(path, '{"i":1}\n\n{"i":2}\n');
    assert.deepEqual(await log.readAll(), [{ i: 1 }, { i: 2 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

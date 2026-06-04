import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino, type Logger } from "pino";

import type { AgentIdentity } from "../provider/contract.js";
import { AtomicAppendLog } from "../substrate/append.js";
import { LockManager } from "../substrate/lock.js";
import type { Receipt, ReceiptInput } from "./contract.js";
import { ReceiptError } from "./contract.js";
import { ReceiptStore } from "./store.js";

const silent: Logger = pino({ level: "silent" });
const IDENTITY: AgentIdentity = { agentId: "builder-3", functionalRole: "builder", trustTier: "probation" };
const DAY = 24 * 60 * 60 * 1000;

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ikbi-receipt-"));
}

function makeStore(dir: string, opts?: { now?: () => number; idGen?: () => string; retentionMs?: number }) {
  const locks = new LockManager({ logger: silent, defaultTimeoutMs: 5000, defaultStaleMs: 30_000 });
  const logFile = join(dir, "r.ndjson");
  const log = new AtomicAppendLog<Receipt>({ path: logFile, locks, logger: silent, fsync: false });
  const store = new ReceiptStore({
    log,
    logFile,
    locks,
    logger: silent,
    retentionMs: opts?.retentionMs ?? 30 * DAY,
    fsync: false,
    ...(opts?.now ? { now: opts.now } : {}),
    ...(opts?.idGen ? { idGen: opts.idGen } : {}),
  });
  return { store, logFile, dir };
}

const ok = (operation: string): ReceiptInput => ({ operation, outcome: { status: "success" } });

test("append assigns id/seq/timestamp and attributes identity (no chain fields)", async () => {
  const dir = await tmp();
  try {
    let t = 1000;
    const { store } = makeStore(dir, { now: () => t++ });
    const r0 = await store.append(ok("model.invoke"), IDENTITY);
    assert.equal(r0.seq, 0);
    assert.equal(r0.identity.agentId, "builder-3");
    assert.equal(r0.identity.trustTier, "probation");
    assert.equal(r0.contractVersion, "1.0.0");
    assert.match(r0.id, /^[a-f0-9]{32}$/);
    // No tamper-evidence fields exist anymore.
    const raw = r0 as unknown as Record<string, unknown>;
    assert.equal(raw.hash, undefined);
    assert.equal(raw.prevHash, undefined);

    const r1 = await store.append(ok("file.write"), IDENTITY);
    assert.equal(r1.seq, 1, "seq is monotonic");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the reversibility hook carries change data (target, prior state, inverse op)", async () => {
  const dir = await tmp();
  try {
    const { store } = makeStore(dir);
    const r = await store.append(
      {
        operation: "file.write",
        outcome: { status: "partial", detail: "1 of 2 applied" },
        changes: [
          {
            kind: "file",
            target: "src/x.ts",
            before: { existed: true, hash: "abc", ref: "snap-1" },
            after: { hash: "def" },
            inverse: { operation: "file.restore", args: { ref: "snap-1" } },
          },
        ],
      },
      IDENTITY,
    );
    assert.equal(r.changes.length, 1);
    assert.equal(r.changes[0]?.target, "src/x.ts");
    assert.equal(r.changes[0]?.before?.ref, "snap-1");
    assert.equal(r.changes[0]?.inverse?.operation, "file.restore");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("query filters by identity, project, operation, status, time, seq", async () => {
  const dir = await tmp();
  try {
    let t = 100;
    const { store } = makeStore(dir, { now: () => (t += 10) });
    await store.append({ operation: "a", outcome: { status: "success" }, project: "alpha" }, IDENTITY);
    await store.append({ operation: "b", outcome: { status: "failure", error: "x" }, project: "beta" }, IDENTITY);
    await store.append({ operation: "a", outcome: { status: "success" }, project: "alpha" }, { agentId: "scout" });

    assert.equal((await store.query({ agentId: "builder-3" })).length, 2);
    assert.equal((await store.query({ project: "alpha" })).length, 2);
    assert.equal((await store.query({ project: "beta" })).length, 1);
    assert.equal((await store.query({ operation: "a" })).length, 2);
    assert.equal((await store.query({ status: "failure" })).length, 1);
    assert.equal((await store.query({ project: "alpha", agentId: "scout" })).length, 1);
    assert.equal((await store.query({ fromSeq: 1 })).length, 2);
    assert.equal((await store.query({ toSeq: 0 })).length, 1);
    assert.equal((await store.query({ limit: 1 }))[0]?.seq, 2, "limit keeps the most recent");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trust + memory read-seam: agentHistory + summarizeAgent", async () => {
  const dir = await tmp();
  try {
    const { store } = makeStore(dir);
    await store.append({ operation: "build", outcome: { status: "success" } }, IDENTITY);
    await store.append({ operation: "build", outcome: { status: "failure", error: "boom" } }, IDENTITY);
    await store.append({ operation: "test", outcome: { status: "success" } }, IDENTITY);
    await store.append({ operation: "build", outcome: { status: "success" } }, { agentId: "other" });

    assert.equal((await store.agentHistory("builder-3")).length, 3);
    const summary = await store.summarizeAgent("builder-3");
    assert.equal(summary.total, 3);
    assert.equal(summary.byStatus.success, 2);
    assert.equal(summary.byStatus.failure, 1);
    assert.equal(summary.operations.build, 2);
    assert.equal(summary.operations.test, 1);
    assert.equal(summary.firstSeq, 0);
    assert.equal(summary.lastSeq, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CONCURRENCY: concurrent appends are ordered + durable (contiguous unique seq, none lost)", async () => {
  const dir = await tmp();
  try {
    const { store } = makeStore(dir);
    const N = 50;
    await Promise.all(Array.from({ length: N }, (_unused, i) => store.append(ok(`op-${i}`), IDENTITY)));
    const all = await store.readAll();
    assert.equal(all.length, N, "no lost receipts");
    assert.deepEqual(
      all.map((r) => r.seq),
      Array.from({ length: N }, (_u, i) => i),
      "seqs are contiguous and unique",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("append-only: the store exposes NO mutate/update API (retention prune is the only deletion)", () => {
  const proto = ReceiptStore.prototype as unknown as Record<string, unknown>;
  for (const banned of ["update", "delete", "remove", "mutate", "set", "edit", "patch", "put"]) {
    assert.equal(typeof proto[banned], "undefined", `ReceiptStore must not expose "${banned}"`);
  }
  // The explicit, only deletion path:
  assert.equal(typeof proto.prune, "function");
  assert.equal(typeof proto.pruneOlderThan, "function");
});

test("retention hard-deletes aged receipts; fresh receipts survive; survivors keep monotonic seq", async () => {
  const dir = await tmp();
  try {
    let now = 0;
    const { store } = makeStore(dir, { now: () => now, retentionMs: 10 * DAY });
    // Two old receipts (day 0), then advance and add two fresh (day 20).
    await store.append(ok("old-0"), IDENTITY); // seq 0, ts 0
    await store.append(ok("old-1"), IDENTITY); // seq 1, ts 0
    now = 20 * DAY;
    await store.append(ok("fresh-2"), IDENTITY); // seq 2
    await store.append(ok("fresh-3"), IDENTITY); // seq 3

    const result = await store.prune(); // cutoff = 20d - 10d = day 10; drops day-0 receipts
    assert.deepEqual(result, { removed: 2, kept: 2 });

    const remaining = await store.readAll();
    assert.deepEqual(remaining.map((r) => r.operation), ["fresh-2", "fresh-3"]);
    assert.deepEqual(remaining.map((r) => r.seq), [2, 3], "survivors keep their original monotonic seq");

    // A subsequent append continues monotonically (no seq reuse).
    const next = await store.append(ok("after-prune"), IDENTITY);
    assert.equal(next.seq, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prune with nothing aged removes nothing", async () => {
  const dir = await tmp();
  try {
    let now = 100 * DAY;
    const { store } = makeStore(dir, { now: () => now, retentionMs: 30 * DAY });
    await store.append(ok("a"), IDENTITY);
    await store.append(ok("b"), IDENTITY);
    const result = await store.prune();
    assert.deepEqual(result, { removed: 0, kept: 2 });
    assert.equal((await store.readAll()).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TWO instances over the same log share the (logfile-derived) lock — no dup seq, no dropped append", async () => {
  const dir = await tmp();
  try {
    const locks = new LockManager({ logger: silent, defaultTimeoutMs: 5000, defaultStaleMs: 30_000 });
    const logFile = join(dir, "shared.ndjson");
    const mk = () =>
      new ReceiptStore({
        log: new AtomicAppendLog<Receipt>({ path: logFile, locks, logger: silent, fsync: false }),
        logFile,
        locks,
        logger: silent,
        retentionMs: 30 * DAY,
        fsync: false,
      });
    const A = mk();
    const B = mk();
    await Promise.all([
      ...Array.from({ length: 25 }, () => A.append(ok("from-a"), IDENTITY)),
      ...Array.from({ length: 25 }, () => B.append(ok("from-b"), IDENTITY)),
    ]);
    const all = await A.readAll();
    assert.equal(all.length, 50, "no dropped appends");
    const seqs = all.map((r) => r.seq).sort((x, y) => x - y);
    assert.deepEqual(seqs, Array.from({ length: 50 }, (_u, i) => i), "seqs are unique + contiguous (no dup)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("backward clock: no seq reuse after restart, and prune keeps a contiguous suffix", async () => {
  const dir = await tmp();
  try {
    let now = 5000;
    const { store } = makeStore(dir, { now: () => now, retentionMs: 1000 });
    await store.append(ok("a"), IDENTITY); // seq 0, ts 5000
    now = 6000;
    await store.append(ok("b"), IDENTITY); // seq 1, ts 6000
    now = 1000; // CLOCK JUMPS BACKWARD
    await store.append(ok("c"), IDENTITY); // seq 2, ts 1000 (seq still monotonic)
    now = 7000;
    await store.append(ok("d"), IDENTITY); // seq 3, ts 7000
    assert.deepEqual((await store.readAll()).map((r) => r.seq), [0, 1, 2, 3], "seq monotonic despite backward clock");

    // Simulate a RESTART (new instance over the same log) after a backward clock.
    now = 500;
    const { store: restarted } = makeStore(dir, { now: () => now, retentionMs: 1000 });
    const next = await restarted.append(ok("e"), IDENTITY);
    assert.equal(next.seq, 4, "no seq reuse after restart with a backward clock");

    // Prune at now=7000, window 1000 => cutoff 6000. Keep the contiguous suffix from
    // the first in-window receipt (seq 1) onward — continuity is preserved.
    now = 7000;
    const res = await restarted.pruneOlderThan(6000);
    assert.equal(res.removed, 1);
    const remaining = (await restarted.readAll()).map((r) => r.seq);
    assert.deepEqual(remaining, [1, 2, 3, 4], "contiguous suffix; no holes");
    const after = await restarted.append(ok("f"), IDENTITY);
    assert.equal(after.seq, 5, "append continues monotonically after prune");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid retention is rejected at the store boundary (no catastrophic wipe)", async () => {
  const dir = await tmp();
  try {
    for (const bad of [-1, 0, -100000, Number.NaN, Number.POSITIVE_INFINITY, 200 * 365 * DAY]) {
      assert.throws(() => makeStore(dir, { retentionMs: bad }), (e: unknown) => e instanceof ReceiptError && e.kind === "config");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("append rejects malformed / oversized input (boundary hardening)", async () => {
  const dir = await tmp();
  try {
    const { store } = makeStore(dir);
    const bads: Array<[ReceiptInput, AgentIdentity]> = [
      [{ operation: 123 as unknown as string, outcome: { status: "success" } }, IDENTITY],
      [{ operation: "x", outcome: { status: "weird" as ReceiptInput["outcome"]["status"] } }, IDENTITY],
      [{ operation: "x", outcome: { status: "success" }, project: 5 as unknown as string }, IDENTITY],
      [{ operation: "y".repeat(1000), outcome: { status: "success" } }, IDENTITY],
      [{ operation: "x", outcome: { status: "success" }, metadata: { big: "z".repeat(70_000) } }, IDENTITY],
      [ok("x"), { agentId: "" } as AgentIdentity],
      [ok("x"), { agentId: 7 as unknown as string } as AgentIdentity],
      [{ operation: "x", outcome: { status: "success" }, changes: [{ kind: "file" } as never] }, IDENTITY],
    ];
    for (const [input, id] of bads) {
      await assert.rejects(store.append(input, id), (e: unknown) => e instanceof ReceiptError && e.kind === "invalid_input");
    }
    // Nothing malformed was written.
    assert.equal((await store.readAll()).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { pino, type Logger } from "pino";

import { EventBus } from "./bus.js";
import { defineEvent, type IkbiEvent } from "./contract.js";

function captureLogger(): { logger: Logger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const logger = pino({ level: "trace" }, { write: (s: string) => void lines.push(JSON.parse(s) as Record<string, unknown>) });
  return { logger, lines };
}

function makeBus(maxQueue = 1000) {
  const { logger, lines } = captureLogger();
  return { bus: new EventBus({ logger, defaultMaxQueue: maxQueue }), lines };
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
async function until(cond: () => boolean, tries = 1000): Promise<void> {
  for (let i = 0; i < tries && !cond(); i += 1) await tick();
}

test("publish / subscribe / unsubscribe; in-order delivery (async handler)", async () => {
  const { bus } = makeBus();
  const got: number[] = [];
  const sub = bus.subscribe<number>({}, async (e) => {
    await tick();
    got.push(e.payload);
  });
  for (let i = 1; i <= 10; i += 1) bus.publish({ type: "t", payload: i });
  await bus.flush();
  assert.deepEqual(got, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "delivered in publish order");

  sub.unsubscribe();
  bus.publish({ type: "t", payload: 99 });
  await bus.flush();
  assert.deepEqual(got, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "no delivery after unsubscribe");
});

test("a throwing subscriber is isolated: others still receive, bus survives, failure logged", async () => {
  const { bus, lines } = makeBus();
  const good: number[] = [];
  const bad = bus.subscribe({}, () => {
    throw new Error("boom");
  });
  bus.subscribe<number>({}, (e) => {
    good.push(e.payload);
  });
  for (let i = 1; i <= 3; i += 1) bus.publish({ type: "t", payload: i });
  await bus.flush();
  assert.deepEqual(good, [1, 2, 3], "the good subscriber received everything");
  assert.equal(bad.stats().failures, 3, "the bad handler's failures were counted");
  assert.ok(lines.some((l) => l.event === "bus_handler_failed"), "failure was logged");
});

test("a slow subscriber does not block emitters or other subscribers", async () => {
  const { bus } = makeBus();
  const g = gate();
  const slow: number[] = [];
  const fast: number[] = [];
  bus.subscribe<number>({}, async (e) => {
    await g.promise;
    slow.push(e.payload);
  });
  bus.subscribe<number>({}, (e) => {
    fast.push(e.payload);
  });

  for (let i = 1; i <= 5; i += 1) bus.publish({ type: "t", payload: i }); // returns immediately (non-blocking)

  await until(() => fast.length === 5);
  assert.deepEqual(fast, [1, 2, 3, 4, 5], "fast subscriber delivered while slow is blocked");
  assert.equal(slow.length, 0, "slow subscriber is still blocked, not affecting the fast one");

  g.release();
  await bus.flush();
  assert.deepEqual(slow, [1, 2, 3, 4, 5], "slow subscriber catches up after unblocking, in order");
});

test("bounded buffer: drop_oldest at the bound, loudly logged + counted (not silent)", async () => {
  const { bus, lines } = makeBus();
  const g = gate();
  const got: number[] = [];
  const sub = bus.subscribe<number>({ maxQueue: 3, dropPolicy: "drop_oldest", label: "saturated" }, async (e) => {
    await g.promise;
    got.push(e.payload);
  });
  for (let i = 1; i <= 10; i += 1) bus.publish({ type: "t", payload: i });

  // Event 1 is in-flight (gated); queue holds 3 (8,9,10); 6 were dropped.
  assert.equal(sub.stats().dropped, 6, "exactly the overflow was dropped");
  assert.equal(sub.stats().queued, 3);
  assert.ok(lines.some((l) => l.event === "bus_backpressure_drop"), "drops are logged, never silent");

  g.release();
  await bus.flush();
  assert.deepEqual(got, [1, 8, 9, 10], "the in-flight + last-3-queued were delivered");
  assert.equal(sub.stats().delivered, 4);
});

test("bounded buffer: drop_newest rejects the incoming event at the bound", async () => {
  const { bus } = makeBus();
  const g = gate();
  const got: number[] = [];
  const sub = bus.subscribe<number>({ maxQueue: 3, dropPolicy: "drop_newest" }, async (e) => {
    await g.promise;
    got.push(e.payload);
  });
  for (let i = 1; i <= 10; i += 1) bus.publish({ type: "t", payload: i });
  // 1 in-flight, queue keeps the first 3 that arrived (2,3,4); the rest rejected.
  assert.equal(sub.stats().dropped, 6);
  g.release();
  await bus.flush();
  assert.deepEqual(got, [1, 2, 3, 4]);
});

test("attribution and envelope fields are carried correctly", async () => {
  const { bus } = makeBus();
  let received: IkbiEvent | undefined;
  bus.subscribe({}, (e) => {
    received = e;
  });
  bus.publish({
    type: "model.invoked",
    payload: { tokens: 10 },
    source: "provider",
    attribution: { identity: { agentId: "builder-3", trustTier: "verified" }, operation: "model.invoke", runId: "run-1" },
  });
  await bus.flush();
  assert.ok(received);
  assert.equal(received?.attribution?.identity?.agentId, "builder-3");
  assert.equal(received?.attribution?.runId, "run-1");
  assert.equal(received?.source, "provider");
  assert.equal(received?.seq, 1);
  assert.equal(received?.contractVersion, "1.0.0");
  assert.match(received?.id ?? "", /^[a-f0-9]{24}$/);
});

test("filter targeting: types / typePrefix / source / agentId / predicate", async () => {
  const { bus } = makeBus();
  const exact: string[] = [];
  const prefix: string[] = [];
  const bySource: string[] = [];
  const byAgent: string[] = [];
  const byPred: number[] = [];
  bus.subscribe({ types: ["a.x"] }, (e) => void exact.push(e.type));
  bus.subscribe({ typePrefix: "worker." }, (e) => void prefix.push(e.type));
  bus.subscribe({ source: "prov" }, (e) => void bySource.push(e.type));
  bus.subscribe({ agentId: "agent-1" }, (e) => void byAgent.push(e.type));
  bus.subscribe<number>({ predicate: (e) => e.payload === 42 }, (e) => {
    byPred.push(e.payload);
  });

  bus.publish({ type: "a.x", payload: 1 });
  bus.publish({ type: "b.y", payload: 2 });
  bus.publish({ type: "worker.progress", payload: 3 });
  bus.publish({ type: "worker.done", payload: 4, source: "prov" });
  bus.publish({ type: "c.z", payload: 5, attribution: { identity: { agentId: "agent-1" } } });
  bus.publish({ type: "d.w", payload: 42 });
  await bus.flush();

  assert.deepEqual(exact, ["a.x"]);
  assert.deepEqual(prefix, ["worker.progress", "worker.done"]);
  assert.deepEqual(bySource, ["worker.done"]);
  assert.deepEqual(byAgent, ["c.z"]);
  assert.deepEqual(byPred, [42]);
});

test("defineEvent provides typed create + narrowing", async () => {
  const { bus } = makeBus();
  const Progress = defineEvent<{ pct: number }>("worker.progress");
  let pct = -1;
  bus.subscribe({ types: [Progress.type] }, (e) => {
    if (Progress.is(e)) pct = e.payload.pct;
  });
  bus.publish(Progress.create({ pct: 75 }, { source: "worker" }));
  await bus.flush();
  assert.equal(pct, 75);
});

test("flush resolves once all subscribers have drained", async () => {
  const { bus } = makeBus();
  const got: number[] = [];
  bus.subscribe<number>({}, async (e) => {
    await tick();
    got.push(e.payload);
  });
  bus.publish({ type: "t", payload: 1 });
  bus.publish({ type: "t", payload: 2 });
  await bus.flush();
  assert.deepEqual(got, [1, 2]);
});

test("H4: a throw in the drain machinery is contained (no unhandledRejection), logged as bus_drain_failed", async () => {
  // A logger whose .warn throws — so when a throwing handler triggers the failure-logging path
  // INSIDE drain(), drain()'s own machinery throws. Without kickDrain's terminal .catch this would
  // surface as an unhandledRejection on the shared bus. The .error path records the containment.
  const errorObjs: Array<Record<string, unknown>> = [];
  const throwingLogger = {
    debug: () => {},
    info: () => {},
    warn: () => { throw new Error("logger.warn boom"); },
    error: (obj: Record<string, unknown>) => void errorObjs.push(obj),
  } as unknown as Logger;
  const bus = new EventBus({ logger: throwingLogger, defaultMaxQueue: 1000 });

  bus.subscribe({}, () => { throw new Error("handler boom"); }); // triggers the (throwing) warn path
  bus.publish({ type: "t", payload: 1 });
  await bus.flush(); // resolves (does NOT reject) — the rejection was contained

  const drainFail = errorObjs.find((o) => o.event === "bus_drain_failed");
  assert.ok(drainFail, "the drain-machinery throw was caught and logged as bus_drain_failed");
});

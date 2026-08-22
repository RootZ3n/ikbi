/**
 * The BOUNDED SHUTDOWN contract.
 *
 * The defect these pin is an asymmetry, not a crash: SIGTERM forced an exit after a fixed window
 * and SIGINT waited on `retainAllLive` with no bound at all. Because retention takes the
 * per-workspace lock sequentially, and that lock waits `IKBI_LOCK_TIMEOUT_MS` per workspace when a
 * peer process holds it, Ctrl-C during verification sat unresponsive for the whole lock timeout —
 * measured at 30s against a 30s timeout, where SIGTERM on identical state was out in 3s.
 *
 * Everything here is injected: no real signal is installed, no real timer is waited on, and no real
 * process is killed. A suite that needed three real seconds to prove a three-second bound would be
 * the reason nobody ran it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SHUTDOWN_RETAIN_WINDOW_MS,
  installSignalShutdown,
  runBoundedShutdown,
  type InstallSignalShutdownDeps,
} from "./shutdown.js";

/** A shutdown harness whose timer, exit, output and children are all inspectable. */
function harness(opts: {
  retain?: () => Promise<number>;
  children?: number;
} = {}) {
  const written: string[] = [];
  const exits: number[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const handlers = new Map<string, () => void>();
  let killed = 0;
  const deps: InstallSignalShutdownDeps = {
    retainAllLive: opts.retain ?? (async () => 1),
    terminateChildren: () => {
      killed += 1;
      return opts.children ?? 0;
    },
    write: (l) => written.push(l),
    exit: (c) => exits.push(c),
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return { unref: () => undefined };
    },
    on: (sig, h) => handlers.set(sig, h),
  };
  return {
    deps,
    written,
    exits,
    timers,
    handlers,
    out: () => written.join(""),
    killCalls: () => killed,
    /** Fire the pending forced-exit timer, as the event loop would at the window. */
    fireTimer: () => timers.at(-1)?.fn(),
  };
}

/** Let queued microtasks (the retain promise chain) run. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

test("shutdown: SIGINT forces an exit after the window when retention does not finish", async () => {
  // A retain that never settles is exactly the contended-lock case: the CLI waited the full
  // IKBI_LOCK_TIMEOUT_MS, once per live workspace, with nothing bounding it.
  const h = harness({ retain: () => new Promise<number>(() => {}) });
  runBoundedShutdown("SIGINT", 130, h.deps);
  await settle();

  assert.deepEqual(h.exits, [], "must not have exited before the window elapsed");
  assert.equal(h.timers.at(-1)?.ms, SHUTDOWN_RETAIN_WINDOW_MS, "the window must be the shared constant");

  h.fireTimer();
  assert.deepEqual(h.exits, [130], "a forced SIGINT shutdown exits 130");
});

test("shutdown: SIGINT and SIGTERM use the SAME bounded window", () => {
  const int = harness({ retain: () => new Promise<number>(() => {}) });
  const term = harness({ retain: () => new Promise<number>(() => {}) });
  runBoundedShutdown("SIGINT", 130, int.deps);
  runBoundedShutdown("SIGTERM", 143, term.deps);
  // The whole defect was these two numbers differing — one of them being Infinity.
  assert.equal(int.timers.at(-1)?.ms, term.timers.at(-1)?.ms);
  assert.equal(int.timers.at(-1)?.ms, SHUTDOWN_RETAIN_WINDOW_MS);
});

test("shutdown: SIGTERM still exits 143", async () => {
  const h = harness({ retain: async () => 2 });
  runBoundedShutdown("SIGTERM", 143, h.deps);
  await settle();
  assert.deepEqual(h.exits, [143]);
});

test("shutdown: a forced exit is REPORTED as forced, never as retained", async () => {
  const h = harness({ retain: () => new Promise<number>(() => {}) });
  runBoundedShutdown("SIGINT", 130, h.deps);
  await settle();
  h.fireTimer();

  const out = h.out();
  assert.match(out, /retention did not finish within 3000ms/, "the operator must be told the window expired");
  assert.match(out, /forcing exit/);
  assert.match(out, /may still be recorded in progress/, "and told the records may need reconciling");
  assert.doesNotMatch(out, /retained \d+ in-progress workspace/, "a forced exit must never claim retention");
});

test("shutdown: a graceful retention reports the count it actually marked", async () => {
  const h = harness({ retain: async () => 3 });
  runBoundedShutdown("SIGINT", 130, h.deps);
  await settle();

  assert.match(h.out(), /retained 3 in-progress workspace\(s\)/);
  assert.doesNotMatch(h.out(), /forcing exit/);
  assert.deepEqual(h.exits, [130]);
});

test("shutdown: nothing live is said plainly, not reported as a retention of zero", async () => {
  const h = harness({ retain: async () => 0 });
  runBoundedShutdown("SIGINT", 130, h.deps);
  await settle();
  assert.match(h.out(), /nothing in progress to retain/);
});

test("shutdown: a retain that THROWS still exits, and says the work is on disk", async () => {
  const h = harness({ retain: async () => { throw new Error("store unwritable"); } });
  runBoundedShutdown("SIGINT", 130, h.deps);
  await settle();

  assert.match(h.out(), /retention failed/);
  assert.match(h.out(), /work is still on disk/);
  assert.deepEqual(h.exits, [130], "a failed retain must not become a hang");
});

test("shutdown: children are killed on the GRACEFUL path", async () => {
  const h = harness({ retain: async () => 1, children: 2 });
  runBoundedShutdown("SIGINT", 130, h.deps);
  await settle();
  assert.equal(h.killCalls(), 1);
  assert.match(h.out(), /Killed 2 running child process\(es\)/);
});

test("shutdown: children are killed on the FORCED path too", async () => {
  // The leak this pins was measured: a `sleep` check survived the interrupt, reparented to init,
  // still burning a worktree the operator had already walked away from.
  const h = harness({ retain: () => new Promise<number>(() => {}), children: 1 });
  runBoundedShutdown("SIGINT", 130, h.deps);
  await settle();
  h.fireTimer();
  assert.equal(h.killCalls(), 1, "a forced exit must still reclaim what it started");
  assert.match(h.out(), /Killed 1 running child process\(es\)/);
});

test("shutdown: the window firing after a graceful retain cannot exit twice", async () => {
  const h = harness({ retain: async () => 1 });
  runBoundedShutdown("SIGINT", 130, h.deps);
  await settle();
  h.fireTimer(); // a late timer, as an unref'd timer can still fire
  assert.deepEqual(h.exits, [130], "settled once means exactly one exit");
  assert.equal(h.killCalls(), 1, "and exactly one round of child cleanup");
});

test("shutdown: a SECOND SIGINT exits immediately without a second retention", async () => {
  let retainCalls = 0;
  const h = harness({
    retain: () => {
      retainCalls += 1;
      return new Promise<number>(() => {});
    },
  });
  installSignalShutdown("SIGINT", 130, "interrupted\n", h.deps);
  const handler = h.handlers.get("SIGINT")!;

  handler();
  await settle();
  assert.deepEqual(h.exits, [], "the first Ctrl-C waits for the bounded retention");

  handler();
  assert.deepEqual(h.exits, [130], "the second Ctrl-C exits at once — the operator is done waiting");
  assert.equal(retainCalls, 1, "a second retention attempt would only add delay");
});

test("shutdown: the first SIGINT announces itself; SIGTERM does not", () => {
  const int = harness({ retain: () => new Promise<number>(() => {}) });
  installSignalShutdown("SIGINT", 130, "\nikbi: interrupted — retaining…\n", int.deps);
  int.handlers.get("SIGINT")!();
  assert.match(int.out(), /interrupted — retaining/);

  const term = harness({ retain: () => new Promise<number>(() => {}) });
  installSignalShutdown("SIGTERM", 143, "", term.deps);
  term.handlers.get("SIGTERM")!();
  assert.equal(term.out(), "", "an orchestrator's SIGTERM has no operator to announce anything to");
});

test("shutdown: the retain reason names the signal, so the record says what stopped it", async () => {
  const reasons: string[] = [];
  const h = harness({ retain: async () => 1 });
  const deps = { ...h.deps, retainAllLive: async (r: string) => { reasons.push(r); return 1; } };
  runBoundedShutdown("SIGINT", 130, deps);
  await settle();
  assert.deepEqual(reasons, ["interrupted by SIGINT"]);
});

/**
 * The LIVE EXEC CHILDREN registry.
 *
 * What this pins is a leak that was measured, not imagined: a governed check (`sleep`) spawned
 * during verification survived the CLI's interrupt, was reparented to init, and kept running in a
 * worktree the operator had already abandoned. Neither process-group trick covers both exec
 * primitives — the streaming one detaches (so a TTY Ctrl-C never reaches it) and the buffered one
 * does not (so a pid-directed signal never reaches it) — which is why there is a registry at all.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  liveExecChildCount,
  resetExecChildRegistry,
  terminateLiveExecChildren,
  trackExecChild,
  type TrackedChild,
} from "./children.js";

/** A child that records how it was signalled. `killThrows` stands for one that already died. */
function fakeChild(pid: number | undefined, killThrows = false): TrackedChild & { killed: number } {
  return {
    pid,
    killed: 0,
    kill(this: { killed: number }) {
      if (killThrows) throw new Error("ESRCH");
      this.killed += 1;
      return true;
    },
  } as TrackedChild & { killed: number };
}

test("exec children: a tracked child is live until released", () => {
  resetExecChildRegistry();
  const release = trackExecChild(fakeChild(101), { detached: false });
  assert.equal(liveExecChildCount(), 1);
  release();
  assert.equal(liveExecChildCount(), 0);
});

test("exec children: releasing twice is harmless", () => {
  resetExecChildRegistry();
  const release = trackExecChild(fakeChild(101), { detached: false });
  release();
  release();
  assert.equal(liveExecChildCount(), 0);
});

test("exec children: a DETACHED child is killed by process GROUP, so grandchildren go too", () => {
  resetExecChildRegistry();
  const groups: number[] = [];
  const child = fakeChild(202);
  trackExecChild(child, { detached: true });

  const n = terminateLiveExecChildren((pid) => groups.push(pid));
  assert.equal(n, 1);
  assert.deepEqual(groups, [202], "the streaming primitive leads its own group — kill the tree");
  assert.equal(child.killed, 0, "killing the child alone would orphan its grandchildren");
});

test("exec children: a NON-detached child is killed directly, never by group", () => {
  resetExecChildRegistry();
  const groups: number[] = [];
  const child = fakeChild(303);
  trackExecChild(child, { detached: false });

  terminateLiveExecChildren((pid) => groups.push(pid));
  // Signalling the group here would signal OUR OWN group — this process included.
  assert.deepEqual(groups, [], "a child sharing our group must never be killed by group");
  assert.equal(child.killed, 1);
});

test("exec children: terminate empties the registry, so a second call is a no-op", () => {
  resetExecChildRegistry();
  trackExecChild(fakeChild(1), { detached: false });
  trackExecChild(fakeChild(2), { detached: false });

  assert.equal(terminateLiveExecChildren(() => undefined), 2);
  assert.equal(liveExecChildCount(), 0);
  assert.equal(terminateLiveExecChildren(() => undefined), 0);
});

test("exec children: a child that already died does not break the shutdown", () => {
  resetExecChildRegistry();
  trackExecChild(fakeChild(4, true), { detached: false });
  const alive = fakeChild(5);
  trackExecChild(alive, { detached: false });

  // A dead child is the ORDINARY case during shutdown, not an error — and it must not stop the
  // rest of the sweep, or one corpse would strand every child registered after it.
  assert.doesNotThrow(() => terminateLiveExecChildren(() => undefined));
  assert.equal(alive.killed, 1);
  assert.equal(liveExecChildCount(), 0);
});

test("exec children: a group kill that throws falls back to killing the child alone", () => {
  resetExecChildRegistry();
  const child = fakeChild(606);
  trackExecChild(child, { detached: true });

  const n = terminateLiveExecChildren(() => { throw new Error("ESRCH"); });
  assert.equal(child.killed, 1, "a vanished group still leaves a child worth signalling");
  assert.equal(n, 1);
});

test("exec children: a detached child with NO pid falls back to a direct kill", () => {
  resetExecChildRegistry();
  const groups: number[] = [];
  const child = fakeChild(undefined);
  trackExecChild(child, { detached: true });

  terminateLiveExecChildren((pid) => groups.push(pid));
  // `process.kill(-undefined)` is not a group; guessing a pid would signal something else entirely.
  assert.deepEqual(groups, []);
  assert.equal(child.killed, 1);
});

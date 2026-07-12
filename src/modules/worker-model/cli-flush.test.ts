import assert from "node:assert/strict";
import { test } from "node:test";

import { flushBestEffort } from "./cli.js";

// Regression: a stuck subscriber drain must never suppress the build result envelope.
// flushBestEffort bounds the drain by wall-clock and never throws, so the caller always
// proceeds to print the summary even when eventBus.flush() hangs or rejects.

test("flushBestEffort returns promptly when flush resolves fast", async () => {
  let called = false;
  const bus = {
    flush: async () => {
      called = true;
    },
  };
  const start = Date.now();
  await flushBestEffort(bus, 2000);
  assert.equal(called, true);
  // Fast path must not wait for the timeout.
  assert.ok(Date.now() - start < 500, "resolved-fast flush should not wait for the timeout");
});

test("flushBestEffort returns within the timeout when flush never resolves", async () => {
  const bus = {
    // Simulates the observed hang: a drain promise that never settles.
    flush: () => new Promise<void>(() => {}),
  };
  const start = Date.now();
  await flushBestEffort(bus, 60);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 50, "should wait for roughly the timeout window");
  assert.ok(elapsed < 2000, "must not hang past the timeout");
});

test("flushBestEffort swallows a rejecting flush", async () => {
  const bus = {
    flush: async () => {
      throw new Error("drain blew up");
    },
  };
  // Must not throw — the envelope has to print regardless.
  await flushBestEffort(bus, 2000);
});

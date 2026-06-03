import assert from "node:assert/strict";
import { test } from "node:test";

import { CircuitBreaker } from "./circuit-breaker.js";

function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test("closed by default; allows attempts", () => {
  const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, halfOpenMaxTrials: 1 });
  assert.equal(cb.snapshot().state, "closed");
  assert.equal(cb.canAttempt(), true);
});

test("opens after N consecutive failures and then skips", () => {
  const clock = fakeClock();
  const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, halfOpenMaxTrials: 1, now: clock.now });
  cb.recordFailure();
  cb.recordFailure();
  assert.equal(cb.snapshot().state, "closed", "still closed before threshold");
  assert.equal(cb.canAttempt(), true);
  cb.recordFailure(); // 3rd -> opens
  assert.equal(cb.snapshot().state, "open");
  assert.equal(cb.canAttempt(), false, "skips while open during cooldown");
});

test("a success resets the failure counter (no premature trip)", () => {
  const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, halfOpenMaxTrials: 1 });
  cb.recordFailure();
  cb.recordFailure();
  cb.recordSuccess(); // reset
  cb.recordFailure();
  cb.recordFailure();
  assert.equal(cb.snapshot().state, "closed", "two more failures after reset is below threshold");
});

test("recovers after cooldown: half-open trial succeeds -> closed", () => {
  const clock = fakeClock();
  const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, halfOpenMaxTrials: 1, now: clock.now });
  cb.recordFailure();
  cb.recordFailure(); // open
  assert.equal(cb.canAttempt(), false);

  clock.advance(999);
  assert.equal(cb.canAttempt(), false, "still in cooldown");

  clock.advance(1); // cooldown elapsed
  assert.equal(cb.canAttempt(), true, "half-open trial allowed");
  assert.equal(cb.snapshot().state, "half_open");
  assert.equal(cb.canAttempt(), false, "only halfOpenMaxTrials trial(s) allowed");

  cb.recordSuccess();
  assert.equal(cb.snapshot().state, "closed", "successful trial closes the circuit");
  assert.equal(cb.canAttempt(), true);
});

test("half-open admits only one concurrent probe (serialized)", () => {
  const clock = fakeClock();
  const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, halfOpenMaxTrials: 1, now: clock.now });
  cb.recordFailure(); // open
  clock.advance(1000);

  // Two concurrent canAttempt() before either records — only one may pass.
  const a = cb.canAttempt();
  const b = cb.canAttempt();
  assert.equal(a, true);
  assert.equal(b, false, "second concurrent half-open probe is denied");
  assert.equal(cb.snapshot().state, "half_open");
  assert.equal(cb.snapshot().halfOpenInFlight, 1);

  cb.recordSuccess();
  assert.equal(cb.snapshot().state, "closed");
  assert.equal(cb.snapshot().halfOpenInFlight, 0);
});

test("recordIgnoredFailure releases a half-open probe without tripping", () => {
  const clock = fakeClock();
  const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, halfOpenMaxTrials: 1, now: clock.now });
  cb.recordFailure(); // open
  clock.advance(1000);
  assert.equal(cb.canAttempt(), true); // probe reserved
  cb.recordIgnoredFailure(); // permanent error -> release the slot, don't reopen or count
  assert.equal(cb.snapshot().state, "half_open", "stays half-open, not reopened");
  assert.equal(cb.snapshot().consecutiveFailures, 1, "failure count unchanged by ignored failure");
  assert.equal(cb.canAttempt(), true, "released slot lets another probe proceed");
});

test("half-open trial failure re-opens for another cooldown", () => {
  const clock = fakeClock();
  const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 500, halfOpenMaxTrials: 1, now: clock.now });
  cb.recordFailure(); // open
  clock.advance(500);
  assert.equal(cb.canAttempt(), true, "half-open trial");
  cb.recordFailure(); // trial failed -> reopen
  assert.equal(cb.snapshot().state, "open");
  assert.equal(cb.canAttempt(), false, "reopened, back in cooldown");
  clock.advance(500);
  assert.equal(cb.canAttempt(), true, "recovers again after another cooldown");
});

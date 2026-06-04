import assert from "node:assert/strict";
import { test } from "node:test";

import { events } from "./events/index.js";
import { KILL_EVENT_TYPE, killTargets, onKill, publishKill, type KillSignal } from "./kill-switch.js";

test("a kill signal publishes and subscribers receive it (on the frozen bus)", async () => {
  const got: KillSignal[] = [];
  const sub = onKill((signal) => {
    got.push(signal);
  });

  const env = publishKill({ reason: "operator", mode: "hard", scope: "engine", note: "halt" });
  assert.equal(env.type, KILL_EVENT_TYPE);
  assert.equal(typeof env.seq, "number");

  await events.flush();
  sub.unsubscribe();

  assert.equal(got.length, 1);
  assert.deepEqual(got[0], { reason: "operator", mode: "hard", scope: "engine", note: "halt" });
});

test("killTargets: the in-flight check honors scope (engine / agent / run / operation)", () => {
  const ctx = { agentId: "builder-3", runId: "run-9", requestId: "req-1" };

  assert.equal(killTargets({ reason: "shutdown", mode: "soft", scope: "engine" }, ctx), true, "engine targets all");

  assert.equal(killTargets({ reason: "policy", mode: "hard", scope: "agent", target: "builder-3" }, ctx), true);
  assert.equal(killTargets({ reason: "policy", mode: "hard", scope: "agent", target: "other" }, ctx), false);

  assert.equal(killTargets({ reason: "degraded", mode: "soft", scope: "run", target: "run-9" }, ctx), true);
  assert.equal(killTargets({ reason: "degraded", mode: "soft", scope: "run", target: "run-x" }, ctx), false);

  assert.equal(killTargets({ reason: "operator", mode: "hard", scope: "operation", target: "req-1" }, ctx), true);
  assert.equal(killTargets({ reason: "operator", mode: "hard", scope: "operation", target: "req-2" }, ctx), false);
});

test("a scoped signal with no target never matches (fail-closed against over-broad halt)", () => {
  const ctx = { agentId: "a", runId: "r", requestId: "q" };
  assert.equal(killTargets({ reason: "policy", mode: "hard", scope: "agent" }, ctx), false);
});

/**
 * Tests for the recovery driver: it drives the pool to a single terminal verdict, recovers as
 * soon as an attempt goes green, escalates up the ladder, and produces ONE outcome (trust
 * deferral) — feeding trust per-attempt is impossible because the caller only sees `terminal`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { runRecovery, CONSULT_MODEL_ID } from "./index.js";
import type { RecoveryDriverInput, RecoveryExecutors } from "./index.js";
import type { ModelTier } from "./index.js";
import type { RosterModel } from "../model-router/index.js";

const TIER_ROSTERS: Readonly<Record<ModelTier, readonly RosterModel[]>> = {
  worker: [
    { id: "deepseek-v4-flash", costPerMTok: 0.42 },
    { id: "mimo-v2.5", costPerMTok: 0.42 }
  ],
  mid: [
    { id: "mimo-v2.5-pro", costPerMTok: 1.305 },
    { id: "deepseek-v4-pro", costPerMTok: 1.305 },
    { id: "minimax-m3", costPerMTok: 1.5 },
    { id: "glm-5.2", costPerMTok: 5.8 }
  ],
  frontier: [{ id: "sonnet-4.6", costPerMTok: 18 }]
};

function base(over: Partial<RecoveryDriverInput> = {}): RecoveryDriverInput {
  return { seed: { tier: "worker", model: "deepseek-v4-flash" }, tierRosters: TIER_ROSTERS, ...over };
}

/** An executor that returns green for the named models, fail otherwise; records the call order. */
function executors(greenModels: string[], consultGreen = false): RecoveryExecutors & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    attempt: async ({ model }) => {
      calls.push(model);
      return { green: greenModels.includes(model) };
    },
    consult: async () => {
      calls.push(CONSULT_MODEL_ID);
      return { green: consultGreen };
    }
  };
}

test("recovers as soon as a pool model goes green; stops there", async () => {
  const ex = executors(["mimo-v2.5-pro"]);
  const r = await runRecovery(base(), ex);
  assert.equal(r.terminal, "recovered");
  assert.deepEqual(r.recoveredBy, { tier: "mid", model: "mimo-v2.5-pro" });
  // tried mimo-v2.5 (worker), then mimo-v2.5-pro (mid) which went green — and stopped
  assert.deepEqual(ex.calls, ["mimo-v2.5", "mimo-v2.5-pro"]);
});

test("one terminal verdict for the whole recovery (trust deferral): 3 fails + 1 green = recovered", async () => {
  const ex = executors(["minimax-m3"]);
  const r = await runRecovery(base(), ex);
  assert.equal(r.terminal, "recovered");
  // seed + mimo-v2.5 + mimo-pro + deepseek-pro + minimax(green) — the caller feeds ONE success, not four failures
  const fails = r.attempts.filter((a) => a.outcome === "fail").length;
  const greens = r.attempts.filter((a) => a.outcome === "green").length;
  assert.equal(greens, 1);
  assert.ok(fails >= 3, "intermediate failures exist in history but only the terminal verdict feeds trust");
});

test("nothing recovers, frontier unauthorized → needs-authorization, consult never called", async () => {
  const ex = executors([]); // everything fails
  const r = await runRecovery(base(), ex);
  assert.equal(r.terminal, "needs-authorization");
  assert.ok(!ex.calls.includes(CONSULT_MODEL_ID), "frontier consult is gated — not called unattended");
});

test("frontier authorized + consult recovers → recovered via consult", async () => {
  const ex = executors([], /*consultGreen*/ true);
  const r = await runRecovery(base({ frontierAuthorized: true }), ex);
  assert.equal(r.terminal, "recovered");
  assert.equal(ex.calls[ex.calls.length - 1], CONSULT_MODEL_ID, "consult was the last (frontier) step");
});

test("frontier authorized but consult also fails → exhausted", async () => {
  const ex = executors([], /*consultGreen*/ false);
  const r = await runRecovery(base({ frontierAuthorized: true }), ex);
  assert.equal(r.terminal, "exhausted");
});

test("autoCeiling=worker keeps recovery inside the worker tier", async () => {
  const ex = executors(["mimo-v2.5-pro"]); // a mid model — but ceiling forbids reaching it
  const r = await runRecovery(base({ autoCeiling: "worker" }), ex);
  assert.equal(r.terminal, "needs-authorization");
  assert.deepEqual(ex.calls, ["mimo-v2.5"], "only the other worker model was tried");
});

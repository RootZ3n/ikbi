/**
 * Tests for the recovery decision core: the worker+mid pool, the monotonic "up the ladder"
 * floor, cheapest-first default selection, caller-requested picks, and the gated frontier.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { decideRecovery, eligiblePool, recoveryFloor } from "./index.js";
import type { ModelTier, RecoveryAttempt, RecoveryInput } from "./index.js";
import type { RosterModel } from "../model-router/index.js";

// Real ikbi tiers + corrected prices (blended in+out).
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
  frontier: [
    { id: "sonnet-4.6", costPerMTok: 18 },
    { id: "opus-4.8", costPerMTok: 30 },
    { id: "gpt-5.5", costPerMTok: 35 }
  ]
};

function input(attempts: RecoveryAttempt[], over: Partial<RecoveryInput> = {}): RecoveryInput {
  return { attempts, tierRosters: TIER_ROSTERS, ...over };
}

function fail(tier: ModelTier, model: string): RecoveryAttempt {
  return { tier, model, outcome: "fail" };
}

test("a verified-green attempt terminates as recovered", () => {
  const a = decideRecovery(input([fail("worker", "deepseek-v4-flash"), { tier: "mid", model: "mimo-v2.5-pro", outcome: "green" }]));
  assert.equal(a.kind, "terminate");
  assert.equal(a.kind === "terminate" && a.terminal, "recovered");
});

test("first move after a worker failure is the cheapest other worker model", () => {
  const a = decideRecovery(input([fail("worker", "deepseek-v4-flash")]));
  assert.equal(a.kind, "attempt");
  assert.equal(a.kind === "attempt" && a.model, "mimo-v2.5");
  assert.equal(a.kind === "attempt" && a.tier, "worker");
});

test("worker exhausted → escalates up into the mid pool (mimo-pro first)", () => {
  const a = decideRecovery(input([fail("worker", "deepseek-v4-flash"), fail("worker", "mimo-v2.5")]));
  assert.equal(a.kind === "attempt" && a.tier, "mid");
  assert.equal(a.kind === "attempt" && a.model, "mimo-v2.5-pro");
});

test("up-the-ladder: once a mid model is used, worker models are NOT eligible again", () => {
  // floor is mid (a mid model was tried); untried worker models must be excluded
  const pool = eligiblePool(input([fail("worker", "deepseek-v4-flash"), fail("mid", "mimo-v2.5-pro")]));
  assert.equal(pool.every((c) => c.tier === "mid"), true);
  assert.equal(pool.some((c) => c.model === "mimo-v2.5"), false, "untried worker model is below the floor");
  assert.equal(recoveryFloor([fail("mid", "mimo-v2.5-pro")]), "mid");
});

test("ikbi can call upon any eligible model it needs (requested pick honored)", () => {
  const a = decideRecovery(input([fail("worker", "deepseek-v4-flash")], { requestedModel: "minimax-m3" }));
  // skipping ahead to a mid model is allowed (up the ladder) even though cheaper ones are untried
  assert.equal(a.kind === "attempt" && a.model, "minimax-m3");
  assert.equal(a.kind === "attempt" && a.requested, true);
});

test("a requested model that would go DOWN the ladder is rejected → cheapest eligible instead", () => {
  // floor is mid; requesting a worker model is ineligible → falls back to cheapest mid
  const a = decideRecovery(input([fail("mid", "mimo-v2.5-pro")], { requestedModel: "deepseek-v4-flash" }));
  assert.equal(a.kind === "attempt" && a.requested, false);
  assert.equal(a.kind === "attempt" && a.tier, "mid");
  assert.equal(a.kind === "attempt" && a.model, "deepseek-v4-pro"); // next cheapest mid
});

test("whole worker+mid pool exhausted, frontier NOT authorized → needs-authorization", () => {
  const all = [
    fail("worker", "deepseek-v4-flash"),
    fail("worker", "mimo-v2.5"),
    fail("mid", "mimo-v2.5-pro"),
    fail("mid", "deepseek-v4-pro"),
    fail("mid", "minimax-m3"),
    fail("mid", "glm-5.2")
  ];
  const a = decideRecovery(input(all));
  assert.equal(a.kind, "terminate");
  assert.equal(a.kind === "terminate" && a.terminal, "needs-authorization");
});

test("pool exhausted + frontier authorized → consult (not a blind swap)", () => {
  const all = [
    fail("worker", "deepseek-v4-flash"),
    fail("worker", "mimo-v2.5"),
    fail("mid", "mimo-v2.5-pro"),
    fail("mid", "deepseek-v4-pro"),
    fail("mid", "minimax-m3"),
    fail("mid", "glm-5.2")
  ];
  const a = decideRecovery(input(all, { frontierAuthorized: true }));
  assert.equal(a.kind, "consult");
  assert.equal(a.kind === "consult" && a.tier, "frontier");
});

test("frontier consult already tried and failed → exhausted", () => {
  const all = [
    fail("worker", "deepseek-v4-flash"),
    fail("worker", "mimo-v2.5"),
    fail("mid", "mimo-v2.5-pro"),
    fail("mid", "deepseek-v4-pro"),
    fail("mid", "minimax-m3"),
    fail("mid", "glm-5.2"),
    fail("frontier", "sonnet-4.6")
  ];
  const a = decideRecovery(input(all, { frontierAuthorized: true }));
  assert.equal(a.kind === "terminate" && a.terminal, "exhausted");
});

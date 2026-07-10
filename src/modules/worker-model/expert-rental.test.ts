/**
 * expert-rental — the cheap-tier coordinator's "rent the cheapest-sufficient expert per sub-task"
 * gate. Mechanical sub-tasks stay on the worker roster; sub-tasks whose goal names reasoning-heavy
 * work are rented UP to the mid roster from the start (no escalation event). Rental never throws.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { estimateTaskTier, rentBuilderExpert } from "./expert-rental.js";

const POOL = {
  worker: ["deepseek-v4-flash", "mimo-v2.5"] as const,
  mid: ["mimo-v2.5-pro", "deepseek-v4-pro"] as const,
  frontier: ["opus-4.8"] as const,
};

test("estimateTaskTier: mechanical goals stay on the cheap worker roster", () => {
  assert.equal(estimateTaskTier("Add two re-export lines to index.ts"), "worker");
  assert.equal(estimateTaskTier("Create a types.ts with three interfaces"), "worker");
});

test("estimateTaskTier: reasoning-heavy goals rent UP to mid", () => {
  assert.equal(estimateTaskTier("Fix the race condition in the scheduler"), "mid");
  assert.equal(estimateTaskTier("Refactor the parser to a state machine"), "mid");
  assert.equal(estimateTaskTier("Optimize the hot path for performance"), "mid");
});

test("estimateTaskTier: --complexity large forces the mid roster regardless of wording", () => {
  assert.equal(estimateTaskTier("add a small helper", "large"), "mid");
});

test("rentBuilderExpert: a mechanical sub-task rents the cheapest worker expert", () => {
  const r = rentBuilderExpert({ goal: "Append an export line to index.ts", tierRosters: POOL, fallback: "deepseek-v4-flash" });
  assert.equal(r.tier, "worker");
  assert.equal(r.modelId, "deepseek-v4-flash", "cheapest-in-roster (roster-first) for mechanical work");
});

test("rentBuilderExpert: a hard sub-task rents a mid-roster (pro) expert up front — no escalation event", () => {
  const r = rentBuilderExpert({ goal: "Debug and fix the failing concurrency test", tierRosters: POOL, fallback: "deepseek-v4-flash" });
  assert.equal(r.tier, "mid");
  assert.equal(r.modelId, "mimo-v2.5-pro", "rents the cheapest mid-roster expert, from the start");
});

test("rentBuilderExpert: an empty roster falls back instead of throwing (rental never breaks a build)", () => {
  const r = rentBuilderExpert({ goal: "do the thing", tierRosters: { worker: [], mid: [], frontier: [] }, fallback: "deepseek-v4-flash" });
  assert.equal(r.modelId, "deepseek-v4-flash");
  assert.match(r.reason, /fell back/);
});

test("rentBuilderExpert: a vendorLane restricts rentals to that vendor's experts (peer duel, not a ladder)", () => {
  const deep = rentBuilderExpert({ goal: "debug the concurrency failure", tierRosters: POOL, fallback: "x", vendorLane: "deepseek" });
  assert.equal(deep.modelId, "deepseek-v4-pro", "deepseek lane rents the deepseek mid expert");
  const mimo = rentBuilderExpert({ goal: "debug the concurrency failure", tierRosters: POOL, fallback: "x", vendorLane: "mimo" });
  assert.equal(mimo.modelId, "mimo-v2.5-pro", "mimo lane rents the mimo mid expert — a genuine peer, different vendor");
});

test("rentBuilderExpert: a vendorLane that empties a tier falls back to the full roster (never strands)", () => {
  // A mechanical task rents the worker tier; the "mimo" lane there is ["mimo-v2.5"], non-empty.
  const r = rentBuilderExpert({ goal: "append an export line", tierRosters: POOL, fallback: "x", vendorLane: "nonexistent-vendor" });
  assert.equal(r.modelId, "deepseek-v4-flash", "an unknown lane empties every tier → full-roster fallback (cheapest worker)");
});

test("rentBuilderExpert: an explicit tierOverride skips the heuristic", () => {
  const r = rentBuilderExpert({ goal: "trivial mechanical edit", tierRosters: POOL, fallback: "deepseek-v4-flash", tierOverride: "mid" });
  assert.equal(r.tier, "mid");
  assert.equal(r.modelId, "mimo-v2.5-pro");
});

/**
 * expert-rental — the cheap-tier coordinator's "rent the cheapest-sufficient expert per sub-task"
 * gate. Mechanical sub-tasks stay on the worker roster; sub-tasks whose goal names reasoning-heavy
 * work are rented UP to the mid roster from the start (no escalation event). Rental never throws.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { estimateTaskTier, rentBuilderExpert, classifyTaskTier, resolveClassifierModel } from "./expert-rental.js";

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

// ── SEMANTIC DIFFICULTY ROUTER ──────────────────────────────────────────────────

test("classifyTaskTier: a model verdict of mid routes the sub-task up (source=model)", async () => {
  const v = await classifyTaskTier("compute the union bounding box over a node and all its descendants", async () => '{"tier":"mid","rationale":"recursive subtree traversal"}');
  assert.equal(v.tier, "mid");
  assert.equal(v.source, "model");
  assert.match(v.rationale, /recursive/);
});

test("classifyTaskTier: a model verdict of worker keeps a trivial sub-task cheap", async () => {
  const v = await classifyTaskTier("add two re-export lines to index.ts", async () => 'sure: {"tier":"worker","rationale":"mechanical re-export"}');
  assert.equal(v.tier, "worker");
  assert.equal(v.source, "model");
});

test("classifyTaskTier: a throwing classifier falls back to the heuristic (never blocks a build)", async () => {
  const v = await classifyTaskTier("traverse the tree depth-first", async () => { throw new Error("provider down"); });
  assert.equal(v.source, "heuristic");
  assert.equal(v.tier, "mid", "the heuristic still catches 'traverse' as a behavioral difficulty cue");
});

test("classifyTaskTier: unparseable output falls back to the heuristic", async () => {
  const v = await classifyTaskTier("append an export line", async () => "I think this is easy, honestly");
  assert.equal(v.source, "heuristic");
  assert.equal(v.tier, "worker");
});

test("classifyTaskTier: a frontier verdict is clamped to the cheap-tier ceiling (mid)", async () => {
  const v = await classifyTaskTier("write a novel distributed consensus algorithm", async () => '{"tier":"frontier","rationale":"very hard"}');
  assert.equal(v.tier, "mid", "the cheap tier's 4-model pool never rents frontier");
});

test("classifyTaskTier: --complexity large short-circuits to mid with NO classifier call", async () => {
  let called = false;
  const v = await classifyTaskTier("anything", async () => { called = true; return '{"tier":"worker"}'; }, { complexity: "large" });
  assert.equal(v.tier, "mid");
  assert.equal(called, false, "an explicit operator signal skips the model call");
});

test("resolveClassifierModel: resolves the cheapest worker-tier model", () => {
  const m = resolveClassifierModel(POOL, "fallback");
  assert.equal(m, "deepseek-v4-flash", "classifier role is worker-pinned → cheapest worker");
});

test("resolveClassifierModel: an empty pool falls back instead of throwing", () => {
  assert.equal(resolveClassifierModel({ worker: [], mid: [], frontier: [] }, "fallback-model"), "fallback-model");
});

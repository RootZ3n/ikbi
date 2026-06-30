/**
 * Tests for the model-router: tier clamping by role bounds, cheapest-good-enough selection
 * within a tier (Luak), roster-first fallback, empty-roster downshift, and consultModel.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clampTier,
  consultModel,
  ModelRouterError,
  rankModelsInTier,
  resolveModel,
  rosterFromIds,
  selectModelInTier,
  tierBounds
} from "./index.js";
import type { LuakLeaderboardEntry, ModelTier, RosterModel } from "./index.js";

const TIER_ROSTERS: Readonly<Record<ModelTier, readonly RosterModel[]>> = {
  worker: [
    { id: "deepseek-v4-flash", costPerMTok: 0.3 },
    { id: "minimax-m3", costPerMTok: 0.2 }
  ],
  mid: [
    { id: "deepseek-v4-pro", costPerMTok: 2.0 },
    { id: "glm-5.2", costPerMTok: 1.5 }
  ],
  frontier: [
    { id: "gpt-5.5", costPerMTok: 12 },
    { id: "opus-4.8", costPerMTok: 15 }
  ]
};

test("scout is pinned to worker — a frontier request is clamped down", () => {
  const r = resolveModel({ role: "scout", requestedTier: "frontier", tierRosters: TIER_ROSTERS });
  assert.equal(r.tier, "worker");
  assert.equal(r.clampedFrom, "frontier");
  assert.equal(tierBounds("scout").ceiling, "worker");
});

test("consultant is pinned to frontier — a worker request is clamped up", () => {
  const r = resolveModel({ role: "consultant", requestedTier: "worker", tierRosters: TIER_ROSTERS });
  assert.equal(r.tier, "frontier");
  assert.equal(r.clampedFrom, "worker");
});

test("clampTier leaves an in-range tier untouched", () => {
  assert.equal(clampTier("mid", tierBounds("builder")), "mid");
});

test("within a tier, no leaderboard -> roster-first fallback (intended primary kept)", () => {
  const r = resolveModel({ role: "builder", requestedTier: "worker", tierRosters: TIER_ROSTERS });
  assert.equal(r.tier, "worker");
  assert.equal(r.via, "roster-first-fallback");
  assert.equal(r.modelId, "deepseek-v4-flash"); // first of the worker roster
});

test("within a tier, Luak picks the cheapest model scoring above the floor", () => {
  const leaderboard: LuakLeaderboardEntry[] = [
    { modelId: "deepseek-v4-flash", reliability_score: 80 },
    { modelId: "minimax-m3", reliability_score: 75 }
  ];
  // both qualify at minScore 50 -> cheapest (minimax @0.2) wins over deepseek @0.3
  const sel = selectModelInTier(TIER_ROSTERS.worker, leaderboard, 50);
  assert.ok(sel);
  assert.equal(sel.via, "luak-cheapest-above-threshold");
  assert.equal(sel.modelId, "minimax-m3");
});

test("minScore floor excludes models that score too low", () => {
  const leaderboard: LuakLeaderboardEntry[] = [
    { modelId: "deepseek-v4-flash", reliability_score: 90 },
    { modelId: "minimax-m3", reliability_score: 40 }
  ];
  // minimax (cheaper) is below the floor -> deepseek is the cheapest QUALIFYING one
  const sel = selectModelInTier(TIER_ROSTERS.worker, leaderboard, 50);
  assert.equal(sel?.modelId, "deepseek-v4-flash");
});

test("empty roster at the resolved tier downshifts to the nearest in-bounds tier", () => {
  const rosters: Record<ModelTier, readonly RosterModel[]> = {
    worker: rosterFromIds(["deepseek-v4-flash"]),
    mid: [],
    frontier: rosterFromIds(["opus-4.8"])
  };
  const r = resolveModel({ role: "builder", requestedTier: "mid", tierRosters: rosters });
  assert.equal(r.tier, "worker");
  assert.equal(r.rosterFallbackFrom, "mid");
});

test("throws ModelRouterError when no roster exists anywhere in the role's bounds", () => {
  const rosters: Record<ModelTier, readonly RosterModel[]> = { worker: [], mid: [], frontier: [] };
  assert.throws(
    () => resolveModel({ role: "scout", requestedTier: "worker", tierRosters: rosters }),
    ModelRouterError
  );
});

test("rankModelsInTier: equal-priced pros -> Luak reasoning breaks the tie, mimo-v2.5-pro first", () => {
  const proPair: RosterModel[] = [
    { id: "deepseek-v4-pro", costPerMTok: 1.305 },
    { id: "mimo-v2.5-pro", costPerMTok: 1.305 } // identical real price ($0.435/$0.87)
  ];
  const leaderboard: LuakLeaderboardEntry[] = [
    { modelId: "deepseek-v4-pro", reliability_score: 70 },
    { modelId: "mimo-v2.5-pro", reliability_score: 85 } // ~21% higher reasoning
  ];
  const order = rankModelsInTier(proPair, leaderboard).map((c) => c.id);
  assert.deepEqual(order, ["mimo-v2.5-pro", "deepseek-v4-pro"]);
});

test("rankModelsInTier: cost-ascending — flash/value before the pro pair before minimax", () => {
  const cheapTier: RosterModel[] = [
    { id: "deepseek-v4-flash", costPerMTok: 0.42 },
    { id: "mimo-v2.5", costPerMTok: 0.42 },
    { id: "mimo-v2.5-pro", costPerMTok: 1.305 },
    { id: "deepseek-v4-pro", costPerMTok: 1.305 },
    { id: "minimax-m3", costPerMTok: 1.5 }
  ];
  // cost ASC; equal-cost ties keep roster order (no leaderboard) — exactly the user's sequence
  const order = rankModelsInTier(cheapTier, []).map((c) => c.id);
  assert.deepEqual(order, [
    "deepseek-v4-flash",
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "deepseek-v4-pro",
    "minimax-m3"
  ]);
});

test("rankModelsInTier: a cheaper low-reasoning model still goes before a pricier stronger one", () => {
  const tier: RosterModel[] = [
    { id: "pricey-strong", costPerMTok: 1.305 },
    { id: "cheap-weak", costPerMTok: 0.42 }
  ];
  const leaderboard: LuakLeaderboardEntry[] = [
    { modelId: "pricey-strong", reliability_score: 95 },
    { modelId: "cheap-weak", reliability_score: 50 }
  ];
  // cost beats quality as the PRIMARY key — cheapest-that-can-do-the-job, ladder gates correctness
  assert.deepEqual(rankModelsInTier(tier, leaderboard).map((c) => c.id), ["cheap-weak", "pricey-strong"]);
});

test("rankModelsInTier: no price signal preserves explicit roster order (operator intent honored)", () => {
  const proPair = rosterFromIds(["mimo-v2.5-pro", "deepseek-v4-pro"]);
  const order = rankModelsInTier(proPair, []).map((c) => c.id);
  assert.deepEqual(order, ["mimo-v2.5-pro", "deepseek-v4-pro"]);
});

test("consultModel resolves a frontier model", () => {
  const r = consultModel(TIER_ROSTERS);
  assert.equal(r.role, "consultant");
  assert.equal(r.tier, "frontier");
  assert.ok(["gpt-5.5", "opus-4.8"].includes(r.modelId));
});

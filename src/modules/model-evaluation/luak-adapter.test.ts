/**
 * Tests for the Luak benchmark adapter. The ranking math is pure; the fetch is exercised with
 * an injected fake so the suite never touches the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fetchLuakLeaderboard,
  matchLuakEntry,
  normalizeModelName,
  parseLeaderboardEntries,
  pickCheapestAboveThreshold,
  rankCandidates,
  scoreOfEntry,
  type FetchLike,
  type LuakAdapterConfig,
  type LuakLeaderboardEntry,
  type RosterModel,
} from "./luak-adapter.js";

const ENTRIES: LuakLeaderboardEntry[] = [
  { modelId: "deepseek-v4-pro", model: "deepseek-v4-pro", reliability_score: 0.91, average_pass_rate: 0.88 },
  { modelId: "mimo-v2.5", model: "MiMo v2.5", composite: 0.72 },
  { modelId: "some-other", model: "some-other", reliability_score: 0.5 },
];

test("normalizeModelName strips punctuation/case", () => {
  assert.equal(normalizeModelName("MiMo v2.5"), "mimov25");
  assert.equal(normalizeModelName("deepseek-v4-pro"), "deepseekv4pro");
});

test("scoreOfEntry prefers reliability > composite > pass_rate", () => {
  assert.equal(scoreOfEntry({ reliability_score: 0.9, composite: 0.1 }), 0.9);
  assert.equal(scoreOfEntry({ composite: 0.6, average_pass_rate: 0.2 }), 0.6);
  assert.equal(scoreOfEntry({ average_pass_rate: 0.3 }), 0.3);
  assert.equal(scoreOfEntry({}), undefined);
});

test("matchLuakEntry fuzzy-matches roster ids and provider model ids", () => {
  assert.equal(matchLuakEntry({ id: "mimo-v2.5" }, ENTRIES)?.modelId, "mimo-v2.5");
  assert.equal(matchLuakEntry({ id: "x", providerModelIds: ["deepseek-v4-pro"] }, ENTRIES)?.modelId, "deepseek-v4-pro");
  assert.equal(matchLuakEntry({ id: "unknown-model" }, ENTRIES), undefined);
});

test("rankCandidates sorts by score desc, unmatched last, cheaper wins ties", () => {
  const roster: RosterModel[] = [
    { id: "mimo-v2.5", costPerMTok: 0.5 },
    { id: "deepseek-v4-pro", costPerMTok: 2.0 },
    { id: "unmatched-model", costPerMTok: 0.1 },
  ];
  const ranked = rankCandidates(roster, ENTRIES);
  assert.deepEqual(ranked.map((c) => c.id), ["deepseek-v4-pro", "mimo-v2.5", "unmatched-model"]);
  assert.equal(ranked[2]?.score, undefined);
});

test("pickCheapestAboveThreshold returns the cheapest qualifying model, or undefined", () => {
  const roster: RosterModel[] = [
    { id: "deepseek-v4-pro", costPerMTok: 2.0 },
    { id: "mimo-v2.5", costPerMTok: 0.5 },
  ];
  const ranked = rankCandidates(roster, ENTRIES);
  // Both qualify at 0.5; mimo is cheaper.
  assert.equal(pickCheapestAboveThreshold(ranked, 0.5)?.id, "mimo-v2.5");
  // Only deepseek qualifies at 0.8.
  assert.equal(pickCheapestAboveThreshold(ranked, 0.8)?.id, "deepseek-v4-pro");
  // Nothing qualifies above 0.99.
  assert.equal(pickCheapestAboveThreshold(ranked, 0.99), undefined);
});

test("parseLeaderboardEntries accepts {leaderboard:[]} and bare arrays", () => {
  assert.equal(parseLeaderboardEntries({ leaderboard: ENTRIES }).length, 3);
  assert.equal(parseLeaderboardEntries(ENTRIES).length, 3);
  assert.equal(parseLeaderboardEntries({ nope: 1 }).length, 0);
  assert.equal(parseLeaderboardEntries(null).length, 0);
});

const CFG: LuakAdapterConfig = { url: "http://luak.test", path: "/api/leaderboard", token: undefined, timeoutMs: 5_000 };

test("fetchLuakLeaderboard parses a successful response", async () => {
  const ff: FetchLike = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ leaderboard: ENTRIES }) });
  const r = await fetchLuakLeaderboard(CFG, ff);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.entries.length, 3);
});

test("fetchLuakLeaderboard maps an egress denial to actionable guidance", async () => {
  const ff: FetchLike = async () => { throw new Error("egress blocked"); };
  const r = await fetchLuakLeaderboard(CFG, ff);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /IKBI_EGRESS_ALLOWLIST/);
});

test("fetchLuakLeaderboard fails cleanly on non-2xx", async () => {
  const ff: FetchLike = async () => ({ ok: false, status: 503, text: async () => "down" });
  const r = await fetchLuakLeaderboard(CFG, ff);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /503/);
});

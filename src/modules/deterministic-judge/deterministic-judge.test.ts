import assert from "node:assert/strict";
import { test } from "node:test";

import { createDeterministicJudge, defaultOverrides } from "./judge.js";
import { FAMILY_WEIGHTS, type DeterministicJudgeConfig } from "./config.js";
import type { BuildCandidate, JudgeOverride } from "./contract.js";

const CFG: DeterministicJudgeConfig = { enabled: true, maxDiffLines: 2000, maxFiles: 50 };
const newJudge = (over: Record<string, unknown> = {}) => createDeterministicJudge({ config: CFG, publish: () => {}, ...over });

/** A passing, efficient candidate — overridable per test. */
function cand(over: Partial<BuildCandidate> = {}): BuildCandidate {
  return {
    workspaceId: "ws", typecheckPass: true, testsPass: true, toolRounds: 1, maxToolRounds: 20,
    rejectedToolCalls: 0, filesWritten: 1, stopReason: "stop", ...over,
  };
}

// ── DETERMINISM (the headline) ───────────────────────────────────────────────

test("the SAME candidates always yield the SAME verdict (no randomness, no clock)", () => {
  const cands = [
    cand({ workspaceId: "ws-1", testCount: { passed: 9, total: 10 }, toolRounds: 5, diffLines: 300 }),
    cand({ workspaceId: "ws-2", testCount: { passed: 10, total: 10 }, toolRounds: 2, diffLines: 100 }),
    cand({ workspaceId: "ws-3", typecheckPass: false }),
  ];
  const a = newJudge().judge(cands);
  const b = newJudge().judge(cands);
  assert.deepEqual(a, b, "identical inputs ⇒ byte-identical JudgeResult");
});

// ── LAYER 1: overrides beat scores ───────────────────────────────────────────

test("a typecheck-failing candidate is disqualified even with otherwise PERFECT signals", () => {
  // "perfect" loser: full tests, zero rounds/diff/files, clean stop — would score 1.0.
  const loser = cand({ workspaceId: "perfect-but-broken", typecheckPass: false, testCount: { passed: 10, total: 10 }, toolRounds: 0, diffLines: 0, filesWritten: 0 });
  const winner = cand({ workspaceId: "mediocre-but-compiles", testCount: { passed: 8, total: 10 }, toolRounds: 10, diffLines: 800, filesWritten: 5 });
  const r = newJudge().judge([loser, winner]);
  assert.equal(r.winner?.workspaceId, "mediocre-but-compiles", "a hard-fail cannot be outscored");
  const v = r.ranking.find((x) => x.workspaceId === "perfect-but-broken");
  assert.equal(v?.disqualified, true);
  assert.match(v?.overrideReason ?? "", /typecheck/);
});

test("testsPass:false and rejectedToolCalls>0 each disqualify (override reasons surfaced)", () => {
  const r = newJudge().judge([
    cand({ workspaceId: "a", testsPass: false }),
    cand({ workspaceId: "b", rejectedToolCalls: 2 }),
    cand({ workspaceId: "c" }),
  ]);
  assert.equal(r.winner?.workspaceId, "c");
  assert.match(r.ranking.find((x) => x.workspaceId === "a")?.overrideReason ?? "", /tests/);
  assert.match(r.ranking.find((x) => x.workspaceId === "b")?.overrideReason ?? "", /rejected/);
});

// ── LAYER 2: weighted ranking + composite math ───────────────────────────────

test("weights sum to exactly 1.0 (Luak invariant)", () => {
  const sum = Object.values(FAMILY_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `family weights must sum to 1.0 (got ${sum})`);
});

test("a perfect candidate scores composite 1.0; the better-signal candidate wins", () => {
  const perfect = cand({ workspaceId: "perfect", testCount: { passed: 5, total: 5 }, toolRounds: 0, diffLines: 0, filesWritten: 0, stopReason: "stop" });
  const worse = cand({ workspaceId: "worse", testCount: { passed: 3, total: 5 }, toolRounds: 18, diffLines: 1500, filesWritten: 40, stopReason: "max_iterations" });
  const r = newJudge().judge([worse, perfect]);
  assert.equal(r.winner?.workspaceId, "perfect");
  assert.ok(Math.abs((r.winner?.composite ?? 0) - 1.0) < 1e-9, "all-best signals ⇒ composite 1.0");
  const worseComposite = r.ranking.find((x) => x.workspaceId === "worse")?.composite ?? 1;
  assert.ok(worseComposite < 1.0, "the worse candidate scores below the perfect one");
});

test("among survivors, more passing tests wins (all else equal)", () => {
  const r = newJudge().judge([
    cand({ workspaceId: "fewer", testCount: { passed: 7, total: 10 } }),
    cand({ workspaceId: "more", testCount: { passed: 10, total: 10 } }),
  ]);
  assert.equal(r.winner?.workspaceId, "more");
});

// ── TIE-BREAK (explicit, deterministic) ──────────────────────────────────────

test("tie-break: equal composite ⇒ fewer toolRounds wins (beats the workspaceId fallback)", () => {
  // Composites engineered EQUAL: A (toolRounds 2, diff 250) and B (toolRounds 4, diff 0)
  // both contribute 0.40 from efficiency+diff ⇒ composite 0.95 each. A has a LARGER id,
  // so an id-only tiebreak would pick B — proving toolRounds is checked first.
  const A = cand({ workspaceId: "ws-z", toolRounds: 2, diffLines: 250 });
  const B = cand({ workspaceId: "ws-a", toolRounds: 4, diffLines: 0 });
  const r = newJudge().judge([B, A]);
  assert.equal(r.winner?.workspaceId, "ws-z", "fewer toolRounds wins the tie despite the larger id");
});

test("tie-break final fallback: fully-identical candidates ⇒ lexically-smallest workspaceId wins", () => {
  const base = { typecheckPass: true, testsPass: true, toolRounds: 3, maxToolRounds: 20, rejectedToolCalls: 0, filesWritten: 2, diffLines: 100, stopReason: "stop" as const };
  const r = newJudge().judge([{ ...base, workspaceId: "ws-2" }, { ...base, workspaceId: "ws-1" }, { ...base, workspaceId: "ws-3" }]);
  assert.equal(r.winner?.workspaceId, "ws-1", "the SAME inputs always yield the SAME winner");
});

// ── NO-PASS (fail-closed) ────────────────────────────────────────────────────

test("when EVERY candidate trips an override ⇒ winner null, rejectedAll, reason", () => {
  const r = newJudge().judge([cand({ workspaceId: "a", typecheckPass: false }), cand({ workspaceId: "b", typecheckPass: false })]);
  assert.equal(r.winner, null);
  assert.equal(r.rejectedAll, true);
  assert.match(r.reason ?? "", /disqualified/);
  assert.equal(r.ranking.length, 2);
  assert.ok(r.ranking.every((x) => x.disqualified));
});

test("no candidates ⇒ fail-closed (winner null)", () => {
  const r = newJudge().judge([]);
  assert.equal(r.winner, null);
  assert.equal(r.rejectedAll, true);
});

// ── TRANSPARENCY ─────────────────────────────────────────────────────────────

test("the ranking reports EVERY candidate's outcome (survivors with scores, disqualified with reasons)", () => {
  const r = newJudge().judge([cand({ workspaceId: "win", testCount: { passed: 10, total: 10 } }), cand({ workspaceId: "dq", testsPass: false })]);
  const win = r.ranking.find((x) => x.workspaceId === "win");
  const dq = r.ranking.find((x) => x.workspaceId === "dq");
  assert.equal(win?.disqualified, false);
  assert.equal(typeof win?.composite, "number");
  assert.ok(win?.familyScores && typeof win.familyScores.tests === "number", "survivor carries per-family scores");
  assert.equal(dq?.disqualified, true);
  assert.ok(dq?.overrideReason);
});

// ── PURE / NO SIDE-EFFECT ────────────────────────────────────────────────────

test("the judge source imports NO model/provider/workspace/worker-model (pure scorer)", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = new URL(".", import.meta.url).pathname;
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const importFrom = /(?:import|export)[^;]*from\s+["']([^"']+)["']/g;
  for (const f of files) {
    const src = readFileSync(`${dir}${f}`, "utf8");
    for (const m of src.matchAll(importFrom)) {
      const spec = m[1] ?? "";
      assert.ok(!/provider|workspace|worker-model|governed-exec|gate-wall/.test(spec), `${f} must not import ${spec} (the judge is pure)`);
    }
  }
});

// ── EXTENSIBILITY (registry tables, not hardcoded ifs) ───────────────────────

test("a custom override registered via the table disqualifies as expected", () => {
  const noBigChanges: JudgeOverride = {
    id: "too-many-files",
    label: "too-many-files",
    disqualifies: (c) => c.filesWritten > 5,
    reason: (c) => `${c.filesWritten} files exceeds the cap`,
  };
  const r = newJudge({ overrides: [...defaultOverrides(), noBigChanges] }).judge([
    cand({ workspaceId: "sprawling", filesWritten: 10 }),
    cand({ workspaceId: "focused", filesWritten: 2 }),
  ]);
  assert.equal(r.winner?.workspaceId, "focused");
  assert.match(r.ranking.find((x) => x.workspaceId === "sprawling")?.overrideReason ?? "", /too-many-files/);
});

/**
 * ikbi escalation — acceptance tests (pure, in-memory).
 *
 * Covers the scorer (every signal, caps, clamp, determinism), the policy
 * (thresholds, tier transitions, the frontier approval gate, the cap), the engine
 * (evaluate / record / history / forget / handoff), and the break-glass flow
 * (fail-closed deny, approve, deny fallbacks, presentation, guard).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeScore,
  decideEscalation,
  nextTier,
  thresholdFor,
  modelFor,
  createEscalationEngine,
  buildHandoff,
  formatScoreBreakdown,
  createBreakGlass,
  presentBreakGlass,
  escalationConfig,
  DEFAULT_WEIGHTS,
  type EscalationSignals,
  type EscalationContext,
  type EscalationDecision,
  type EscalationScore,
} from "./index.js";

// ── helpers ──────────────────────────────────────────────────────────────────

/** A clean (no-pressure) signal set; override fields per test. */
function signals(over: Partial<EscalationSignals> = {}): EscalationSignals {
  return {
    schemaFailures: 0,
    retryCount: 0,
    contextPressure: 0,
    criticRejected: false,
    verificationFailed: false,
    rejectedToolCalls: 0,
    builderFailed: false,
    ...over,
  };
}

function ctx(over: Partial<EscalationContext> = {}): EscalationContext {
  return {
    taskId: "T1",
    currentTier: "worker",
    goal: "make the tests pass",
    signals: signals(),
    ...over,
  };
}

// ── SCORER ─────────────────────────────────────────────────────────────────

test("scorer — clean signals score 0", () => {
  const s = computeScore(signals(), DEFAULT_WEIGHTS);
  assert.equal(s.total, 0);
  assert.equal(s.shouldEscalate, false, "scorer never sets shouldEscalate");
  assert.equal(s.targetTier, undefined, "scorer never sets a target tier");
});

test("scorer — binary signals use their full weight", () => {
  assert.equal(computeScore(signals({ verificationFailed: true }), DEFAULT_WEIGHTS).total, 25);
  assert.equal(computeScore(signals({ criticRejected: true }), DEFAULT_WEIGHTS).total, 20);
  assert.equal(computeScore(signals({ criticRejected: true, verificationFailed: true }), DEFAULT_WEIGHTS).total, 45);
});

test("scorer — schemaFailures is capped at 30", () => {
  assert.equal(computeScore(signals({ schemaFailures: 1 }), DEFAULT_WEIGHTS).total, 15);
  assert.equal(computeScore(signals({ schemaFailures: 2 }), DEFAULT_WEIGHTS).total, 30);
  assert.equal(computeScore(signals({ schemaFailures: 99 }), DEFAULT_WEIGHTS).total, 30, "cap holds");
});

test("scorer — retryCount is capped at 20", () => {
  assert.equal(computeScore(signals({ retryCount: 1 }), DEFAULT_WEIGHTS).total, 10);
  assert.equal(computeScore(signals({ retryCount: 99 }), DEFAULT_WEIGHTS).total, 20, "cap holds");
});

test("scorer — rejectedToolCalls is normalized (w/3) and capped at 15", () => {
  assert.equal(computeScore(signals({ rejectedToolCalls: 3 }), DEFAULT_WEIGHTS).total, 10, "3 * (10/3) = 10");
  assert.equal(computeScore(signals({ rejectedToolCalls: 99 }), DEFAULT_WEIGHTS).total, 15, "cap holds");
});

test("scorer — scoutScore is INVERTED (low score ⇒ high pressure); absent ⇒ no signal", () => {
  assert.equal(computeScore(signals({ scoutScore: 1 }), DEFAULT_WEIGHTS).total, 0, "perfect scout ⇒ 0");
  assert.equal(computeScore(signals({ scoutScore: 0 }), DEFAULT_WEIGHTS).total, 10, "zero scout ⇒ full weight");
  assert.equal(computeScore(signals({ scoutScore: 0.5 }), DEFAULT_WEIGHTS).total, 5);
  assert.equal(computeScore(signals(), DEFAULT_WEIGHTS).breakdown.scoutScore, 0, "absent ⇒ 0 contribution");
});

test("scorer — benchmarkPassRate is INVERTED; absent ⇒ no signal", () => {
  assert.equal(computeScore(signals({ benchmarkPassRate: 1 }), DEFAULT_WEIGHTS).total, 0);
  assert.equal(computeScore(signals({ benchmarkPassRate: 0 }), DEFAULT_WEIGHTS).total, 5);
  assert.equal(computeScore(signals(), DEFAULT_WEIGHTS).breakdown.benchmarkPassRate, 0);
});

test("scorer — contextPressure scales the fraction by its weight", () => {
  assert.equal(computeScore(signals({ contextPressure: 1 }), DEFAULT_WEIGHTS).total, 5);
  assert.equal(computeScore(signals({ contextPressure: 0.5 }), DEFAULT_WEIGHTS).total, 2.5);
});

test("scorer — total is clamped to 100", () => {
  const maxed = computeScore(
    signals({ schemaFailures: 10, retryCount: 10, criticRejected: true, verificationFailed: true, rejectedToolCalls: 10, builderFailed: true }),
    DEFAULT_WEIGHTS,
  );
  assert.equal(maxed.total, 100, "30+20+20+25+15+40 = 150 clamps to 100");
});

test("scorer — negative / non-finite signals never lower the score", () => {
  const s = computeScore(signals({ schemaFailures: -5, contextPressure: -1, scoutScore: 2 }), DEFAULT_WEIGHTS);
  assert.equal(s.total, 0, "floored at 0 per contribution");
});

test("scorer — builderFailed uses its full weight (binary signal)", () => {
  assert.equal(computeScore(signals({ builderFailed: true }), DEFAULT_WEIGHTS).total, 40);
  assert.equal(computeScore(signals({ builderFailed: false }), DEFAULT_WEIGHTS).total, 0);
});

test("scorer — builderFailed + rejectedToolCalls crosses threshold", () => {
  // builderFailed(40) + rejectedToolCalls(3 * 10/3 = 10) = 50 ≥ threshold
  const s = computeScore(signals({ builderFailed: true, rejectedToolCalls: 3 }), DEFAULT_WEIGHTS);
  assert.equal(s.total, 50);
  assert.equal(s.breakdown.builderFailed, 40);
  assert.equal(s.breakdown.rejectedToolCalls, 10);
});

test("scorer — builderFailed + verificationFailed crosses threshold", () => {
  // builderFailed(40) + verificationFailed(25) = 65 ≥ 50
  const s = computeScore(signals({ builderFailed: true, verificationFailed: true }), DEFAULT_WEIGHTS);
  assert.equal(s.total, 65);
});

test("scorer — 100% deterministic: identical input ⇒ identical output", () => {
  const input = signals({ schemaFailures: 1, retryCount: 2, criticRejected: true, contextPressure: 0.3 });
  assert.deepEqual(computeScore(input, DEFAULT_WEIGHTS), computeScore(input, DEFAULT_WEIGHTS));
});

// ── POLICY ─────────────────────────────────────────────────────────────────

test("policy — tier ladder + thresholds", () => {
  assert.equal(nextTier("worker"), "mid");
  assert.equal(nextTier("mid"), "frontier");
  assert.equal(nextTier("frontier"), undefined);
  assert.equal(thresholdFor("worker", escalationConfig), 50);
  assert.equal(thresholdFor("mid", escalationConfig), 70);
  assert.equal(thresholdFor("frontier", escalationConfig), undefined);
  assert.equal(modelFor("mid", escalationConfig), "deepseek-v4-pro");
  assert.equal(modelFor("frontier", escalationConfig), "gpt-5.5");
});

function score(total: number): EscalationScore {
  return { total, breakdown: { synthetic: total }, shouldEscalate: false };
}

test("policy — worker→mid is automatic at/above threshold (no approval)", () => {
  const at = decideEscalation(score(50), "worker", escalationConfig, 0);
  assert.equal(at.escalate, true);
  assert.equal(at.targetTier, "mid");
  assert.equal(at.requiresApproval, false, "worker→mid never needs a human");
  assert.equal(at.targetModel, "deepseek-v4-pro");
  assert.equal(at.score.shouldEscalate, true);
});

test("policy — below threshold does not escalate", () => {
  const below = decideEscalation(score(49.9), "worker", escalationConfig, 0);
  assert.equal(below.escalate, false);
  assert.equal(below.targetTier, undefined);
  assert.equal(below.score.shouldEscalate, false);
});

test("policy — mid→frontier ALWAYS requires approval", () => {
  const d = decideEscalation(score(70), "mid", escalationConfig, 0);
  assert.equal(d.escalate, true);
  assert.equal(d.targetTier, "frontier");
  assert.equal(d.requiresApproval, true, "INVARIANT: frontier transitions are gated");
  assert.equal(d.targetModel, "gpt-5.5");
});

test("policy — frontier is the top tier (cannot escalate)", () => {
  const d = decideEscalation(score(100), "frontier", escalationConfig, 0);
  assert.equal(d.escalate, false);
  assert.ok(d.declineReason && /frontier/.test(d.declineReason));
});

test("policy — the per-task cap blocks escalation even when the score crosses", () => {
  const d = decideEscalation(score(100), "worker", escalationConfig, escalationConfig.maxEscalations);
  assert.equal(d.escalate, false);
  assert.equal(d.score.shouldEscalate, true, "the score still crossed…");
  assert.ok(d.declineReason && /cap/.test(d.declineReason), "…but the cap declined it");
});

// ── ENGINE ─────────────────────────────────────────────────────────────────

test("engine — worker→mid auto-escalates and builds a handoff", () => {
  const engine = createEscalationEngine();
  // 15 (schema) + 20 (critic) + 25 (verify) = 60 ≥ 50
  const decision = engine.evaluate(
    ctx({
      currentTier: "worker",
      currentModel: "deepseek-v4-flash",
      signals: signals({ schemaFailures: 1, criticRejected: true, verificationFailed: true }),
      criticFeedback: "missed the edge case",
      verificationDetails: "2 tests failing",
      failureReasons: ["tests red"],
    }),
  );
  assert.equal(decision.escalate, true);
  assert.equal(decision.targetTier, "mid");
  assert.equal(decision.requiresApproval, false);
  assert.equal(decision.targetModel, "deepseek-v4-pro");
  const h = decision.handoffContext;
  if (h === undefined) throw new Error("expected a handoff");
  assert.equal(h.goal, "make the tests pass");
  assert.equal(h.criticFeedback, "missed the edge case");
  assert.equal(h.verificationDetails, "2 tests failing");
  assert.ok(/worker→mid/.test(h.escalationReason));
  const last = h.previousAttempts[h.previousAttempts.length - 1];
  if (last === undefined) throw new Error("expected an attempt summary");
  assert.equal(last.model, "deepseek-v4-flash");
  assert.deepEqual([...last.failureReasons], ["tests red"]);
});

test("engine — mid→frontier escalates but flags approval", () => {
  const engine = createEscalationEngine();
  // 15 + 10 + 20 + 25 = 70 ≥ 70
  const decision = engine.evaluate(
    ctx({
      currentTier: "mid",
      signals: signals({ schemaFailures: 1, retryCount: 1, criticRejected: true, verificationFailed: true }),
    }),
  );
  assert.equal(decision.escalate, true);
  assert.equal(decision.targetTier, "frontier");
  assert.equal(decision.requiresApproval, true);
  assert.equal(decision.targetModel, "gpt-5.5");
});

test("engine — a clean attempt does not escalate", () => {
  const engine = createEscalationEngine();
  const decision = engine.evaluate(ctx({ signals: signals({ contextPressure: 0.2 }) }));
  assert.equal(decision.escalate, false);
  assert.equal(decision.handoffContext, undefined, "no handoff when not escalating");
  assert.equal(decision.requiresApproval, false);
});

test("engine — recordEscalation feeds the cap; evaluate stays pure until recorded", () => {
  const engine = createEscalationEngine();
  const hot = ctx({ signals: signals({ schemaFailures: 1, criticRejected: true, verificationFailed: true }) });

  // evaluate is idempotent — calling it twice does NOT consume the cap
  assert.equal(engine.evaluate(hot).escalate, true);
  assert.equal(engine.evaluate(hot).escalate, true);
  assert.equal(engine.getHistory("T1").length, 0, "evaluate never records");

  engine.recordEscalation("T1", "worker", "mid");
  engine.recordEscalation("T1", "mid", "frontier");
  assert.equal(engine.getHistory("T1").length, 2);

  // cap (default 2) now reached → no further escalation
  assert.equal(engine.evaluate(hot).escalate, false);
});

test("engine — history records the approval flag and forget() clears it", () => {
  const engine = createEscalationEngine();
  engine.recordEscalation("T9", "worker", "mid");
  engine.recordEscalation("T9", "mid", "frontier");
  const hist = engine.getHistory("T9");
  assert.equal(hist[0]?.requiresApproval, false, "worker→mid: no approval");
  assert.equal(hist[1]?.requiresApproval, true, "mid→frontier: approval");
  engine.forget("T9");
  assert.equal(engine.getHistory("T9").length, 0);
});

// ── HANDOFF ──────────────────────────────────────────────────────────────────

test("handoff — formatScoreBreakdown lists only non-zero contributions, sorted", () => {
  const s = computeScore(signals({ criticRejected: true, verificationFailed: true }), DEFAULT_WEIGHTS);
  const text = formatScoreBreakdown(s);
  assert.ok(/score 45\/100/.test(text));
  assert.ok(/criticRejected=20/.test(text) && /verificationFailed=25/.test(text));
  assert.ok(!/schemaFailures/.test(text), "zero contributions are omitted");
  assert.ok(text.indexOf("criticRejected") < text.indexOf("verificationFailed"), "sorted");
});

test("handoff — preserves prior tier transitions as previous attempts", () => {
  const s = computeScore(signals({ verificationFailed: true }), DEFAULT_WEIGHTS);
  const handoff = buildHandoff(ctx({ currentTier: "mid", currentModel: "deepseek-v4-pro" }), s, "frontier", [
    { taskId: "T1", from: "worker", to: "mid", requiresApproval: false },
  ]);
  assert.equal(handoff.previousAttempts.length, 2, "prior worker attempt + current mid attempt");
  assert.equal(handoff.previousAttempts[0]?.tier, "worker");
  assert.equal(handoff.previousAttempts[1]?.tier, "mid");
});

// ── BREAK-GLASS ──────────────────────────────────────────────────────────────

/** A real frontier decision straight from the engine (requiresApproval === true). */
function frontierDecision(): EscalationDecision {
  const engine = createEscalationEngine();
  return engine.evaluate(
    ctx({
      currentTier: "mid",
      currentModel: "deepseek-v4-pro",
      signals: signals({ schemaFailures: 1, retryCount: 1, criticRejected: true, verificationFailed: true }),
    }),
  );
}

test("break-glass — DEFAULT approver DENIES (fail-closed, zero silent escalation)", async () => {
  const bg = createBreakGlass();
  const res = await bg.request({ taskId: "T1", decision: frontierDecision() });
  assert.equal(res.approved, false);
  assert.equal(res.fallback, "retry-current");
});

test("break-glass — an approving gate proceeds", async () => {
  const bg = createBreakGlass({ approve: async () => true });
  const res = await bg.request({ taskId: "T1", decision: frontierDecision() });
  assert.equal(res.approved, true);
  assert.equal(res.fallback, "escalate");
});

test("break-glass — onDeny can abort the run instead of retrying", async () => {
  const bg = createBreakGlass({ approve: async () => false, onDeny: "abort" });
  const res = await bg.request({ taskId: "T1", decision: frontierDecision() });
  assert.equal(res.approved, false);
  assert.equal(res.fallback, "abort");
});

test("break-glass — the briefing surfaces tier, model, score, and cost", () => {
  const text = presentBreakGlass({ taskId: "T1", decision: frontierDecision(), estimatedCostUsd: 1.25 });
  assert.ok(/BREAK-GLASS/.test(text));
  assert.ok(/FRONTIER/.test(text));
  assert.ok(/gpt-5\.5/.test(text), "target model shown");
  assert.ok(/\$1\.25/.test(text), "estimated cost shown");
  assert.ok(/score 70\/100/.test(text), "score breakdown shown");
});

test("break-glass — refuses a decision that does not require approval", async () => {
  const bg = createBreakGlass({ approve: async () => true });
  const engine = createEscalationEngine();
  const workerToMid = engine.evaluate(
    ctx({ signals: signals({ schemaFailures: 1, criticRejected: true, verificationFailed: true }) }),
  );
  assert.equal(workerToMid.requiresApproval, false);
  await assert.rejects(() => bg.request({ taskId: "T1", decision: workerToMid }), /does not require approval/);
});

// ── CONFIG ───────────────────────────────────────────────────────────────────

test("config — defaults match the three-tier spec", () => {
  assert.equal(escalationConfig.workerToMidThreshold, 50);
  assert.equal(escalationConfig.midToFrontierThreshold, 70);
  assert.equal(escalationConfig.maxEscalations, 2);
  assert.deepEqual([...escalationConfig.tierModels.worker], ["deepseek-v4-flash", "mimo-v2.5", "minimax-m3"]);
  assert.deepEqual([...escalationConfig.tierModels.mid], ["deepseek-v4-pro", "mimo-v2.5-pro"]);
  assert.deepEqual([...escalationConfig.tierModels.frontier], ["gpt-5.5", "opus-4.8"]);
});

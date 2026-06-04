import assert from "node:assert/strict";
import { test } from "node:test";

import type { OutcomeStatus, TrustState } from "./contract.js";
import { applyOutcome, clearInjectionFlag, freshState, type RuleOptions } from "./rules.js";

const OPTS: RuleOptions = { promoteStreak: 3, demoteStreak: 2, minDistinctOps: 1, now: 1 };

interface Step {
  status: OutcomeStatus;
  op?: string;
  injection?: boolean;
}

function step(s: Step, prev: TrustState | undefined, opts: RuleOptions = OPTS) {
  return applyOutcome(
    prev,
    {
      agentId: "a",
      kind: "agent",
      defaultTrustTier: "probation",
      operation: s.op ?? "op",
      status: s.status,
      ...(s.injection ? { signals: { injection: true } } : {}),
    },
    opts,
  );
}

function run(steps: Step[], opts: RuleOptions = OPTS, start?: TrustState): TrustState {
  let s = start;
  for (const st of steps) s = step(st, s, opts).state;
  return s as TrustState;
}

const succ = (op?: string): Step => ({ status: "success", ...(op ? { op } : {}) });

test("freshState starts at the clamped registry default", () => {
  const s = freshState({ agentId: "a", kind: "agent", defaultTrustTier: "probation" }, 0);
  assert.equal(s.tier, "probation");
  assert.equal(s.injectionFlagged, false);
  assert.deepEqual(s.streakOperations, []);
});

test("promotion on a sustained substantive success streak", () => {
  const r2 = step(succ(), step(succ(), undefined).state);
  assert.equal(r2.transition, undefined);
  const r3 = step(succ(), r2.state);
  assert.equal(r3.transition?.direction, "promote");
  assert.equal(r3.state.tier, "verified");
  assert.equal(r3.state.lastTransition?.direction, "promote");
});

test("promotion is capped at the agent ceiling (trusted); never operator", () => {
  const trusted = run(Array.from({ length: 30 }, () => succ()));
  assert.equal(trusted.tier, "trusted");
});

test("demotion on a failure streak (recoverable quality failure)", () => {
  const verified = run([succ(), succ(), succ()]);
  const r1 = step({ status: "failure" }, verified);
  assert.equal(r1.transition, undefined);
  const r2 = step({ status: "failure" }, r1.state);
  assert.equal(r2.transition?.direction, "demote");
  assert.equal(r2.state.tier, "probation");
  assert.equal(r2.state.injectionFlagged, false, "quality failure does not set the injection flag");
});

test("a single rejected outcome demotes immediately", () => {
  const verified = run([succ(), succ(), succ()]);
  const r = step({ status: "rejected" }, verified);
  assert.equal(r.transition?.reason, "rejected_work");
});

test("ANTI-FARMING: read-only / no-op successes earn NO promotion credit", () => {
  const s = run([succ("file.read"), succ("status"), succ("get"), succ("health"), succ("list")]);
  assert.equal(s.tier, "probation", "trivial read-only successes never promote");
  assert.equal(s.promotableStreak, 0);
});

test("ANTI-FARMING: a promotion streak must span >= minDistinctOps distinct substantive ops", () => {
  const opts: RuleOptions = { ...OPTS, minDistinctOps: 2 };
  // Same substantive op repeated — 1 distinct op — does NOT promote.
  const same = run([succ("build.run"), succ("build.run"), succ("build.run"), succ("build.run")], opts);
  assert.equal(same.tier, "probation", "single-op farming is blocked by the diversity requirement");
  // Three successes across distinct substantive ops DO promote.
  const diverse = run([succ("build.run"), succ("test.run"), succ("edit.write")], opts);
  assert.equal(diverse.tier, "verified");
});

test("ANTI-GAMING: any failure/partial resets the promotion streak", () => {
  assert.equal(run([succ(), succ(), { status: "failure" }, succ(), succ()]).tier, "probation");
  assert.equal(run([succ(), succ(), { status: "partial" }, succ()]).tier, "probation");
  assert.equal(run([succ(), succ(), succ()]).tier, "verified");
});

test("INJECTION is non-recoverable: demotes + flags, and blocks auto-promotion until operator reset", () => {
  const verified = run([succ(), succ(), succ()]);
  const flagged = step({ status: "success", injection: true }, verified).state;
  assert.equal(flagged.injectionFlagged, true);
  assert.equal(flagged.flagReason, "injection_attempt");
  assert.equal(flagged.tier, "probation", "injection demotes");

  // A clean success streak does NOT auto-recover while flagged.
  const stillFlagged = run([succ(), succ(), succ(), succ(), succ()], OPTS, flagged);
  assert.equal(stillFlagged.injectionFlagged, true);
  assert.equal(stillFlagged.tier, "probation", "no auto-promotion while injection-flagged");

  // Operator reset clears the flag; then promotion works again.
  const reset = clearInjectionFlag(stillFlagged, 5);
  assert.equal(reset.injectionFlagged, false);
  const recovered = run([succ(), succ(), succ()], OPTS, reset);
  assert.equal(recovered.tier, "verified", "promotion resumes after operator reset");
});

test("demotion floor is 'untrusted'; quality-failure recovery is possible", () => {
  const down = run([{ status: "failure" }, { status: "failure" }, { status: "failure" }, { status: "failure" }]);
  assert.equal(down.tier, "untrusted");
  assert.equal(down.injectionFlagged, false);
  const up = run([succ(), succ(), succ()], OPTS, down);
  assert.equal(up.tier, "probation", "recovers from the floor via good behavior");
});

test("transitions are DETERMINISTIC and RECORDED", () => {
  const seq: Step[] = [succ(), succ(), succ(), { status: "failure" }, { status: "failure" }];
  assert.deepEqual(run(seq), run(seq));
  const s = run(seq);
  assert.equal(s.transitions.length, 2);
  assert.equal(s.transitions[0]?.direction, "promote");
  assert.equal(s.transitions[1]?.direction, "demote");
});

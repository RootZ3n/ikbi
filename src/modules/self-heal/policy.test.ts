/**
 * decideDisposition — the pure self-heal authority/correctness policy. These pin the fail-closed
 * matrix: the ONLY path to "applied" is harness-suspect + candidate + suite-green + judge-pass + LOW
 * blast-radius; every other combination routes to a human or a diagnosis, never to main.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { assessBlastRadius } from "../self-monitor/blast-radius.js";
import { decideDisposition } from "./policy.js";
import type { SelfHealGateInput } from "./contract.js";

/** A LOW-severity blast-radius (one ordinary-module file, small diff). */
const lowBlast = assessBlastRadius({ changedFiles: ["src/modules/chat/session.ts"], linesChanged: 10 });
/** A MAX-severity blast-radius via the meta-rule (touches a guard path). */
const maxBlast = assessBlastRadius({ changedFiles: ["src/modules/gate-wall/index.ts"] });
/** A HIGH-severity blast-radius (build orchestration, not a guard). */
const highBlast = assessBlastRadius({ changedFiles: ["src/modules/worker-model/orchestrator.ts"] });

const base: SelfHealGateInput = {
  harnessSuspect: true,
  candidateProduced: true,
  suiteGreen: true,
  judgePass: true,
  blastRadius: lowBlast,
};

test("sanity: the blast-radius fixtures are the severities the matrix assumes", () => {
  assert.equal(lowBlast.severity, "low");
  assert.equal(lowBlast.autoApplyEligible, true);
  assert.equal(maxBlast.severity, "max");
  assert.equal(highBlast.severity, "high");
});

test("APPLIED: harness-suspect + candidate + suite + judge + LOW → auto-applied to a branch", () => {
  const v = decideDisposition(base);
  assert.equal(v.disposition, "applied");
  assert.equal(v.verified, true);
  assert.equal(v.requiresHuman, false);
  assert.equal(v.requiresOpusReview, false);
});

test("AWAITING-AUTHORIZATION: verified but MAX blast-radius (meta-rule) → human decides, Opus advises", () => {
  const v = decideDisposition({ ...base, blastRadius: maxBlast });
  assert.equal(v.disposition, "awaiting-authorization");
  assert.equal(v.verified, true);
  assert.equal(v.requiresHuman, true);
  assert.equal(v.requiresOpusReview, true);
});

test("AWAITING-AUTHORIZATION: verified but HIGH blast-radius → human decides, Opus advises", () => {
  const v = decideDisposition({ ...base, blastRadius: highBlast });
  assert.equal(v.disposition, "awaiting-authorization");
  assert.equal(v.requiresHuman, true);
  assert.equal(v.requiresOpusReview, true);
});

test("DIAGNOSED-PROPOSAL: suite fails → never applied, surfaced for a human (even at LOW blast-radius)", () => {
  const v = decideDisposition({ ...base, suiteGreen: false });
  assert.equal(v.disposition, "diagnosed-proposal");
  assert.equal(v.verified, false);
  assert.equal(v.requiresHuman, true);
  assert.equal(v.requiresOpusReview, false, "there is no verified fix to advise merging");
  assert.ok(v.reasons.some((r) => /suite/.test(r)));
});

test("DIAGNOSED-PROPOSAL: judge rejects → never applied, surfaced for a human", () => {
  const v = decideDisposition({ ...base, judgePass: false });
  assert.equal(v.disposition, "diagnosed-proposal");
  assert.equal(v.verified, false);
  assert.ok(v.reasons.some((r) => /judge/.test(r)));
});

test("DIAGNOSED-PROPOSAL: a MAX-blast candidate that ALSO fails the suite is still a diagnosis, not applied", () => {
  // Correctness fails first: an unverified fix is never applied regardless of how severe it is.
  const v = decideDisposition({ ...base, suiteGreen: false, blastRadius: maxBlast });
  assert.equal(v.disposition, "diagnosed-proposal");
  assert.equal(v.verified, false);
});

test("REJECTED: a non-harness-suspect failure is declined without any gate", () => {
  const v = decideDisposition({ ...base, harnessSuspect: false });
  assert.equal(v.disposition, "rejected");
  assert.equal(v.requiresHuman, false);
  assert.ok(v.reasons.some((r) => /harness/.test(r)));
});

test("REJECTED: harness-suspect but no candidate produced → nothing to act on", () => {
  const v = decideDisposition({ ...base, candidateProduced: false });
  assert.equal(v.disposition, "rejected");
  assert.ok(v.reasons.some((r) => /no candidate/.test(r)));
});

test("FAIL-CLOSED invariant: 'applied' requires ALL of harness+candidate+suite+judge+low", () => {
  // Flip each required axis off; none of them may still yield "applied".
  const flips: Partial<SelfHealGateInput>[] = [
    { harnessSuspect: false },
    { candidateProduced: false },
    { suiteGreen: false },
    { judgePass: false },
    { blastRadius: maxBlast },
    { blastRadius: highBlast },
  ];
  for (const f of flips) {
    assert.notEqual(decideDisposition({ ...base, ...f }).disposition, "applied", `flip ${JSON.stringify(Object.keys(f))} must not apply`);
  }
  // And the all-green low case is the one that DOES apply — proving the test isn't vacuous.
  assert.equal(decideDisposition(base).disposition, "applied");
});

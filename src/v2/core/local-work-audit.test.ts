/**
 * HOSTILE AUDIT of the local-work authority.
 *
 * The obligations here are the ones an auditor presses on rather than the ones the feature
 * advertises: that a mode nobody recognises refuses instead of proceeding, that eligibility is a
 * property of the TASK and cannot be bought with a model name, and that the decision is a pure
 * function of its inputs and nothing else.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ELIGIBLE_TASK_CLASSES,
  INELIGIBLE_TASK_CLASSES,
  LOCAL_MODES,
  decideLocalOffload,
  isLocalMode,
  type LocalOffloadInput,
} from "./local-work.js";

const ok = (over: Partial<LocalOffloadInput> = {}): LocalOffloadInput => ({
  mode: "auto", taskClass: "test_log_triage", hasValidator: true, packetBounded: true,
  requireQualified: false, state: { configured: true, reachable: true, consecutiveFailures: 0 }, ...over,
});

// ── modes are a CLOSED set, and unknown fails CLOSED ─────────────────────────

test("audit: an UNRECOGNISED mode refuses — it never falls through to eligible", () => {
  // The regression this pins was live: `--mode OFF` produced an OFFLOAD, because the uppercase
  // value matched neither "off" nor "auto" and fell past every branch to the eligible path. The
  // string that most plainly means DO NOT CALL BOKAHLI was causing a Bokahli call.
  for (const mode of ["OFF", "Off", "OFF ", " off", "assist ", "ASSIST", "AUTO", "Auto", "yolo", "", "off\n", "auto\t"]) {
    const d = decideLocalOffload(ok({ mode }));
    assert.equal(d.offload, false, `mode ${JSON.stringify(mode)} must not offload`);
    assert.equal(d.reason, "mode_unrecognized");
    assert.equal(d.fallbackPermitted, false);
  }
});

test("audit: non-string modes refuse rather than coerce", () => {
  for (const mode of [undefined, null, 0, 1, true, {}, [], ["auto"]] as unknown[]) {
    const d = decideLocalOffload(ok({ mode: mode as string }));
    assert.equal(d.offload, false, `mode ${JSON.stringify(mode)} must not offload`);
    assert.equal(d.reason, "mode_unrecognized");
  }
});

test("audit: the mode is checked BEFORE eligibility, so a bad mode is never blamed on the task", () => {
  // Reporting "task_class_ineligible" for what is really a typo would send the operator to fix
  // the wrong thing.
  const d = decideLocalOffload(ok({ mode: "OFF", taskClass: "credential_handling" }));
  assert.equal(d.reason, "mode_unrecognized");
});

test("audit: an unrecognised mode is ECHOED verbatim, so the record shows what was typed", () => {
  assert.equal(decideLocalOffload(ok({ mode: "OFF" })).mode, "OFF");
});

test("audit: exactly four modes are recognised, and each behaves distinctly", () => {
  assert.deepEqual([...LOCAL_MODES], ["off", "assist", "auto", "exact"]);
  for (const m of LOCAL_MODES) assert.equal(isLocalMode(m), true);
  for (const m of ["OFF", "", "local", "on"]) assert.equal(isLocalMode(m), false);
  assert.equal(decideLocalOffload(ok({ mode: "off" })).offload, false);
  assert.equal(decideLocalOffload(ok({ mode: "assist" })).fallbackPermitted, false);
  assert.equal(decideLocalOffload(ok({ mode: "auto" })).fallbackPermitted, true);
  assert.equal(decideLocalOffload(ok({ mode: "exact" })).reason, "operator_selected");
});

// ── eligibility is a property of the TASK ───────────────────────────────────

test("audit: eligibility is INDEPENDENT of Bokahli availability", () => {
  // Same task, four different deployment states. The structural verdict must not move.
  const states = [
    { configured: true, reachable: true },
    { configured: true, reachable: false },
    { configured: false },
    { configured: true, consecutiveFailures: 99 },
  ];
  for (const taskClass of Object.keys(INELIGIBLE_TASK_CLASSES)) {
    for (const state of states) {
      assert.equal(decideLocalOffload(ok({ taskClass, state })).reason, "task_class_ineligible",
        `${taskClass} must be ineligible regardless of deployment state`);
    }
  }
});

test("audit: a healthy deployment cannot make an unvalidatable task eligible", () => {
  assert.equal(decideLocalOffload(ok({ hasValidator: false })).reason, "no_deterministic_validator");
  assert.equal(decideLocalOffload(ok({ packetBounded: false })).reason, "packet_unbounded");
});

test("audit: a CATALOG or MODEL NAME cannot grant eligibility — there is nowhere to put one", () => {
  // Structural: the decision input has no model, artifact, catalog or provider field. Eligibility
  // is decided from the task alone, so "but this model is really good at it" is unrepresentable.
  const keys = Object.keys(ok()).sort();
  assert.deepEqual(keys, ["hasValidator", "mode", "packetBounded", "requireQualified", "state", "taskClass"]);
  const stateKeys = Object.keys(ok().state).sort();
  assert.deepEqual(stateKeys, ["configured", "consecutiveFailures", "reachable"]);
  for (const k of [...keys, ...stateKeys]) {
    assert.ok(!/model|artifact|catalog|provider|quant|digest/i.test(k), `${k} would let a NAME argue for eligibility`);
  }
});

test("audit: an eligible-sounding NAME does not make an unknown class eligible", () => {
  for (const taskClass of ["test_log_triage_v2", "TEST_LOG_TRIAGE", "test-log-triage", "cited_extraction "]) {
    assert.equal(decideLocalOffload(ok({ taskClass })).reason, "task_class_unknown");
  }
});

test("audit: the eligible and ineligible sets are DISJOINT", () => {
  for (const c of ELIGIBLE_TASK_CLASSES) {
    assert.ok(!Object.prototype.hasOwnProperty.call(INELIGIBLE_TASK_CLASSES, c), `${c} is in both sets`);
  }
});

// ── determinism ─────────────────────────────────────────────────────────────

test("audit: the decision is a PURE function — same facts, same decision, no hidden state", () => {
  const inputs = [ok(), ok({ mode: "off" }), ok({ mode: "BAD" }), ok({ taskClass: "credential_handling" }), ok({ hasValidator: false })];
  const first = inputs.map(decideLocalOffload);
  for (let round = 0; round < 25; round += 1) {
    inputs.forEach((i, n) => assert.deepEqual(decideLocalOffload(i), first[n], "decision drifted between rounds"));
  }
});

test("audit: decision order does not affect any decision", () => {
  // A shared counter, cache or failure memo would show up here.
  const a = decideLocalOffload(ok());
  decideLocalOffload(ok({ mode: "off" }));
  decideLocalOffload(ok({ taskClass: "broad_refactor" }));
  assert.deepEqual(decideLocalOffload(ok()), a);
});

test("audit: the returned decision is FROZEN — a caller cannot edit its own authorization", () => {
  const d = decideLocalOffload(ok({ mode: "assist" }));
  assert.throws(() => { (d as unknown as { offload: boolean }).offload = true; });
  assert.throws(() => { (d as unknown as { fallbackPermitted: boolean }).fallbackPermitted = true; });
});

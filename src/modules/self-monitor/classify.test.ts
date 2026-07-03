/**
 * classifyBuildFailure — uses the REAL failure reasons this project hit while piloting on cheap
 * models, so the classifier stays anchored to observed harness signatures, not invented ones.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyBuildFailure } from "./classify.js";

test("a promoted build is not a failure", () => {
  const c = classifyBuildFailure({ outcome: "success", promoted: true });
  assert.equal(c.category, "none");
  assert.equal(c.harnessSuspect, false);
  assert.equal(c.selfHealable, false);
});

test("checks_unresolvable (empty/greenfield repo) → harness-suspect but operator-action only", () => {
  const c = classifyBuildFailure({ outcome: "rejected", verificationKind: "checks_unresolvable", reason: "No project manifest or verifier detected." });
  assert.equal(c.category, "harness");
  assert.ok(c.harnessSuspect);
  assert.equal(c.selfHealable, false);
  assert.equal(c.signal, "checks_unresolvable");
  assert.match(c.suggestedAction ?? "", /--check|manifest/);
});

test("anti-cheat blocked a verification-command change → harness-suspect (operator fix)", () => {
  const c = classifyBuildFailure({ outcome: "failure", reason: 'verification untrusted: builder modified package.json script "test"' });
  assert.equal(c.signal, "verification_command_locked");
  assert.ok(c.harnessSuspect);
  assert.equal(c.selfHealable, false);
  assert.match(c.suggestedAction ?? "", /operator/i);
});

test("trust tier can't land the build → harness-suspect (grant trust)", () => {
  const c = classifyBuildFailure({ outcome: "partial", reason: 'the worker tier "verified" lacks autoCommit autonomy. To land this work, run: ikbi trust grant worker trusted' });
  assert.equal(c.signal, "trust_gate");
  assert.ok(c.harnessSuspect);
  assert.equal(c.selfHealable, false);
  assert.match(c.suggestedAction ?? "", /trust grant/);
});

test("phantom / absent test evidence → harness-suspect", () => {
  const c = classifyBuildFailure({ outcome: "rejected", reason: 'single-run build has no real test evidence (test evidence "absent")' });
  assert.equal(c.signal, "test_evidence");
  assert.ok(c.harnessSuspect);
  assert.equal(c.selfHealable, true);
});

test("verifier PASSED but discarded for a blocked tool attempt → policy_taint harness-suspect", () => {
  const c = classifyBuildFailure({
    outcome: "rejected",
    reason: "discard: builder attempted 1 out-of-policy tool call(s)",
    roles: [{ role: "builder", outcome: "success" }, { role: "verifier", outcome: "success" }],
  });
  assert.equal(c.signal, "policy_taint");
  assert.ok(c.harnessSuspect);
  assert.equal(c.selfHealable, true);
});

test("a policy taint WITHOUT a passing verifier is NOT auto-flagged harness (could be real)", () => {
  const c = classifyBuildFailure({ outcome: "rejected", reason: "discard: builder attempted 1 out-of-policy tool call(s)", roles: [{ role: "builder", outcome: "failure" }] });
  assert.notEqual(c.signal, "policy_taint");
  assert.equal(c.harnessSuspect, false);
  assert.equal(c.selfHealable, false);
});

test("no_progress is a MODEL performance limit, not harness-suspect", () => {
  const c = classifyBuildFailure({ outcome: "failure", stopReason: "no_progress", reason: "builder failure (stop: no_progress)" });
  assert.equal(c.category, "model");
  assert.equal(c.harnessSuspect, false);
  assert.equal(c.selfHealable, false);
  assert.equal(c.signal, "no_progress");
});

test("a plain build failure defaults to model, not harness (no false self-blame)", () => {
  const c = classifyBuildFailure({ outcome: "failure", reason: "run ended with role outcome \"failure\"" });
  assert.equal(c.category, "model");
  assert.equal(c.harnessSuspect, false);
  assert.equal(c.selfHealable, false);
});

/**
 * HB-1 acceptance: the production orchestrator (enforceProjectRoot ON) over REAL collaborators.
 *  - a target with NO package.json ⇒ FAST-FAIL (rejected before any role), build NOT promoted.
 *  - a target WITH a valid project + a passing check ⇒ verifier GREEN, build PROMOTED.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanup, makeGitRepo, makeIdentities, makeManager, realGovernedExec, realOrchestrator, stubRoles } from "./harness.js";
import type { RoleFn, WorkerRole } from "../modules/worker-model/contract.js";

// Adjudication authority (IKBI_LEGACY_COMPLETION=off): the canonical core reads the critic's
// `detail.pass === true` as the goal-alignment signal. The shared harness stub critic reports
// `outcome:"success"` but carries no `detail.pass`, so an authoritative run would RETAIN
// (critic-fail-exhausted) even on a real-git GREEN build. These promotion-expecting acceptance
// tests therefore attach an explicit GREEN critic verdict — the same labeled fact production's
// real critic emits — WITHOUT weakening any assertion. (Tests that never reach promotion, e.g.
// the no-manifest fast-fail, do not need it.)
function withGreenCritic(roles: Partial<Record<WorkerRole, RoleFn>>): Partial<Record<WorkerRole, RoleFn>> {
  return {
    ...roles,
    critic: async () => ({ role: "critic", outcome: "success", summary: "critic", detail: { pass: true } }),
  };
}

// WORK ORDER 2 (contract change): a no-manifest target used to run the full pipeline and surface a
// verifier RED. The orchestrator now FAST-FAILS such a target BEFORE dispatching any role — no model
// calls, no workspace allocation, no risk of a bare loose-file repo hanging the loop. The guarantee
// it pins is unchanged and STRONGER (fail-closed, never promoted), just enforced earlier with an
// actionable diagnostic instead of a late verifier RED.
test("HB-1: a no-manifest target ⇒ FAST-FAIL (rejected before any role), NOT promoted", async () => {
  const repo = await makeGitRepo(); // NO package.json
  const { manager, root } = makeManager();
  try {
    const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
    const orch = realOrchestrator({
      targetRepo: repo, manager, governedExec: realGovernedExec(["node"]), resolveIdentity, roleClaim,
      roles: stubRoles({ write: { path: "feature.txt", content: "x\n" } }),
    });
    const result = await orch.run({ taskId: "t-red", targetRepo: repo, goal: "fix add" }, parentCtx);

    assert.equal(result.outcome, "rejected", "a no-manifest target is rejected fast (never a vacuous pass)");
    assert.equal(result.roles.length, 0, "no role ran — the fast-fail precedes dispatch (zero model cost)");
    assert.match(result.reason ?? "", /No project manifest or verifier detected/, "actionable diagnostic");
    assert.equal(result.promoted, false, "a no-manifest build is NOT promoted");
  } finally {
    await cleanup(repo, root);
  }
});

// LEGACY OVERRIDE (F7): the operator-configured IKBI_CHECKS resolver is the LEGACY verification
// path, now opt-in. With IKBI_VERIFY=legacy the production orchestrator runs the operator's exact
// check set (unchanged behavior); this proves the legacy override still functions end-to-end.
test("HB-1: a valid target with a passing check ⇒ verifier GREEN, PROMOTED (legacy override)", async () => {
  const repo = await makeGitRepo({ packageJson: { name: "ikbitrial-pass", version: "0.0.0", scripts: { test: "node -e \"process.exit(0)\"" } } });
  const { manager, root } = makeManager();
  const savedChecks = process.env.IKBI_CHECKS;
  const savedVerify = process.env.IKBI_VERIFY;
  const savedNoTests = process.env.IKBI_ALLOW_NO_TESTS;
  // A trivial, real, passing check (operator-configured, never model-chosen) run via real governed-exec.
  // The check is `git --version` (not a "test" check) so this build has NO executed-test evidence — under
  // the Phase 10 authority the operator must EXPLICITLY permit promoting a test-less build.
  process.env.IKBI_CHECKS = JSON.stringify([{ name: "check", command: "git", args: ["--version"] }]);
  process.env.IKBI_VERIFY = "legacy"; // explicit opt-out of the hardened ladder default → legacy resolveChecks
  process.env.IKBI_ALLOW_NO_TESTS = "true"; // explicit no-tests policy: this fixture has no test suite
  try {
    const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
    const orch = realOrchestrator({
      targetRepo: repo, manager, governedExec: realGovernedExec(["git"]), resolveIdentity, roleClaim,
      roles: withGreenCritic(stubRoles({ write: { path: "feature.txt", content: "the fix\n" } })),
    });
    const result = await orch.run({ taskId: "t-green", targetRepo: repo, goal: "add feature" }, parentCtx);

    const verifier = result.roles.find((r) => r.role === "verifier");
    assert.equal(verifier?.outcome, "success", "the verifier reports GREEN against the target's own passing check");
    assert.equal(result.promoted, true, "a GREEN, integrator-approved build IS promoted");
    assert.equal(result.outcome, "success");
    assert.equal(result.verificationMode, "legacy", "the run reports it took the legacy verification path");
  } finally {
    if (savedChecks === undefined) delete process.env.IKBI_CHECKS; else process.env.IKBI_CHECKS = savedChecks;
    if (savedVerify === undefined) delete process.env.IKBI_VERIFY; else process.env.IKBI_VERIFY = savedVerify;
    if (savedNoTests === undefined) delete process.env.IKBI_ALLOW_NO_TESTS; else process.env.IKBI_ALLOW_NO_TESTS = savedNoTests;
    await cleanup(repo, root);
  }
});

// HARDENED DEFAULT (A): with NO env vars, the production orchestrator runs LADDER verification —
// it plans from the project-index, runs the package's REAL `test` script (a non-stub command) over
// an impactful code change, and reports a scope-stamped GREEN. This is the fresh-operator default.
test("HB-1: ladder is the production default ⇒ real test script runs, scope-stamped GREEN, PROMOTED", async () => {
  // A REAL passing test script that emits a parsed count → the verifier classifies EXECUTED evidence,
  // which the Phase 10 promotion authority requires for autonomous promotion.
  const repo = await makeGitRepo({ packageJson: { name: "ikbitrial-ladder", version: "0.0.0", scripts: { test: "node -e \"console.log('# tests 1'); console.log('# pass 1')\"" } } });
  const { manager, root } = makeManager();
  // Belt-and-suspenders: ensure no inherited env forces a path — the DEFAULT must be ladder.
  const savedChecks = process.env.IKBI_CHECKS;
  const savedVerify = process.env.IKBI_VERIFY;
  delete process.env.IKBI_CHECKS;
  delete process.env.IKBI_VERIFY;
  try {
    const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
    const orch = realOrchestrator({
      targetRepo: repo, manager, governedExec: realGovernedExec(["node", "git", "npm", "pnpm"]), resolveIdentity, roleClaim,
      // Write a CODE file so the ladder's impact planning sees a relevant change to scope to.
      roles: withGreenCritic(stubRoles({ write: { path: "feature.ts", content: "export const fix = 1;\n" } })),
    });
    const result = await orch.run({ taskId: "t-ladder", targetRepo: repo, goal: "add feature" }, parentCtx);

    const verifier = result.roles.find((r) => r.role === "verifier");
    assert.equal(verifier?.outcome, "success", "ladder runs the package's real test script and reports GREEN");
    assert.match(verifier?.summary ?? "", /scope/i, "the ladder green is scope-stamped (impact|full), not a plain pass");
    assert.equal((verifier?.detail as { verificationMode?: string })?.verificationMode, "ladder", "the verifier ran the ladder path");
    assert.equal(result.verificationMode, "ladder", "the run reports the hardened ladder path as default");
    assert.equal(result.promoted, true, "the hardened-verified build IS promoted");
    assert.equal(result.outcome, "success");
  } finally {
    if (savedChecks === undefined) delete process.env.IKBI_CHECKS; else process.env.IKBI_CHECKS = savedChecks;
    if (savedVerify === undefined) delete process.env.IKBI_VERIFY; else process.env.IKBI_VERIFY = savedVerify;
    await cleanup(repo, root);
  }
});

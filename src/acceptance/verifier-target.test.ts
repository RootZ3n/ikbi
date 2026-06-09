/**
 * HB-1 acceptance: the production orchestrator (enforceProjectRoot ON) over REAL collaborators.
 *  - a target with NO package.json ⇒ verifier RED, build NOT promoted.
 *  - a target WITH a valid project + a passing check ⇒ verifier GREEN, build PROMOTED.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanup, makeGitRepo, makeIdentities, makeManager, realGovernedExec, realOrchestrator, stubRoles } from "./harness.js";

test("HB-1: a no-manifest target ⇒ verifier RED, NOT promoted", async () => {
  const repo = await makeGitRepo(); // NO package.json
  const { manager, root } = makeManager();
  try {
    const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
    const orch = realOrchestrator({
      targetRepo: repo, manager, governedExec: realGovernedExec(["node"]), resolveIdentity, roleClaim,
      roles: stubRoles({ write: { path: "feature.txt", content: "x\n" } }),
    });
    const result = await orch.run({ taskId: "t-red", targetRepo: repo, goal: "fix add" }, parentCtx);

    const verifier = result.roles.find((r) => r.role === "verifier");
    assert.equal(verifier?.outcome, "failure", "the verifier reports RED on a target with no recognizable project");
    assert.match((verifier?.summary ?? ""), /RED/);
    assert.equal(result.promoted, false, "a RED build is NOT promoted");
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
  // A trivial, real, passing check (operator-configured, never model-chosen) run via real governed-exec.
  process.env.IKBI_CHECKS = JSON.stringify([{ name: "check", command: "node", args: ["-e", "process.exit(0)"] }]);
  process.env.IKBI_VERIFY = "legacy"; // explicit opt-out of the hardened ladder default → legacy resolveChecks
  try {
    const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
    const orch = realOrchestrator({
      targetRepo: repo, manager, governedExec: realGovernedExec(["node"]), resolveIdentity, roleClaim,
      roles: stubRoles({ write: { path: "feature.txt", content: "the fix\n" } }),
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
    await cleanup(repo, root);
  }
});

// HARDENED DEFAULT (A): with NO env vars, the production orchestrator runs LADDER verification —
// it plans from the project-index, runs the package's REAL `test` script (a non-stub command) over
// an impactful code change, and reports a scope-stamped GREEN. This is the fresh-operator default.
test("HB-1: ladder is the production default ⇒ real test script runs, scope-stamped GREEN, PROMOTED", async () => {
  const repo = await makeGitRepo({ packageJson: { name: "ikbitrial-ladder", version: "0.0.0", scripts: { test: "node -e \"process.exit(0)\"" } } });
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
      roles: stubRoles({ write: { path: "feature.ts", content: "export const fix = 1;\n" } }),
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

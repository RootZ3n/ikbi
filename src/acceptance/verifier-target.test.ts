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

test("HB-1: a valid target with a passing check ⇒ verifier GREEN, PROMOTED", async () => {
  const repo = await makeGitRepo({ packageJson: { name: "ikbitrial-pass", version: "0.0.0", scripts: { test: "node -e \"process.exit(0)\"" } } });
  const { manager, root } = makeManager();
  const savedChecks = process.env.IKBI_CHECKS;
  // A trivial, real, passing check (operator-configured, never model-chosen) run via real governed-exec.
  process.env.IKBI_CHECKS = JSON.stringify([{ name: "check", command: "node", args: ["-e", "process.exit(0)"] }]);
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
  } finally {
    if (savedChecks === undefined) delete process.env.IKBI_CHECKS; else process.env.IKBI_CHECKS = savedChecks;
    await cleanup(repo, root);
  }
});

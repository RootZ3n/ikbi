/**
 * THE GOVERNED CHECK RUNNER — v1 governed-exec through the v2 seam, for real.
 *
 * A real fixture directory and a real `pnpm test` script exercise the adapter's mapping of
 * governed-exec's `ExecResult` to the seam's `CheckExecution`: a pass, a fail, a
 * NON-ALLOWLISTED binary (which never launches → infrastructure), and a timeout.
 *
 * Capability: subprocess (registered in scripts/test-runner.sh).
 */

import "../test-env.js"; // MUST be first: hermetic synthetic dev-key opt-in, before core config loads
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { labTempDir as tmpdir } from "../../core/temp-root.js";
import { join } from "node:path";
import { after, test } from "node:test";

import { createCheckRunner } from "./check-runner.js";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A fixture directory with a package.json whose `test` script is `body`. */
function fixture(testScript: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-v2-checkrunner-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fx", scripts: { test: testScript } }));
  return dir;
}

const runner = createCheckRunner();

test("check runner: a passing pnpm script → launched, exit 0", async () => {
  const cwd = fixture("node -e \"console.log('# pass 1'); process.exit(0)\"");
  const exec = await runner.run({ name: "test", command: "pnpm", args: ["test"], cwd, timeoutMs: 30_000 });
  assert.equal(exec.launched, true);
  assert.equal(exec.exitCode, 0);
  assert.equal(exec.timedOut, false);
  assert.ok(exec.outputSha256.length === 64, "the output is hashed");
  assert.ok(exec.outputExcerpt.includes("# pass 1"), "a bounded excerpt is kept");
});

test("check runner: a failing pnpm script → launched, non-zero exit", async () => {
  const cwd = fixture("node -e \"console.error('boom'); process.exit(1)\"");
  const exec = await runner.run({ name: "test", command: "pnpm", args: ["test"], cwd, timeoutMs: 30_000 });
  assert.equal(exec.launched, true);
  assert.notEqual(exec.exitCode, 0);
  assert.equal(exec.timedOut, false);
});

test("check runner: a NON-ALLOWLISTED binary never launches (→ infrastructure)", async () => {
  const cwd = fixture("true");
  const exec = await runner.run({ name: "test", command: "definitely-not-allowlisted-xyz", args: [], cwd, timeoutMs: 30_000 });
  assert.equal(exec.launched, false, "governed-exec denied a non-allowlisted binary");
  assert.equal(exec.exitCode, undefined);
  assert.match(exec.refusedReason ?? "", /denied|not executed/);
});

test("check runner: a hanging script is killed at the timeout (→ timedOut)", async () => {
  const cwd = fixture("node -e \"setTimeout(() => {}, 60000)\"");
  const exec = await runner.run({ name: "test", command: "pnpm", args: ["test"], cwd, timeoutMs: 1_500 });
  assert.equal(exec.launched, true);
  assert.equal(exec.timedOut, true, "the streaming path stamps the timeout-kill exit code");
});

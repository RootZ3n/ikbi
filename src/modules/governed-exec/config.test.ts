/**
 * governed-exec config loader — the IKBI_GOVERNED_EXEC_ALLOWLIST override is ADDITIVE:
 * it EXTENDS the default allowlist (git/ls/echo) rather than replacing
 * it, so an operator who allows extra binaries does not silently lose the essentials the
 * builder relies on (git for version control, ls/echo for exploration).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { moduleEnv } from "../../core/module-config.js";
import { DEFAULT_ALLOWLIST, loadGovernedExecConfig } from "./config.js";

const reader = (env: Record<string, string>) => moduleEnv("governed-exec", env);

test("no ALLOWLIST override → exactly the defaults", () => {
  const cfg = loadGovernedExecConfig(reader({}));
  assert.deepEqual([...cfg.allowlist], [...DEFAULT_ALLOWLIST]);
});

test("ALLOWLIST override is ADDITIVE — defaults are preserved, new binaries appended (deduped)", () => {
  const cfg = loadGovernedExecConfig(reader({ IKBI_GOVERNED_EXEC_ALLOWLIST: "pnpm,node,npm,python3,mkdir,cp" }));
  // The essential defaults survive the override (the bug: they used to be REPLACED away).
  for (const must of DEFAULT_ALLOWLIST) {
    assert.ok(cfg.allowlist.includes(must), `default binary "${must}" must survive an override`);
  }
  // The new binaries are added.
  assert.ok(cfg.allowlist.includes("python3"));
  assert.ok(cfg.allowlist.includes("mkdir"));
  assert.ok(cfg.allowlist.includes("cp"));
  // Deduped: defaults that also appear in the override are not duplicated.
  assert.equal(cfg.allowlist.filter((b) => b === "pnpm").length, 1);
  assert.equal(cfg.allowlist.filter((b) => b === "node").length, 1);
  // Order-stable: defaults first, then the genuinely-new binaries in operator order.
  // pnpm and npm are now defaults so they get deduped from the override.
  assert.deepEqual([...cfg.allowlist], [...DEFAULT_ALLOWLIST, "node", "python3", "mkdir", "cp"]);
});

test("dangerous interpreters and file dumpers are not default-allowed", () => {
  const cfg = loadGovernedExecConfig(reader({}));
  // node and cat remain operator opt-in — node can eval arbitrary code, cat dumps secrets.
  // npm/npx/pnpm are now default-allowed because the verifier NEEDS them to run checks.
  for (const denied of ["node", "cat"]) {
    assert.equal(cfg.allowlist.includes(denied), false, `${denied} must be operator opt-in only`);
  }
});

test("a blank ALLOWLIST override leaves the defaults intact", () => {
  const cfg = loadGovernedExecConfig(reader({ IKBI_GOVERNED_EXEC_ALLOWLIST: "  " }));
  assert.deepEqual([...cfg.allowlist], [...DEFAULT_ALLOWLIST]);
});

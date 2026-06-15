/**
 * ikbi worker-model — external repo readiness (Phase 5).
 *
 * Edge-case check detection for external repos: js/ts without a manifest, yarn.lock repos,
 * bun-only repos, no-lockfile repos, multiple manifests, monorepos, and missing test scripts.
 * All tests are additive (no existing behavior modified).
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resolveChecks } from "./checks.js";

function repo(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `ikbi-extrepo-${prefix}-`));
}
const NOENV = {} as NodeJS.ProcessEnv;

// ── Task 1: repo type detection edge cases ────────────────────────────────────

test("no package.json but has .ts files → fail closed with JS/TS-specific guidance", () => {
  const wt = repo("nopkg-ts");
  writeFileSync(join(wt, "index.ts"), 'export const x = 1;\n');
  const r = resolveChecks(wt, NOENV);
  assert.equal(r.ok, false, "no manifest → fail closed");
  if (!r.ok) {
    assert.match(r.reason, /JavaScript\/TypeScript/, "mentions JS/TS files");
    assert.match(r.reason, /package\.json/, "guides toward adding package.json");
    assert.match(r.reason, /IKBI_CHECKS/, "guides toward IKBI_CHECKS");
  }
});

test("no package.json and no source files → fail closed with generic manifest message", () => {
  const wt = repo("nopkg-empty");
  writeFileSync(join(wt, "README.md"), "# docs only\n");
  const r = resolveChecks(wt, NOENV);
  assert.equal(r.ok, false, "no manifest → fail closed");
  if (!r.ok) {
    assert.doesNotMatch(r.reason, /JavaScript\/TypeScript/, "no JS/TS-specific message for docs-only repo");
    assert.match(r.reason, /manifest/, "mentions manifest");
  }
});

test("no package.json but has .js files → fail closed with JS/TS-specific guidance", () => {
  const wt = repo("nopkg-js");
  writeFileSync(join(wt, "app.js"), 'console.log("hello");\n');
  const r = resolveChecks(wt, NOENV);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /JavaScript\/TypeScript/);
});

test("multiple manifests (package.json + pyproject.toml) → picks JS/TS (package.json wins)", () => {
  const wt = repo("multi-manifest");
  writeFileSync(join(wt, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node --test" } }));
  writeFileSync(join(wt, "pyproject.toml"), "[project]\nname = \"x\"\nversion = \"0.1.0\"\n");
  const r = resolveChecks(wt, NOENV);
  assert.ok(r.ok, "JS/TS manifest wins over Python manifest");
  if (r.ok) {
    assert.ok(r.checks.some((c) => c.command === "pnpm" || c.command === "yarn" || c.command === "npm"), "JS/TS package manager used");
    assert.ok(!r.checks.some((c) => c.command === "python3"), "Python checks not used");
  }
});

test("monorepo: pnpm-workspace.yaml without package.json → JS/TS checks with pnpm", () => {
  const wt = repo("monorepo");
  writeFileSync(join(wt, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
  writeFileSync(join(wt, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(wt, "tsconfig.json"), '{"compilerOptions":{"strict":true}}\n');
  const r = resolveChecks(wt, NOENV);
  assert.ok(r.ok, "monorepo root resolves to a check set");
  if (r.ok) {
    assert.ok(r.checks.some((c) => c.command === "pnpm"), "monorepo uses pnpm");
  }
});

test("monorepo: pnpm-workspace.yaml with package.json → resolves without JS/TS confusion", () => {
  const wt = repo("monorepo-pkg");
  writeFileSync(join(wt, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
  writeFileSync(join(wt, "package.json"), JSON.stringify({ name: "root", scripts: { test: "pnpm -r test" } }));
  writeFileSync(join(wt, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const r = resolveChecks(wt, NOENV);
  assert.ok(r.ok, "monorepo with package.json resolves");
  if (r.ok) {
    assert.ok(r.checks.some((c) => c.command === "pnpm"), "pnpm used");
  }
});

// ── Task 2: package manager detection ────────────────────────────────────────

test("yarn.lock without pnpm/npm lockfile → YARN_CHECKS (yarn test + yarn tsc)", () => {
  const wt = repo("yarn");
  writeFileSync(join(wt, "package.json"), JSON.stringify({ name: "x", scripts: { test: "jest" } }));
  writeFileSync(join(wt, "yarn.lock"), "# yarn lockfile v1\n");
  writeFileSync(join(wt, "tsconfig.json"), '{"compilerOptions":{}}\n');
  const r = resolveChecks(wt, NOENV);
  assert.ok(r.ok, "yarn repo resolves to a check set");
  if (r.ok) {
    const cmds = r.checks.map((c) => c.command);
    assert.ok(cmds.every((c) => c === "yarn"), `all checks use yarn, got: ${cmds.join(",")}`);
    assert.ok(r.checks.some((c) => c.args.includes("test")), "yarn test present");
    assert.ok(r.checks.some((c) => c.args.includes("tsc")), "yarn tsc --noEmit present (has tsconfig)");
  }
});

test("yarn.lock without tsconfig → YARN_TEST_ONLY_CHECKS (no typecheck)", () => {
  const wt = repo("yarn-js");
  writeFileSync(join(wt, "package.json"), JSON.stringify({ name: "x", scripts: { test: "jest" } }));
  writeFileSync(join(wt, "yarn.lock"), "# yarn lockfile v1\n");
  const r = resolveChecks(wt, NOENV);
  assert.ok(r.ok);
  if (r.ok) {
    assert.ok(r.checks.every((c) => c.command === "yarn"), "only yarn checks");
    assert.ok(r.checks.every((c) => !c.args.includes("tsc")), "no typecheck when no tsconfig");
  }
});

test("pnpm-lock.yaml takes precedence over yarn.lock (pnpm wins)", () => {
  const wt = repo("pnpm-over-yarn");
  writeFileSync(join(wt, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node --test" } }));
  writeFileSync(join(wt, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(wt, "yarn.lock"), "# yarn lockfile v1\n");
  const r = resolveChecks(wt, NOENV);
  assert.ok(r.ok);
  if (r.ok) {
    assert.ok(r.checks.some((c) => c.command === "pnpm"), "pnpm wins over yarn");
    assert.ok(!r.checks.some((c) => c.command === "yarn"), "yarn not used when pnpm lock present");
  }
});

test("npm lockfile takes precedence over yarn.lock (npm wins)", () => {
  const wt = repo("npm-over-yarn");
  writeFileSync(join(wt, "package.json"), JSON.stringify({ name: "x", scripts: { test: "jest" } }));
  writeFileSync(join(wt, "package-lock.json"), '{"lockfileVersion":3}\n');
  writeFileSync(join(wt, "yarn.lock"), "# yarn lockfile v1\n");
  const r = resolveChecks(wt, NOENV);
  assert.ok(r.ok);
  if (r.ok) {
    assert.ok(r.checks.some((c) => c.command === "npm" || c.command === "npx"), "npm wins over yarn");
    assert.ok(!r.checks.some((c) => c.command === "yarn"), "yarn not used when npm lock present");
  }
});

test("bun.lockb only → fail closed (bun not supported)", () => {
  const wt = repo("bun");
  writeFileSync(join(wt, "package.json"), JSON.stringify({ name: "x", scripts: { test: "bun test" } }));
  writeFileSync(join(wt, "bun.lockb"), "bun lock binary\n");
  const r = resolveChecks(wt, NOENV);
  assert.equal(r.ok, false, "bun-only project fails closed");
  if (!r.ok) {
    assert.match(r.reason, /bun/, "mentions bun");
    assert.match(r.reason, /not a supported package manager/, "explains bun is not supported");
    assert.match(r.reason, /IKBI_CHECKS/, "guides toward IKBI_CHECKS");
  }
});

test("bun.lockb alongside pnpm-lock.yaml → pnpm wins (no fail close)", () => {
  const wt = repo("bun-plus-pnpm");
  writeFileSync(join(wt, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node --test" } }));
  writeFileSync(join(wt, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(wt, "bun.lockb"), "bun lock binary\n");
  const r = resolveChecks(wt, NOENV);
  assert.ok(r.ok, "pnpm lockfile overrides bun — no fail close");
  if (r.ok) assert.ok(r.checks.some((c) => c.command === "pnpm"), "pnpm used");
});

test("no lockfile → ok (defaults to pnpm) with a warning about missing lockfile", () => {
  const wt = repo("nolockfile");
  writeFileSync(join(wt, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node --test" } }));
  const r = resolveChecks(wt, NOENV);
  assert.ok(r.ok, "no lockfile still resolves (fail-open, defaults to pnpm)");
  if (r.ok) {
    assert.ok(r.checks.some((c) => c.command === "pnpm"), "defaults to pnpm");
    assert.ok(typeof r.warning === "string" && r.warning.length > 0, "warning issued for missing lockfile");
    assert.match(r.warning!, /lockfile/, "warning mentions lockfile");
  }
});

test("package.json with no test script → ok with a warning about missing script", () => {
  const wt = repo("no-test-script");
  writeFileSync(join(wt, "package.json"), JSON.stringify({ name: "x" }));
  writeFileSync(join(wt, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const r = resolveChecks(wt, NOENV);
  assert.ok(r.ok, "no test script still resolves (checks will fail at runtime)");
  if (r.ok) {
    assert.ok(typeof r.warning === "string", "warning issued for missing test script");
    assert.match(r.warning!, /test.*script|scripts\.test/, "warning mentions test script");
  }
});

test("package.json with a test script → no warning about missing script", () => {
  const wt = repo("has-test-script");
  writeFileSync(join(wt, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node --test" } }));
  writeFileSync(join(wt, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const r = resolveChecks(wt, NOENV);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.warning, undefined, "no warning when test script is present");
  }
});

test("IKBI_CHECKS env override still works for yarn repos", () => {
  const wt = repo("yarn-override");
  writeFileSync(join(wt, "package.json"), JSON.stringify({ name: "x" }));
  writeFileSync(join(wt, "yarn.lock"), "# yarn lockfile v1\n");
  const env = { IKBI_CHECKS: '[{"name":"test","command":"yarn","args":["jest","--ci"]}]' } as unknown as NodeJS.ProcessEnv;
  const r = resolveChecks(wt, env);
  assert.ok(r.ok && r.source === "env", "env override takes precedence");
  if (r.ok) {
    assert.equal(r.checks[0]?.command, "yarn");
    assert.ok(r.checks[0]?.args.includes("jest"));
  }
});

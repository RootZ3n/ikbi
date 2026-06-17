/**
 * ikbi worker-model — NON-JS external repo verification (Codex blocker 6).
 *
 * `resolveChecks` must give Rust/Go native checks (cargo/go), give Python pytest when detectable
 * (else fail closed with guidance), keep JS/TS on pnpm/npm, and NEVER silently run pnpm/tsc against
 * a non-JS repo. Planning/diff relevance must include .py/.go/.rs source files.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resolveChecks, workingTreePlanningDiff } from "./checks.js";

function repo(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `ikbi-${prefix}-`));
}
const NOENV = {} as NodeJS.ProcessEnv;

test("resolveChecks: a Rust repo (Cargo.toml) gets NATIVE cargo checks, never pnpm/tsc", () => {
  const wt = repo("rust");
  writeFileSync(join(wt, "Cargo.toml"), "[package]\nname = \"x\"\nversion = \"0.1.0\"\n");
  const r = resolveChecks(wt, NOENV);
  assert.ok(r.ok, "Rust repo resolves to a check set");
  if (r.ok) {
    const cmds: string[] = r.checks.map((c) => c.command);
    assert.ok(cmds.every((c) => c.startsWith("cargo")), `cargo-only, got ${cmds.join(",")}`);
    assert.ok(cmds.filter((c) => c === "pnpm" || c === "npx").length === 0, "no pnpm/tsc against Rust");
    assert.ok(r.checks.some((c) => c.args.includes("test")), "runs cargo test");
  }
});

test("resolveChecks: a Go repo (go.mod) gets NATIVE go checks, never pnpm/tsc", () => {
  const wt = repo("go");
  writeFileSync(join(wt, "go.mod"), "module example.com/x\n\ngo 1.22\n");
  const r = resolveChecks(wt, NOENV);
  assert.ok(r.ok);
  if (r.ok) {
    const cmds: string[] = r.checks.map((c) => c.command);
    assert.ok(cmds.every((c) => c.startsWith("go")), `go-only, got ${cmds.join(",")}`);
    assert.ok(r.checks.some((c) => c.args.join(" ") === "test ./..."), "runs go test ./...");
  }
});

test("resolveChecks: a Python repo with pytest config gets pytest checks", () => {
  const wt = repo("py-pytest");
  writeFileSync(join(wt, "pyproject.toml"), "[tool.pytest.ini_options]\naddopts = \"-q\"\n");
  const r = resolveChecks(wt, NOENV);
  assert.ok(r.ok, "pytest-configured Python resolves");
  if (r.ok) {
    assert.equal(r.checks[0]?.command, "python3");
    assert.ok(r.checks[0]?.args.includes("pytest"), "runs pytest");
    assert.ok(!r.checks.some((c) => c.command === "pnpm"), "no pnpm against Python");
  }
});

test("resolveChecks: a Python repo with NO test runner FAILS CLOSED with guidance (not pnpm)", () => {
  const wt = repo("py-bare");
  writeFileSync(join(wt, "pyproject.toml"), "[project]\nname = \"x\"\nversion = \"0.1.0\"\n");
  const r = resolveChecks(wt, NOENV);
  assert.ok(!r.ok, "bare Python project fails closed");
  if (!r.ok) {
    assert.match(r.reason, /IKBI_CHECKS/, "guidance points to IKBI_CHECKS");
    assert.doesNotMatch(r.reason, /pnpm/i);
  }
});

test("resolveChecks: a bare Python project still honors an explicit IKBI_CHECKS", () => {
  const wt = repo("py-env");
  writeFileSync(join(wt, "pyproject.toml"), "[project]\nname = \"x\"\n");
  const env = { IKBI_CHECKS: '[{"name":"test","command":"python3","args":["-m","pytest"]}]' } as unknown as NodeJS.ProcessEnv;
  const r = resolveChecks(wt, env);
  assert.ok(r.ok && r.source === "env");
  if (r.ok) assert.equal(r.checks[0]?.command, "python3");
});

test("resolveChecks: JS/TS keeps existing pnpm behavior", () => {
  const wt = repo("js");
  writeFileSync(join(wt, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node --test" } }));
  const r = resolveChecks(wt, NOENV);
  assert.ok(r.ok && r.checks[0]?.command === "pnpm", "JS still resolves to pnpm");
});

test("resolveChecks: a package-lock-only JS repo keeps npm behavior", () => {
  const wt = repo("js-npm");
  writeFileSync(join(wt, "package.json"), JSON.stringify({ name: "x" }));
  writeFileSync(join(wt, "package-lock.json"), "{}");
  const r = resolveChecks(wt, NOENV);
  assert.ok(r.ok);
  if (r.ok) assert.ok(r.checks.some((c) => c.command === "npm" || c.command === "npx"), "npm-family checks");
});

test("planning diff relevance: changed .py/.go/.rs files appear in the planning evidence", async () => {
  // A fake runGit returns one untracked file per language; the planning diff must surface all.
  const fakeGit = async (args: readonly string[]): Promise<string> => {
    if (args.includes("--name-only")) return ""; // no tracked changes
    if (args.includes("--others")) return "src/main.py\nsrv/app.go\nlib/core.rs\nREADME.md\n";
    return "";
  };
  const diff = await workingTreePlanningDiff(fakeGit, "/wt", "BASE");
  for (const f of ["src/main.py", "srv/app.go", "lib/core.rs"]) {
    assert.match(diff, new RegExp(f.replace(/[.]/g, "\\.")), `${f} is in the planning diff`);
  }
});

test("resolveChecks: a Godot repo (project.godot) gets headless check by default", () => {
  const wt = repo("godot");
  writeFileSync(join(wt, "project.godot"), "[application]\nconfig/name=\"TestGame\"\n");
  const r = resolveChecks(wt, NOENV);
  assert.ok(r.ok, "Godot repo resolves to a check set");
  if (r.ok) {
    assert.equal(r.checks[0]?.command, "godot", "uses godot binary");
    assert.ok(r.checks[0]?.args.includes("--headless"), "runs headless");
    assert.ok(r.checks[0]?.args.includes("--quit"), "headless quit mode");
    assert.ok(!r.checks.some((c) => c.command === "pnpm"), "no pnpm against Godot");
  }
});

test("resolveChecks: a Godot repo with GUT config gets GUT test checks", () => {
  const wt = repo("godot-gut");
  writeFileSync(join(wt, "project.godot"), "[application]\nconfig/name=\"TestGame\"\n");
  writeFileSync(join(wt, ".gutconfig.json"), JSON.stringify({ should_exit: true }));
  const r = resolveChecks(wt, NOENV);
  assert.ok(r.ok, "Godot+GUT repo resolves");
  if (r.ok) {
    assert.ok(r.checks[0]?.args.includes("addons/gut/gut_cmdln.gd"), "runs GUT");
  }
});

test("resolveChecks: a Godot repo with gdUnit4 gets gdUnit checks", () => {
  const wt = repo("godot-gdunit");
  writeFileSync(join(wt, "project.godot"), "[application]\nconfig/name=\"TestGame\"\n");
  mkdirSync(join(wt, "addons/gdUnit4"), { recursive: true });
  writeFileSync(join(wt, "addons/gdUnit4/placeholder"), "");
  const r = resolveChecks(wt, NOENV);
  assert.ok(r.ok, "Godot+gdUnit4 repo resolves");
  if (r.ok) {
    assert.ok(r.checks[0]?.args.includes("addons/gdUnit4/bin/GdUnitCmdTool.gd"), "runs gdUnit4");
  }
});

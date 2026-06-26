/**
 * ikbi worker-model — NON-JS external repo verification (Codex blocker 6).
 *
 * `resolveChecks` must give Rust/Go native checks (cargo/go), give Python pytest when detectable
 * (else fail closed with guidance), keep JS/TS on pnpm/npm, and NEVER silently run pnpm/tsc against
 * a non-JS repo. Planning/diff relevance must include .py/.go/.rs source files.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resolveChecks, workingTreePlanningDiff } from "./checks.js";

function repo(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `ikbi-${prefix}-`));
}
const NOENV = {} as NodeJS.ProcessEnv;

/**
 * Run git in `cwd` with a hermetic identity (no dependence on the host's global git config — a
 * machine with no `user.email` set would otherwise fail `git commit`). Returns trimmed stdout.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
}

/**
 * Materialize a real git repo with `files`, commit it, then `git worktree add` a SECOND working
 * tree — the production reality (the orchestrator builds in a `git worktree`, NOT a bare temp dir).
 * Returns the REALPATH of the worktree (matching the `worktreeReal` the orchestrator passes, after
 * symlink resolution on platforms where $TMPDIR is a symlink, e.g. macOS /var → /private/var).
 */
function worktreeWith(prefix: string, files: Record<string, string>): string {
  const main = repo(prefix);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(main, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  git(main, "init", "-q");
  git(main, "add", "-A");
  git(main, "commit", "-qm", "init");
  const wt = join(repo(`${prefix}-wt`), "scratch");
  git(main, "worktree", "add", "-q", wt, "HEAD");
  return realpathSync(wt);
}

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

test("resolveChecks: a MIXED-LANGUAGE repo (package.json + pyproject.toml) picks a DETERMINISTIC plan (JS first), never unresolvable", () => {
  // A target with both a JS manifest and a Python manifest must NOT fail closed as ambiguous and must
  // NOT be classified unresolvable — it deterministically resolves to the JS check set (package.json is
  // the strongest, first-checked signal). The Python side is verifiable via an explicit IKBI_CHECKS.
  const wt = repo("mixed");
  writeFileSync(join(wt, "package.json"), JSON.stringify({ name: "x", scripts: { test: "vitest run" } }));
  writeFileSync(join(wt, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
  writeFileSync(join(wt, "pyproject.toml"), "[tool.pytest.ini_options]\naddopts = \"-q\"\n");
  const r = resolveChecks(wt, NOENV);
  assert.ok(r.ok, "a mixed-language repo is verifiable (not unresolvable)");
  if (r.ok) assert.ok(r.checks.every((c) => c.command === "pnpm"), "deterministically resolves to the JS (pnpm) check set");
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

// ── Production path: a REAL `git worktree` (not a bare temp dir) ───────────────
// The orchestrator wires `resolveChecks(ctx.workspace.path)` against a `git worktree add`-ed tree
// (worker-model/orchestrator.ts; production-only via enforceProjectRoot). Every test above resolves
// a bare mkdtemp dir — none proves detection survives a worktree, where `.git` is a gitlink FILE and
// the manifest is a checked-out copy at the worktree root. These reproduce that exact shape.

test("worktree: a Rust worktree (git worktree add) still resolves NATIVE cargo checks", () => {
  const wt = worktreeWith("rust-wt", { "Cargo.toml": "[package]\nname = \"x\"\nversion = \"0.1.0\"\n", "src/lib.rs": "pub fn f() {}\n" });
  const r = resolveChecks(wt, NOENV);
  assert.ok(r.ok, "Rust worktree resolves (root === worktree, not a vacuous fail)");
  if (r.ok) {
    assert.ok(r.checks.every((c) => c.command.startsWith("cargo")), "cargo-only in a worktree");
    assert.ok(r.checks.some((c) => c.args.includes("test")), "runs cargo test in a worktree");
  }
});

test("worktree: a Python (pytest) worktree still resolves pytest checks", () => {
  const wt = worktreeWith("py-wt", { "pyproject.toml": "[tool.pytest.ini_options]\naddopts = \"-q\"\n", "test_x.py": "def test_x():\n    assert True\n" });
  const r = resolveChecks(wt, NOENV);
  assert.ok(r.ok, "Python worktree resolves to pytest (root === worktree)");
  if (r.ok) {
    assert.equal(r.checks[0]?.command, "python3");
    assert.ok(r.checks[0]?.args.includes("pytest"), "runs pytest in a worktree");
    assert.ok(!r.checks.some((c) => c.command === "pnpm"), "NEVER pnpm against a Python worktree");
  }
});

test("worktree GUARD: a worktree NESTED under a parent manifest fails closed (validates the WRONG repo)", () => {
  // The exact bug the production guard closes: a worktree living INSIDE another project (here a JS
  // workspace) must NOT borrow the ancestor's manifest and run the ancestor's pnpm/tsc suite.
  const parent = repo("nested-parent");
  writeFileSync(join(parent, "package.json"), JSON.stringify({ name: "parent", scripts: { test: "node --test" } }));
  writeFileSync(join(parent, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const nested = join(parent, "vendor", "child");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "main.py"), "print('hi')\n"); // a child with NO manifest of its own
  const r = resolveChecks(nested, NOENV);
  assert.equal(r.ok, false, "nested no-manifest dir fails closed — never inherits the parent's checks");
  if (!r.ok) {
    assert.match(r.reason, /ANCESTOR/, "explains the resolved root is an ancestor (wrong repo)");
    assert.doesNotMatch(r.reason, /\bvacuous pass\b.*\bvacuous pass\b/, "single, clear message");
  }
});

// ── Actionable, language-specific failure messages (no manifest / no runner) ──

test("actionable message: a Go repo (go.mod) resolves NATIVE go checks (never pnpm/tsc)", () => {
  const wt = worktreeWith("go-wt", { "go.mod": "module example.com/x\n\ngo 1.22\n", "main.go": "package main\nfunc main() {}\n" });
  const r = resolveChecks(wt, NOENV);
  assert.ok(r.ok, "Go worktree resolves to go checks");
  if (r.ok) assert.ok(r.checks.every((c) => c.command.startsWith("go")), "go-only, never pnpm");
});

test("actionable message: a bare Python project (no pytest) names IKBI_CHECKS, not pnpm", () => {
  const wt = repo("py-actionable");
  writeFileSync(join(wt, "pyproject.toml"), "[project]\nname = \"x\"\nversion = \"0.1.0\"\n");
  const r = resolveChecks(wt, NOENV);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /IKBI_CHECKS/, "tells the operator exactly how to declare checks");
    assert.match(r.reason, /python3.*pytest/i, "shows a concrete pytest example");
    assert.doesNotMatch(r.reason, /pnpm/i, "never suggests pnpm for a Python repo");
  }
});

test("actionable message: an unrecognized manifest (deno.json) fails closed with guidance, not pnpm", () => {
  const wt = repo("deno-actionable");
  writeFileSync(join(wt, "deno.json"), "{\n  \"tasks\": { \"test\": \"deno test\" }\n}\n");
  const r = resolveChecks(wt, NOENV);
  assert.equal(r.ok, false, "an unrecognized-but-present manifest fails closed");
  if (!r.ok) {
    assert.match(r.reason, /IKBI_CHECKS/, "guides toward IKBI_CHECKS");
    assert.match(r.reason, /will not run irrelevant pnpm/i, "promises NOT to run pnpm/tsc here");
  }
});

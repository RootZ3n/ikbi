/**
 * CHECK DISCOVERY — the neutral, deterministic owner (V2-020/Phase 3).
 *
 * WHY THIS MODULE EXISTS. This logic used to live in `modules/worker-model/checks.ts`, alongside the
 * v1 five-role build pipeline. v2 — the canonical production build engine — needs check DISCOVERY,
 * and nothing else from worker-model. Leaving it there meant the one production engine permanently
 * depended on a module whose conceptual owner is the retired v1 orchestration, which is exactly the
 * kind of hidden coupling this repository is converging away from.
 *
 * So discovery moved here, to a module owned by nobody's pipeline. The behaviour is UNCHANGED and
 * UNFORKED: `worker-model/checks.ts` now re-exports these symbols for its own remaining callers, so
 * there is exactly one implementation and one set of semantics.
 *
 * WHAT THIS MODULE OWNS:
 *   - the `Check` shape and the default read-only check set;
 *   - the operator's `IKBI_CHECKS` declaration (parsing + precedence);
 *   - project-root/manifest detection (so checks never run against an ANCESTOR's project);
 *   - fail-closed resolution: an unrunnable project yields an actionable reason, never a vacuous pass;
 *   - the check timeout policy.
 *
 * WHAT IT DELIBERATELY DOES NOT OWN: role orchestration, execution-result mapping, diffing, or any
 * v1 pipeline concept. Those stayed behind. Only an OPERATOR (`IKBI_CHECKS`) or a structured MANIFEST
 * may authorize a command — repository prose is never execution authority.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A fixed check. The command list is a named constant — never model-chosen. */
export interface Check {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
}

/** THE default, read-only check set (pnpm — ikbi's own checks; the builder previews the same). */
export const VERIFIER_CHECKS: readonly Check[] = [
  { name: "typecheck", command: "pnpm", args: ["tsc", "--noEmit"] },
  { name: "test", command: "pnpm", args: ["test"] },
];

/** npm-equivalent checks for repos that use package-lock.json instead of pnpm-lock.yaml. */
const NPM_CHECKS: readonly Check[] = [
  { name: "typecheck", command: "npx", args: ["tsc", "--noEmit"] },
  { name: "test", command: "npm", args: ["test"] },
];

/** Test-only checks for JS repos without tsconfig.json (no typecheck — tsc would just print help). */
const JS_TEST_ONLY_CHECKS: readonly Check[] = [{ name: "test", command: "pnpm", args: ["test"] }];
const NPM_TEST_ONLY_CHECKS: readonly Check[] = [{ name: "test", command: "npm", args: ["test"] }];

/** yarn checks (yarn.lock detected, no pnpm/npm lockfile). */
const YARN_CHECKS: readonly Check[] = [
  { name: "typecheck", command: "yarn", args: ["tsc", "--noEmit"] },
  { name: "test", command: "yarn", args: ["test"] },
];
const YARN_TEST_ONLY_CHECKS: readonly Check[] = [{ name: "test", command: "yarn", args: ["test"] }];

/** Rust (Cargo) native checks. `cargo`/`go`/`python3` are NOT default-allowlisted in governed-exec —
 *  an un-allowlisted binary returns a fail-closed RED with the actionable "add X to the allowlist"
 *  note (mapExec), never a vacuous pass; allowlisting them runs the real native suite. */
const RUST_CHECKS: readonly Check[] = [
  { name: "check", command: "cargo", args: ["check"] },
  { name: "test", command: "cargo", args: ["test"] },
];

/** Go native checks. */
const GO_CHECKS: readonly Check[] = [
  { name: "build", command: "go", args: ["build", "./..."] },
  { name: "test", command: "go", args: ["test", "./..."] },
];

/** Python native checks (pytest) — only emitted when a pytest signal is detected (else fail closed). */
const PYTHON_PYTEST_CHECKS: readonly Check[] = [{ name: "test", command: "python3", args: ["-m", "pytest", "-q"] }];

/** Python STDLIB checks (unittest) — emitted when `test*.py` files exist but no pytest signal does.
 *  unittest is stdlib (no pip/network, so it runs inside the sandbox where pytest install fails
 *  closed) and its default discovery pattern is `test*.py`, which the detection below matches. */
const PYTHON_UNITTEST_CHECKS: readonly Check[] = [{ name: "test", command: "python3", args: ["-m", "unittest", "discover", "-v"] }];

/** .NET native checks — `dotnet test` restores (into the sandbox's writable NuGet cache over the
 *  shared net), builds, and runs the test projects a .sln / .csproj declares. */
const DOTNET_CHECKS: readonly Check[] = [{ name: "test", command: "dotnet", args: ["test", "--nologo", "-v", "q"] }];

/** Maven native checks — `mvn test` (NOT `-q`, which hides the Surefire "Tests run:" summary the
 *  evidence gate reads). Deps + plugins fetch from Central over the shared net into the sandbox's
 *  redirected local repo (/tmp/.m2 via MAVEN_OPTS). */
const MAVEN_CHECKS: readonly Check[] = [{ name: "test", command: "mvn", args: ["test"] }];

/** Absolute path to the ikbi-shipped Gradle init script (resolved from this module, works under both
 *  tsx/src and compiled dist since both sit 3 dirs below the repo root). */
const GRADLE_INIT_SCRIPT = fileURLToPath(new URL("../../../assets/gradle-test-summary.init.gradle", import.meta.url));

/** Gradle native checks — Gradle prints NO test count on success and caches tasks UP-TO-DATE, so a
 *  passing build would read "no test evidence". `--rerun-tasks` forces execution and the shipped
 *  `--init-script` emits a JUnit-style summary the evidence gate parses. `--no-daemon`/`--console=plain`
 *  keep output clean and non-persistent in the sandbox. */
const GRADLE_CHECKS: readonly Check[] = [{
  name: "test",
  command: "gradle",
  args: ["test", "--rerun-tasks", "--no-daemon", "--console=plain", "--init-script", GRADLE_INIT_SCRIPT],
}];

/** Godot headless syntax check (Godot 4.x — lightweight, no test framework needed). */
const GODOT_HEADLESS_CHECKS: readonly Check[] = [{ name: "check", command: "godot", args: ["--headless", "--quit"] }];

/** Godot with GUT (Godot Unit Test) framework. */
const GODOT_GUT_CHECKS: readonly Check[] = [{ name: "test", command: "godot", args: ["--headless", "-s", "addons/gut/gut_cmdln.gd"] }];

/** Godot with gdUnit4 test framework. */
const GODOT_GDUNIT_CHECKS: readonly Check[] = [{ name: "test", command: "godot", args: ["--headless", "-s", "addons/gdUnit4/bin/GdUnitCmdTool.gd"] }];

/** True iff a file under `root` exists. */
function rootHas(root: string, file: string): boolean {
  return existsSync(join(root, file));
}

/** True iff `dir` contains at least one .js/.ts/.jsx/.tsx file (shallow, non-recursive). */
function hasJsTsFiles(dir: string): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).some((e) => e.isFile() && /\.[jt]sx?$/i.test(e.name));
  } catch {
    return false;
  }
}

/**
 * True iff the package.json at `root` declares a non-empty `scripts.test`. Returns
 * true (no warning) when the file is absent/unreadable — fail-open for warnings only;
 * also returns true for pnpm-workspace roots that may not have a root package.json test
 * script (they delegate testing to workspace packages).
 */
function hasTestScript(root: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const t = pkg.scripts?.test;
    return typeof t === "string" && t.trim().length > 0;
  } catch {
    return true; // fail-open: if unreadable, do not warn
  }
}

/**
 * Resolve a NON-JS Python project's checks. Prefer pytest when a clear signal exists (a
 * pytest/tox config file, or a pyproject/setup.cfg that mentions pytest); otherwise FAIL CLOSED with
 * guidance to set IKBI_CHECKS rather than inventing a runner that might silently pass nothing.
 */
function detectPythonChecks(projectRoot: string): ChecksResolution {
  let pytestSignal = rootHas(projectRoot, "pytest.ini") || rootHas(projectRoot, "tox.ini");
  for (const cfg of ["pyproject.toml", "setup.cfg"]) {
    if (pytestSignal) break;
    try {
      if (/pytest/i.test(readFileSync(join(projectRoot, cfg), "utf8"))) pytestSignal = true;
    } catch {
      /* file absent/unreadable — no signal from it */
    }
  }
  if (pytestSignal) return { ok: true, checks: PYTHON_PYTEST_CHECKS, source: "default" };
  // STDLIB FALLBACK: no pytest signal, but `test*.py` files exist (unittest's default discovery
  // pattern) ⇒ run `python3 -m unittest discover`. This is a REAL runner keyed off a real signal, not
  // an invented one: with no matching test files unittest prints "Ran 0 tests" ⇒ testEvidence "zero"
  // ⇒ the gate still discards. pytest needs pip/network (fails closed in the sandbox), so unittest is
  // the only stdlib Python path that actually runs there.
  if (hasUnittestFiles(projectRoot)) return { ok: true, checks: PYTHON_UNITTEST_CHECKS, source: "default" };
  return {
    ok: false,
    reason:
      `Python project at ${projectRoot} has no detectable test runner (no pytest/tox config, no test*.py files) — refusing to invent checks. ` +
      `Set IKBI_CHECKS to declare them, e.g. IKBI_CHECKS='[{"name":"test","command":"python3","args":["-m","pytest"]}]' (RED until configured).`,
  };
}

/** True iff a .NET project/solution file exists at the root or one level down — the `dotnet test` signal. */
function hasDotnetProject(projectRoot: string): boolean {
  const rx = /\.(csproj|fsproj|sln)$/i;
  const scan = (dir: string): boolean => {
    try { return readdirSync(dir, { withFileTypes: true }).some((e) => e.isFile() && rx.test(e.name)); } catch { return false; }
  };
  if (scan(projectRoot)) return true;
  try {
    return readdirSync(projectRoot, { withFileTypes: true }).some((e) => e.isDirectory() && !e.name.startsWith(".") && scan(join(projectRoot, e.name)));
  } catch { return false; }
}

/** True iff `test*.py` files exist at the root or inside a `tests/` dir — the unittest discovery signal. */
function hasUnittestFiles(projectRoot: string): boolean {
  const scan = (dir: string): boolean => {
    try {
      return readdirSync(dir, { withFileTypes: true }).some((e) => e.isFile() && /^test.*\.py$/i.test(e.name));
    } catch {
      return false;
    }
  };
  return scan(projectRoot) || scan(join(projectRoot, "tests"));
}

/**
 * Detect the language-native check set from the manifests in the project root. JS/TS detects
 * the package manager from lockfiles (pnpm > npm > yarn; bun-only fails closed; no lockfile
 * defaults to pnpm with a warning). Rust/Go get native cargo/go checks; Python gets pytest
 * when detectable, else fails closed. An unrecognized manifest (e.g. Deno) FAILS CLOSED with
 * guidance — ikbi never silently runs pnpm/tsc against a non-JS repo.
 */
function detectChecksForProject(projectRoot: string): ChecksResolution {
  // JS/TS — package.json (or a pnpm workspace root) is the strongest signal.
  if (rootHas(projectRoot, "package.json") || rootHas(projectRoot, "pnpm-workspace.yaml")) {
    const hasPnpmLock = rootHas(projectRoot, "pnpm-lock.yaml");
    const hasNpmLock = rootHas(projectRoot, "package-lock.json");
    const hasYarnLock = rootHas(projectRoot, "yarn.lock");
    const hasBunLock = rootHas(projectRoot, "bun.lockb");
    const hasTsconfig = rootHas(projectRoot, "tsconfig.json");

    // Bun: fail closed only when bun.lockb is the SOLE lockfile (no supported pm fallback).
    if (hasBunLock && !hasPnpmLock && !hasNpmLock && !hasYarnLock) {
      return {
        ok: false,
        reason:
          `JS/TS project at ${projectRoot} has only bun.lockb — bun is not a supported package manager. ` +
          `Set IKBI_CHECKS to declare checks explicitly, or add a pnpm-lock.yaml / package-lock.json / yarn.lock (RED until configured).`,
      };
    }

    // Package manager precedence: pnpm > npm > yarn; no lockfile → pnpm default.
    const useNpm = hasNpmLock && !hasPnpmLock;
    const useYarn = hasYarnLock && !hasPnpmLock && !hasNpmLock;

    const warnings: string[] = [];

    if (!hasPnpmLock && !hasNpmLock && !hasYarnLock) {
      warnings.push(
        `no lockfile (pnpm-lock.yaml, package-lock.json, yarn.lock) found at ${projectRoot} — ` +
        `defaulting to pnpm checks; add a lockfile for reproducible dependency installs`,
      );
    }

    // Warn (not fail-closed) when package.json has no test script — the checks will still
    // fail at runtime with a clear "Missing script: test" message.
    if (rootHas(projectRoot, "package.json") && !hasTestScript(projectRoot)) {
      warnings.push(
        `package.json at ${projectRoot} has no "test" script — add scripts.test or set IKBI_CHECKS; ` +
        `the test check will fail with "Missing script: test"`,
      );
    }

    const warn = warnings.length > 0 ? { warning: warnings.join("; ") } : {};

    // JS-only repos (no tsconfig.json): skip typecheck — tsc would just print help.
    if (!hasTsconfig) {
      const checks = useYarn ? YARN_TEST_ONLY_CHECKS : useNpm ? NPM_TEST_ONLY_CHECKS : JS_TEST_ONLY_CHECKS;
      return { ok: true, checks, source: "default", ...warn };
    }
    const checks = useYarn ? YARN_CHECKS : useNpm ? NPM_CHECKS : VERIFIER_CHECKS;
    return { ok: true, checks, source: "default", ...warn };
  }
  if (rootHas(projectRoot, "Cargo.toml")) return { ok: true, checks: RUST_CHECKS, source: "default" };
  if (rootHas(projectRoot, "go.mod")) return { ok: true, checks: GO_CHECKS, source: "default" };
  if (rootHas(projectRoot, "pom.xml")) return { ok: true, checks: MAVEN_CHECKS, source: "default" };
  if (rootHas(projectRoot, "build.gradle") || rootHas(projectRoot, "build.gradle.kts") || rootHas(projectRoot, "settings.gradle") || rootHas(projectRoot, "settings.gradle.kts")) {
    return { ok: true, checks: GRADLE_CHECKS, source: "default" };
  }
  if (rootHas(projectRoot, "pyproject.toml") || rootHas(projectRoot, "setup.py") || rootHas(projectRoot, "setup.cfg")) {
    return detectPythonChecks(projectRoot);
  }
  if (rootHas(projectRoot, "project.godot")) {
    // Prefer test framework (GUT > gdUnit4) over bare headless check.
    if (rootHas(projectRoot, ".gutconfig.json") || rootHas(projectRoot, "gutconfig.json")) {
      return { ok: true, checks: GODOT_GUT_CHECKS, source: "default" };
    }
    if (rootHas(projectRoot, "addons/gdUnit4")) {
      return { ok: true, checks: GODOT_GDUNIT_CHECKS, source: "default" };
    }
    // Godot 4.x headless syntax check — lightweight, always available.
    return { ok: true, checks: GODOT_HEADLESS_CHECKS, source: "default" };
  }
  return {
    ok: false,
    reason:
      `project root ${projectRoot} has a manifest but no recognized JS/Rust/Go/Python check set — ` +
      `set IKBI_CHECKS to declare the checks (RED until configured; ikbi will not run irrelevant pnpm/tsc here).`,
  };
}

/**
 * Project manifests that mark a repository ROOT. The presence of one at a directory means
 * "this is a project root" for check resolution. Used to detect the "validates the wrong
 * repo" bug: checks must run against the worktree's OWN project, never an ancestor's.
 */
export const PROJECT_MANIFESTS: readonly string[] = [
  "package.json",
  "pnpm-workspace.yaml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "pyproject.toml",
  // H8: legacy Python projects mark their root with setup.py / setup.cfg (no pyproject.toml). Without
  // these a setup.py-only project is not detected as a root → its declared checks are missed.
  "setup.py",
  "setup.cfg",
  "deno.json",
  "deno.jsonc",
  "project.godot",
];

/** Walk up from `start` to the nearest directory holding a project manifest; undefined if none. */
export function resolveProjectRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    for (const m of PROJECT_MANIFESTS) {
      if (existsSync(join(dir, m))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined; // reached the filesystem root
    dir = parent;
  }
}

/** The resolved check set, or a fail-closed RED reason when the target has no valid project root. */
export type ChecksResolution =
  | { readonly ok: true; readonly checks: readonly Check[]; readonly source: "default" | "env"; readonly warning?: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Parse the per-target check set from `IKBI_CHECKS` — a JSON array of {name, command, args},
 * e.g. `[{"name":"test","command":"npm","args":["test"]}]`. This is OPERATOR-configured (an
 * env var, never read from the worktree, never model-chosen). Returns `undefined` when unset,
 * the parsed checks when valid, or `"malformed"` (→ fail-closed RED) on bad JSON / shape.
 */
export function parseChecksEnv(raw: string | undefined): readonly Check[] | "malformed" | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return "malformed";
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return "malformed";
  const checks: Check[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) return "malformed";
    const o = item as Record<string, unknown>;
    if (typeof o.name !== "string" || o.name.length === 0) return "malformed";
    if (typeof o.command !== "string" || o.command.length === 0) return "malformed";
    if (!Array.isArray(o.args) || !o.args.every((a) => typeof a === "string")) return "malformed";
    checks.push({ name: o.name, command: o.command, args: [...(o.args as string[])] });
  }
  return checks;
}

/**
 * Resolve the check set to run against a worktree WITH a fail-closed PROJECT-ROOT GUARD.
 *
 * THE BUG this closes: worktrees can live INSIDE ikbi's own pnpm workspace, so `pnpm tsc` /
 * `pnpm test` with cwd=worktree walk UP and run IKBI's suite — a target with no manifest
 * would then "pass" vacuously. The guard asserts the project root resolved from the worktree
 * EQUALS the worktree root; if the nearest manifest is an ANCESTOR (wrong repo) or there is
 * NONE (no recognizable project), it returns RED (ok:false) — never a vacuous pass.
 *
 * The command set is configured by the operator (the `IKBI_CHECKS` env, NEVER model-chosen);
 * the default is pnpm (VERIFIER_CHECKS). A malformed IKBI_CHECKS fails closed (RED) rather
 * than silently falling back, so a typo can never mask an unverified build.
 */
export function resolveChecks(worktreeReal: string, env: NodeJS.ProcessEnv = process.env): ChecksResolution {
  const wt = resolve(worktreeReal);
  // H8 — EXPLICIT operator config wins, applied BEFORE any auto-discovery. IKBI_CHECKS is operator-only
  // (NEVER model-chosen). Previously this was consulted only AFTER a project root was detected, so a
  // manifest-less project (or one whose root resolved to an ancestor) silently IGNORED the operator's
  // declared checks and fell through to fail-closed auto-discovery. Explicit config must always win.
  // A malformed value fails closed (RED) rather than falling back to a guessed runner.
  const fromEnv = parseChecksEnv(env.IKBI_CHECKS);
  if (fromEnv === "malformed") {
    return { ok: false, reason: "IKBI_CHECKS is malformed (expected a non-empty JSON array of {name,command,args}) — cannot verify (RED)" };
  }
  if (fromEnv !== undefined) return { ok: true, checks: fromEnv, source: "env" };

  const root = resolveProjectRoot(wt);
  if (root === undefined) {
    // .NET / C#: project files are glob-named (Foo.csproj / Foo.sln), not a fixed manifest, so the
    // walk-up misses them. `dotnet test` restores + builds + runs the declared test projects (NuGet
    // fetched into the sandbox's writable cache over the shared net). A vacuous run ("No test is
    // available" / "Total: 0") yields no parseable count ⇒ testEvidence unverified/zero ⇒ still discarded.
    if (hasDotnetProject(wt)) return { ok: true, checks: DOTNET_CHECKS, source: "default" };
    // LOOSE-SOURCE PYTHON: no manifest, but `test*.py` files exist ⇒ stdlib unittest. A cheap model
    // scaffolding a small Python CLI usually writes just `foo.py` + `test_foo.py` (no pyproject.toml);
    // manifest-only detection would fail-close it. unittest is a REAL, deterministic runner keyed off a
    // specific signal (not invented) and runs in the sandbox (stdlib, no pip); a no-match run prints
    // "Ran 0 tests" ⇒ testEvidence zero ⇒ still discarded. So this never manufactures a vacuous pass.
    if (hasUnittestFiles(wt)) return { ok: true, checks: PYTHON_UNITTEST_CHECKS, source: "default" };
    // Give a more actionable message when we can detect the language without a manifest.
    if (hasJsTsFiles(wt)) {
      return {
        ok: false,
        reason:
          `found JavaScript/TypeScript source files at ${wt} but no package.json or other recognizable project manifest — ` +
          `add a package.json with a "test" script, or set IKBI_CHECKS (RED until configured).`,
      };
    }
    return { ok: false, reason: `no recognizable project manifest at or above the worktree (${wt}) — cannot verify (RED, never a vacuous pass)` };
  }
  if (root !== wt) {
    return { ok: false, reason: `the resolved project root (${root}) is an ANCESTOR of the worktree (${wt}) — checks would validate the WRONG repo (RED)` };
  }
  // Language-native detection (JS/TS unchanged; Rust/Go native; Python pytest-or-fail-closed; any
  // other manifest fails closed with guidance). NEVER silently runs pnpm/tsc against a non-JS repo.
  // (IKBI_CHECKS was already applied above — explicit operator config wins before auto-discovery.)
  return detectChecksForProject(wt);
}

/** Default per-check wall-clock budget (ms) — SEPARATE from the model role timeout, and far
 *  larger than governed-exec's 30s read-only-tool default so real suites don't get SIGKILL'd.
 *  Overridable via IKBI_CHECK_TIMEOUT_MS. The verifier AND the builder's in-loop run_checks
 *  both resolve their per-check timeout through this single source so the builder previews the
 *  verifier's EXACT budget (a build whose tests take >30s is no longer killed mid-loop). */
export const DEFAULT_CHECK_TIMEOUT_MS = 600_000;

/** Upper clamp for IKBI_CHECK_TIMEOUT_MS — Node's setTimeout overflows past 2^31-1 ms (fires ~at
 *  once), which would SIGKILL every check instantly. Clamp to the max safe 32-bit delay. */
export const MAX_CHECK_TIMEOUT_MS = 2_147_483_647;

/**
 * Resolve the per-check wall-clock timeout (ms) from IKBI_CHECK_TIMEOUT_MS. Invalid / non-positive
 * ⇒ the default; valid ⇒ CLAMPED to MAX_CHECK_TIMEOUT_MS (above which Node's setTimeout overflows
 * and fires ~immediately → every check SIGKILL'd → false RED). One resolver, shared by the verifier
 * (ladder + legacy loops) and the builder's run_checks, so they always agree on the budget.
 */
export function resolveCheckTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.IKBI_CHECK_TIMEOUT_MS ?? "").trim();
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_CHECK_TIMEOUT_MS) : DEFAULT_CHECK_TIMEOUT_MS;
}

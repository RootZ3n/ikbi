/**
 * ikbi worker-model — THE SHARED CHECK DEFINITION.
 *
 * The single source of truth for the project's objective checks (typecheck + tests).
 * Both the VERIFIER (the pipeline's source of truth, end of run) and the BUILDER's
 * in-loop `run_checks` tool import `VERIFIER_CHECKS` FROM HERE — so the builder's
 * in-loop preview runs the verifier's EXACT checks, through the same governed-exec
 * path, against the same worktree. One definition, two callers: the builder can never
 * pass a weaker practice check and fail the real exam (they are provably the same).
 *
 * Read-only: the checks (`tsc --noEmit`, `test`) do not mutate the workspace.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { ExecResult } from "../governed-exec/index.js";

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
  return {
    ok: false,
    reason:
      `Python project at ${projectRoot} has no detectable test runner (no pytest/tox config) — refusing to invent checks. ` +
      `Set IKBI_CHECKS to declare them, e.g. IKBI_CHECKS='[{"name":"test","command":"python3","args":["-m","pytest"]}]' (RED until configured).`,
  };
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
  "pyproject.toml",
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
  const root = resolveProjectRoot(wt);
  if (root === undefined) {
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
  // Fix 2: operator-configured, NEVER model-chosen. IKBI_CHECKS wins; default is pnpm.
  const fromEnv = parseChecksEnv(env.IKBI_CHECKS);
  if (fromEnv === "malformed") {
    return { ok: false, reason: "IKBI_CHECKS is malformed (expected a non-empty JSON array of {name,command,args}) — cannot verify (RED)" };
  }
  if (fromEnv !== undefined) return { ok: true, checks: fromEnv, source: "env" };
  // Language-native detection (JS/TS unchanged; Rust/Go native; Python pytest-or-fail-closed; any
  // other manifest fails closed with guidance). NEVER silently runs pnpm/tsc against a non-JS repo.
  return detectChecksForProject(wt);
}

/**
 * VERIFICATION CLASSIFICATION — the load-bearing distinction this module exists to draw.
 *
 *   checks_green        checks were derived, ran, and PASSED.
 *   checks_red          checks were derived and ran, but FAILED. A legitimate build/model failure
 *                       that MAY enter the retry/escalation policy (a stronger model can fix red code).
 *   checks_unresolvable ikbi could NOT derive or run any meaningful verifier — no manifest, no
 *                       recognized project type, no runnable check command, no IKBI_CHECKS override.
 *                       A stronger model cannot fix a MISSING manifest, so this MUST NOT escalate;
 *                       it fails closed with an actionable diagnostic.
 *   unsupported_project a project manifest exists but ikbi has no check set for it (e.g. bun-only,
 *                       or a manifest type with no derivable checks). Same fail-closed, no-escalate
 *                       handling as checks_unresolvable.
 *   environment_missing a required tool/runtime was absent (reserved; classified elsewhere).
 *   tool_limitation     the verification TOOL (not the project) could not parse/run the check.
 */
export type VerificationKind =
  | "checks_green"
  | "checks_red"
  | "checks_unresolvable"
  | "environment_missing"
  | "tool_limitation"
  | "unsupported_project";

/**
 * Classify a `resolveChecks` fail-closed reason (the `{ ok: false, reason }` branch) into the
 * no-verifier verdict kind. A manifest that EXISTS but has no derivable check set (or an
 * unsupported package manager) is UNSUPPORTED_PROJECT; the absence of any derivable verifier is
 * CHECKS_UNRESOLVABLE. Both suppress escalation and fail closed — the split is for the diagnostic.
 */
export function classifyUnresolvableReason(reason: string): "checks_unresolvable" | "unsupported_project" {
  if (/has a manifest but no recognized|not a supported package manager/i.test(reason)) {
    return "unsupported_project";
  }
  return "checks_unresolvable";
}

/** Actionable operator next-steps shown when a target is unverifiable (no derivable checks). */
export const UNRESOLVABLE_NEXT_STEPS: readonly string[] = [
  "add a project manifest (package.json / pyproject.toml / Cargo.toml / go.mod / project.godot)",
  "add a test/check script the verifier can run",
  'set IKBI_CHECKS="<command>" to declare the checks explicitly',
  "use an explicit bootstrap task if the goal is to initialize a project",
];

/**
 * The standard fail-closed, OPERATOR-actionable diagnostic for an unverifiable target. Surfaced on
 * the run result + receipt + CLI so the operator sees WHY the build failed closed (no runnable
 * checks), that this is NOT a model failure (escalation was suppressed), and HOW to make the target
 * verifiable. `kind` selects the "Detected" framing: UNSUPPORTED_PROJECT means a manifest WAS found
 * but ikbi has no check set for it; CHECKS_UNRESOLVABLE means nothing verifiable was found at all.
 */
export function unresolvableMessage(kind: string, reason: string): string {
  const detected =
    kind === "unsupported_project"
      ? ["a project manifest was found, but ikbi has no check set for this project type", `details: ${reason}`, "no IKBI_CHECKS override"]
      : ["no recognized project manifest or verifier", "no runnable check script", "no IKBI_CHECKS override"];
  return [
    "ikbi could not verify this target because no runnable checks were found.",
    "",
    `Classification: ${kind}`,
    "",
    "Detected:",
    ...detected.map((d) => `  - ${d}`),
    "",
    "This is not a model failure. Escalation was suppressed because a stronger model cannot fix a missing verification contract.",
    "",
    "Next steps:",
    ...UNRESOLVABLE_NEXT_STEPS.map((s) => `  - ${s}`),
  ].join("\n");
}

/**
 * The WORKING-TREE diff of package.json files vs base — what the script-integrity guard MUST
 * inspect. The verifier runs BEFORE the build is committed, so `git diff <baseRef>` (base vs the
 * current working tree) captures the builder's UNCOMMITTED edits to tracked package.json files,
 * whereas the committed `base..scratch` range is empty at that point. Scoped to `*package.json`
 * (git pathspec `*` crosses directories) so it covers root + every subpackage and stays small.
 * A brand-new (untracked) package.json does not appear — that is greenfield-legitimate, and its
 * no-op scripts are caught separately by the verification-ladder stub detector.
 *
 * FULL CONTEXT (`-U…`): the integrity guard's JSON-semantic pass reconstructs the whole base/working
 * package.json from this diff and compares the resolved `scripts` objects. A 3-line-context diff would
 * only show fragments (not JSON-parseable) and fall back to the weaker line-scan, so we request enough
 * context to span the file. package.json files are small, so the larger diff is cheap.
 */
export async function workingTreePackageJsonDiff(
  runGit: (args: readonly string[]) => Promise<string>,
  _worktreePath: string,
  baseRef: string,
): Promise<string> {
  return runGit(["diff", "-U1000000", baseRef, "--", "*package.json"]);
}

/**
 * The COMMITTED diff of package.json files for the `base..scratch` range — what the script-integrity
 * guard inspects for a candidate that COMMITS before it is judged (competitive mode), where the
 * working-tree diff is empty. The general committed diff (workspaces.diff → `git diff base..scratch`)
 * uses git's DEFAULT 3-line context, too narrow for the JSON-semantic parser to reconstruct a whole
 * package.json: a fragment is not JSON-parseable, so the parser returns indeterminate and falls back
 * to the weaker line-scan (which misses, e.g., a separate-line "test":/value rewrite). This requests
 * FULL context (`-U1000000`) for the SAME reason workingTreePackageJsonDiff does, scoped to
 * `*package.json` so it covers root + every subpackage and stays small.
 */
export async function committedPackageJsonDiff(
  runGit: (args: readonly string[]) => Promise<string>,
  baseRef: string,
  scratchBranch: string,
): Promise<string> {
  return runGit(["diff", "-U1000000", `${baseRef}..${scratchBranch}`, "--", "*package.json"]);
}

/**
 * Accumulate the FULL stdout of a STREAMING governed-exec call. governed-exec's ExecResult retains
 * only a bounded `stdoutTail` (the last ~2000 chars). Reading a large `git diff` through that tail
 * truncates the TOP of the diff — a package.json "scripts" mutation above the tail window would be
 * silently dropped before the JSON-semantic parser ever runs (a >2000-char diff flags the mutation,
 * but the last-2000-char tail returns clean). The streaming `onOutput` sink delivers every chunk
 * untruncated; this helper concatenates them so the integrity parser sees the whole diff. `forward`
 * (optional) mirrors each chunk to a secondary sink (e.g. the live UI). Falls back to `stdoutTail`
 * if nothing streamed (a buffered executor that ignores `onOutput`).
 */
export async function captureStreamedStdout(
  run: (onOutput: (chunk: string, stream: "stdout" | "stderr") => void) => Promise<ExecResult>,
  forward?: (chunk: string, stream: "stdout" | "stderr") => void,
): Promise<string> {
  let full = "";
  const res = await run((chunk, stream) => {
    if (stream === "stdout") full += chunk;
    if (forward !== undefined) forward(chunk, stream);
  });
  return full.length > 0 ? full : (res.stdoutTail ?? "");
}

const RELEVANT_WORKTREE_EXTS: readonly string[] = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".vue",
  ".svelte",
  ".md",
  ".mdx",
  ".yaml",
  ".yml",
  // Non-JS source languages — so planning/diff relevance covers Rust/Go/Python work too (a build
  // that only touches .py/.go/.rs is no longer seen as an empty, impact-scoped "nothing changed").
  ".py",
  ".go",
  ".rs",
  ".toml",
];

function syntheticAddedDiff(path: string): string {
  return [`diff --git a/${path} b/${path}`, "--- /dev/null", `+++ b/${path}`, "@@ -0,0 +1 @@", "+untracked"].join("\n");
}

function isRelevantWorktreePath(path: string): boolean {
  const lower = path.toLowerCase();
  return RELEVANT_WORKTREE_EXTS.some((ext) => lower.endsWith(ext));
}

/**
 * Verifier-time planning diff: tracked working-tree changes against `baseRef` plus untracked
 * relevant files. The synthetic untracked headers make `parseChangedFiles` see greenfield work
 * rather than treating an empty tracked diff as an impact-scoped green.
 */
export async function workingTreePlanningDiff(
  runGit: (args: readonly string[]) => Promise<string>,
  _worktreePath: string,
  baseRef: string,
): Promise<string> {
  const trackedRaw = await runGit(["diff", "--name-only", baseRef, "--", "."]);
  const untrackedRaw = await runGit(["ls-files", "--others", "--exclude-standard", "--", "."]);
  const paths = [...trackedRaw.split(/\r?\n/), ...untrackedRaw.split(/\r?\n/)]
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && isRelevantWorktreePath(s))
    .sort();
  const unique = [...new Set(paths)];
  return unique.map(syntheticAddedDiff).join("\n");
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

/** Captured output tail length retained in a check result. */
export const MAX_OUTPUT_TAIL = 2_000;

/** One check's outcome. Lives in the open `detail` bag — NOT a contract type. */
export interface CheckResult {
  readonly name: string;
  readonly command: string;
  readonly exitCode: number;
  readonly outputTail: string;
  /**
   * Test tally ("# tests N" / "# pass N") parsed from the FULL, untruncated check output — robust
   * to `outputTail` truncation. A zero-test marker emitted EARLY in a verbose passing run is pushed
   * out of the last-MAX_OUTPUT_TAIL-chars tail, so re-parsing the tail downstream would miss it and
   * read "unverified" instead of "zero". Computed once here from the whole stream and carried so the
   * verdict layer (readVerifier) has a reliable count. Absent when no count was present in the output.
   */
  readonly testCount?: { readonly passed: number; readonly total: number };
  /**
   * When present, this check failure is caused by the VERIFICATION TOOL, not the project.
   * The project may be perfectly fine — the tool simply cannot parse/analyze modern syntax.
   * A verifier should classify this as TOOL_LIMITATION (non-blocking), not PROJECT_RED (blocking).
   */
  readonly toolLimitation?: { readonly reason: string };
}

export function tail(s: string, max: number): string {
  return s.length <= max ? s : s.slice(s.length - max);
}

/**
 * Parse a test-runner summary into a { passed, total } count, when present. Shared by the
 * check-capture layer (mapExec, on the FULL output) and the verdict layer (readVerifier) so both
 * read the tally the same way. Returns undefined when no recognizable summary is found.
 *
 * Recognizes the common runners — node:test, vitest, and jest — plus a generic
 * "N passing/passed ... M total/tests" shape. The node:test marker is tried first (it is ikbi's own
 * runner and the most precise); the others are fallbacks so repos under test with vitest/jest are not
 * stuck "unverified" (which would fail the C1 gate even when tests really ran and passed).
 */
export function parseTestCount(output: string): { passed: number; total: number } | undefined {
  // node:test: "# tests N" / "# pass N" (the two markers can be far apart in the stream).
  const nodeTests = /# tests (\d+)/.exec(output);
  const nodePass = /# pass (\d+)/.exec(output);
  if (nodeTests !== null && nodePass !== null) {
    return { passed: Number(nodePass[1]), total: Number(nodeTests[1]) };
  }

  // vitest: "Tests  3 passed (3)" — passed count then total in parens.
  const vitest = /Tests\s+(\d+)\s+passed\s+\((\d+)\)/.exec(output);
  if (vitest !== null) return { passed: Number(vitest[1]), total: Number(vitest[2]) };

  // jest: "Tests:       3 passed, 3 total".
  const jest = /Tests:\s+(\d+)\s+passed.*?(\d+)\s+total/.exec(output);
  if (jest !== null) return { passed: Number(jest[1]), total: Number(jest[2]) };

  // Generic "N passing/passed ... M total/tests" (mocha-style and friends).
  const generic = /(\d+)\s+(?:passing|passed)[\s\S]*?(\d+)\s+(?:total|tests)/.exec(output);
  if (generic !== null) return { passed: Number(generic[1]), total: Number(generic[2]) };


  // pytest: "N passed in X.XXs" or "N passed, M failed in X.XXs" (passed count only)
  const pytest = /(\d+)\s+passed(?:,\s+\d+\s+\w+)*\s+in\s+[\d.]+s/.exec(output);
  if (pytest !== null) { const n = Number(pytest[1]); return { passed: n, total: n }; }

  // cargo test: "test result: ok. N passed; M failed; K ignored; L measured; J filtered out"
  const cargoResult = /test result:\s*ok\.\s*(\d+)\s+passed;\s*(\d+)\s+failed/.exec(output);
  if (cargoResult !== null) {
    const passed = Number(cargoResult[1]);
    const failed = Number(cargoResult[2]);
    return { passed, total: passed + failed };
  }
  // cargo test: simpler form — "test result: ok. N passed" (no failures mentioned)
  const cargoOk = /test result:\s*ok\.\s*(\d+)\s+passed/.exec(output);
  if (cargoOk !== null) { const n = Number(cargoOk[1]); return { passed: n, total: n }; }

  // go test: "ok  \tpackage/path\t0.123s" (pass) or "FAIL\tpackage/path\t0.123s" (fail)
  // Count ok/FAIL lines to determine total packages tested.
  const goOk = (output.match(/^ok\s+/gm) || []).length;
  const goFail = (output.match(/^FAIL\s+/gm) || []).length;
  if (goOk > 0 || goFail > 0) {
    return { passed: goOk, total: goOk + goFail };
  }

  return undefined;
}

/**
 * Detect when a check failure is caused by the VERIFICATION TOOL, not the project.
 * Returns a toolLimitation descriptor when the output matches known tool parser failures,
 * undefined otherwise. This lets the verifier distinguish "your code is broken" from
 * "the linter can't parse modern syntax."
 */
function detectToolLimitation(command: string, output: string): { reason: string } | undefined {
  // gdtoolkit (gdlint/gdformat): parser doesn't support async func, @export, or other GDScript 4.x syntax
  if (command.includes("gdlint") || command.includes("gdformat")) {
    if (/Unexpected token.*async/i.test(output) || /Unexpected token.*'NAME'.*'async'/i.test(output)) {
      return { reason: "gdtoolkit parser does not support `async func` syntax (GDScript 4.x) — tool limitation, not a project error" };
    }
    // A generic "Unexpected token … Expected one of" is NOT enough on its own — that matches ANY
    // parse error, including a real syntax mistake in the project (which is a PROJECT_RED, not a
    // tool limitation). Only classify it as a tool limitation when the UNEXPECTED token is a known
    // modern-syntax construct the tool predates (C5: gdtoolkit detector was too broad).
    const TOOL_LIMITATION_PATTERNS: readonly RegExp[] = [
      /async\s+func/i, // GDScript 4.x async functions
      /@export|@onready|@tool\b|@icon|@rpc/i, // GDScript 4.x annotations (named forms)
      /Token\('AT'/, // gdtoolkit's token name for an annotation '@'
      /match\s*[:{]/, // Python 3.10+ / GDScript match-case
      /type\s+\w+\s*=/i, // Python 3.10+ type aliases
    ];
    if (/Unexpected token/i.test(output) && /Expected one of/i.test(output) && TOOL_LIMITATION_PATTERNS.some((re) => re.test(output))) {
      return { reason: "gdtoolkit parser failed on modern syntax it does not recognize (e.g. an annotation or async func) — tool limitation, not a project error" };
    }
  }
  // Python tools: syntax version mismatches
  if (command.includes("pylint") || command.includes("flake8") || command.includes("mypy")) {
    if (/SyntaxError.*invalid syntax/i.test(output) && /match\s+/.test(output)) {
      return { reason: "linter does not support Python 3.10+ match/case syntax — tool limitation" };
    }
  }
  // Generic: tool crash / unhandled exception in the tool itself
  if (/Traceback \(most recent call last\)/.test(output) && /(?:gdlint|gdformat|pylint|flake8|mypy|eslint|tsc)/i.test(command)) {
    return { reason: "verification tool crashed with an unhandled exception — tool limitation, not a project error" };
  }
  return undefined;
}

/**
 * Map one governed ExecResult onto a CheckResult (fail-closed on deny / dry-run).
 *
 * `fullOutput` (optional) is the COMPLETE, untruncated stdout the caller accumulated from the
 * streaming `onOutput` sink. governed-exec's ExecResult only retains the last OUTPUT_TAIL_CHARS, so
 * a zero-test marker emitted early in a verbose run is already gone from `res.stdoutTail`. When the
 * caller supplies the full stream, the test tally is parsed from THAT (robust); otherwise we fall
 * back to the bounded tail. The stamped `testCount` lets the verdict layer avoid re-parsing the tail.
 */
export function mapExec(name: string, command: string, res: ExecResult, fullOutput?: string): { check: CheckResult; dryRun: boolean } {
  if (res.executed) {
    const output = `${res.stdoutTail ?? ""}${res.stderrTail ?? ""}`;
    const testCount = parseTestCount(fullOutput ?? output);
    // Detect tool limitations on non-zero exit — the tool failed, not necessarily the project.
    const toolLimitation = (res.exitCode ?? 1) !== 0 ? detectToolLimitation(command, fullOutput ?? output) : undefined;
    return {
      check: { name, command, exitCode: res.exitCode ?? 1, outputTail: tail(output, MAX_OUTPUT_TAIL), ...(testCount !== undefined ? { testCount } : {}), ...(toolLimitation !== undefined ? { toolLimitation } : {}) },
      dryRun: false,
    };
  }
  if (res.denied === true) {
    // FAIL CLOSED: a denied / non-allowlisted check is a non-zero check, NEVER a pass.
    const note = `governed-exec DENIED: ${res.reason ?? "denied"} — add "${command.split(" ")[0]}" to IKBI_GOVERNED_EXEC_ALLOWLIST for real checks`;
    return { check: { name, command, exitCode: res.exitCode ?? 1, outputTail: tail(note, MAX_OUTPUT_TAIL) }, dryRun: false };
  }
  // executed:false, not denied ⇒ DRY-RUN (governed-exec reported intent, ran nothing).
  const note = `governed-exec dry-run: ${res.reason ?? "intent only — not executed"}`;
  return { check: { name, command, exitCode: 1, outputTail: tail(note, MAX_OUTPUT_TAIL) }, dryRun: true };
}

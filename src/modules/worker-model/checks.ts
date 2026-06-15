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

import { existsSync, readFileSync } from "node:fs";
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

/** True iff a file under `root` exists. */
function rootHas(root: string, file: string): boolean {
  return existsSync(join(root, file));
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
 * Detect the language-native check set from the manifests in the project root. JS/TS keeps its exact
 * prior behavior (pnpm default, npm when only package-lock.json is present). Rust/Go get native
 * cargo/go checks; Python gets pytest when detectable, else fails closed. An unrecognized manifest
 * (e.g. Deno) FAILS CLOSED with guidance — ikbi never silently runs pnpm/tsc against a non-JS repo.
 */
function detectChecksForProject(projectRoot: string): ChecksResolution {
  // JS/TS — package.json (or a pnpm workspace root) is the strongest signal. Preserve prior behavior.
  if (rootHas(projectRoot, "package.json") || rootHas(projectRoot, "pnpm-workspace.yaml")) {
    const hasPnpmLock = rootHas(projectRoot, "pnpm-lock.yaml");
    const hasNpmLock = rootHas(projectRoot, "package-lock.json");
    const hasTsconfig = rootHas(projectRoot, "tsconfig.json");
    const useNpm = hasNpmLock && !hasPnpmLock;
    // JS-only repos (no tsconfig.json): skip typecheck — tsc would just print help and confuse the builder.
    if (!hasTsconfig) {
      return { ok: true, checks: useNpm ? NPM_TEST_ONLY_CHECKS : JS_TEST_ONLY_CHECKS, source: "default" };
    }
    return { ok: true, checks: useNpm ? NPM_CHECKS : VERIFIER_CHECKS, source: "default" };
  }
  if (rootHas(projectRoot, "Cargo.toml")) return { ok: true, checks: RUST_CHECKS, source: "default" };
  if (rootHas(projectRoot, "go.mod")) return { ok: true, checks: GO_CHECKS, source: "default" };
  if (rootHas(projectRoot, "pyproject.toml") || rootHas(projectRoot, "setup.py") || rootHas(projectRoot, "setup.cfg")) {
    return detectPythonChecks(projectRoot);
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
  | { readonly ok: true; readonly checks: readonly Check[]; readonly source: "default" | "env" }
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
    return {
      check: { name, command, exitCode: res.exitCode ?? 1, outputTail: tail(output, MAX_OUTPUT_TAIL), ...(testCount !== undefined ? { testCount } : {}) },
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

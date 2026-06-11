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

import { existsSync } from "node:fs";
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

/**
 * Detect the package manager from lockfiles in the project root and return
 * the matching check set. Defaults to pnpm when ambiguous.
 */
function detectChecksForProject(projectRoot: string): readonly Check[] {
  const hasPnpmLock = existsSync(join(projectRoot, "pnpm-lock.yaml"));
  const hasNpmLock = existsSync(join(projectRoot, "package-lock.json"));
  if (hasNpmLock && !hasPnpmLock) return NPM_CHECKS;
  return VERIFIER_CHECKS;
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
  return { ok: true, checks: detectChecksForProject(wt), source: "default" };
}

/**
 * The WORKING-TREE diff of package.json files vs base — what the script-integrity guard MUST
 * inspect. The verifier runs BEFORE the build is committed, so `git diff <baseRef>` (base vs the
 * current working tree) captures the builder's UNCOMMITTED edits to tracked package.json files,
 * whereas the committed `base..scratch` range is empty at that point. Scoped to `*package.json`
 * (git pathspec `*` crosses directories) so it covers root + every subpackage and stays small.
 * A brand-new (untracked) package.json does not appear — that is greenfield-legitimate, and its
 * no-op scripts are caught separately by the verification-ladder stub detector.
 */
export async function workingTreePackageJsonDiff(
  runGit: (args: readonly string[]) => Promise<string>,
  worktreePath: string,
  baseRef: string,
): Promise<string> {
  return runGit(["-C", worktreePath, "diff", baseRef, "--", "*package.json"]);
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
  worktreePath: string,
  baseRef: string,
): Promise<string> {
  const trackedRaw = await runGit(["-C", worktreePath, "diff", "--name-only", baseRef, "--", "."]);
  const untrackedRaw = await runGit(["-C", worktreePath, "ls-files", "--others", "--exclude-standard", "--", "."]);
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
}

export function tail(s: string, max: number): string {
  return s.length <= max ? s : s.slice(s.length - max);
}

/** Map one governed ExecResult onto a CheckResult (fail-closed on deny / dry-run). */
export function mapExec(name: string, command: string, res: ExecResult): { check: CheckResult; dryRun: boolean } {
  if (res.executed) {
    const output = `${res.stdoutTail ?? ""}${res.stderrTail ?? ""}`;
    return { check: { name, command, exitCode: res.exitCode ?? 1, outputTail: tail(output, MAX_OUTPUT_TAIL) }, dryRun: false };
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

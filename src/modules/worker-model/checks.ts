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
  return { ok: true, checks: VERIFIER_CHECKS, source: "default" };
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

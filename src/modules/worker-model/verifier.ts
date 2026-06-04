/**
 * ikbi worker-model — VERIFIER role (Pass A: objective checks, DETERMINISTIC).
 *
 * Scoped (pending 3-eyes): run a FIXED, known set of read-only checks (typecheck +
 * tests) against the workspace and produce an objective verdict. NOT model-driven:
 * verifier never calls `invokeModel`, and the command set is a hardcoded constant.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECURITY NOTE (for the 3rd eye / Codex — a design choice, NOT settled):
 *   Verifier runs a FIXED command set only. Model-driven / dynamic command
 *   selection is DELIBERATELY EXCLUDED here — letting a model choose what to
 *   execute is an arbitrary-execution surface that belongs (if anywhere) in the
 *   builder's reviewed, governed tool loop, never in the deterministic verifier.
 *   Flagged for Codex to rule on; do not treat as final.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Read-only: the checks below (`tsc --noEmit`, `test`) do not mutate the
 * workspace. Commands run with `cwd: ctx.workspace.path`.
 */

import { spawnSync } from "node:child_process";

import type { RoleFn } from "./contract.js";

/** A fixed check. The command list is a named constant — never model-chosen. */
interface Check {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
}

/** THE fixed, read-only check set. */
const VERIFIER_CHECKS: readonly Check[] = [
  { name: "typecheck", command: "pnpm", args: ["tsc", "--noEmit"] },
  { name: "test", command: "pnpm", args: ["test"] },
];

/** Per-check wall-clock budget (ms). */
const VERIFIER_TIMEOUT_MS = 300_000;
/** Max captured bytes per check. */
const VERIFIER_MAX_BUFFER = 8 * 1024 * 1024;
/** Captured output tail length retained in the result. */
const MAX_OUTPUT_TAIL = 2_000;

/** One check's outcome. Lives in the open `detail` bag — NOT a contract type. */
export interface CheckResult {
  readonly name: string;
  readonly command: string;
  readonly exitCode: number;
  readonly outputTail: string;
}

/** How a check is executed — injectable so the deterministic logic is unit-testable. */
export type CheckRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => { exitCode: number; output: string };

/** Default runner: spawn the command synchronously in the workspace, capture exit + output. */
const defaultRunner: CheckRunner = (command, args, cwd) => {
  const res = spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    timeout: VERIFIER_TIMEOUT_MS,
    maxBuffer: VERIFIER_MAX_BUFFER,
  });
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  // A null status means the process was killed (signal/timeout) or failed to spawn
  // → treat as a non-zero (failed) check, fail-closed.
  const exitCode = res.status ?? 1;
  return { exitCode, output };
};

function tail(s: string, max: number): string {
  return s.length <= max ? s : s.slice(s.length - max);
}

/** Build a verifier with an injectable runner (tests supply a mock; default spawns). */
export function createVerifier(run: CheckRunner = defaultRunner): RoleFn {
  return async (ctx) => {
    const checks: CheckResult[] = [];
    for (const c of VERIFIER_CHECKS) {
      const { exitCode, output } = run(c.command, c.args, ctx.workspace.path);
      checks.push({
        name: c.name,
        command: `${c.command} ${c.args.join(" ")}`,
        exitCode,
        outputTail: tail(output, MAX_OUTPUT_TAIL),
      });
    }
    const allPass = checks.every((c) => c.exitCode === 0);
    const failed = checks.filter((c) => c.exitCode !== 0).map((c) => c.name);
    return {
      role: "verifier",
      outcome: allPass ? "success" : "failure",
      summary: allPass ? "all checks passed" : `checks failed: ${failed.join(", ")}`,
      detail: { verdict: allPass ? "pass" : "fail", checks },
    };
  };
}

/** The default verifier (real spawn-based runner). */
export const verifier: RoleFn = createVerifier();

/**
 * ikbi worker-model — VERIFIER role (Pass A: objective checks, DETERMINISTIC).
 *
 * Runs a FIXED, known set of read-only checks (typecheck + tests) against the
 * workspace and produces an objective verdict. NOT model-driven: verifier never
 * calls `invokeModel`, and the command set is a hardcoded constant.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECURITY (3-eyes, C1) — TWO orthogonal guards, BOTH load-bearing:
 *
 *  LAYER 1 — GOVERNED EXECUTION. The checks run through GOVERNED-EXEC (gate-wall
 *    authorizes, receipted, default-deny allowlist, dry-run-able), NEVER raw
 *    `spawnSync`. A DENIED check (non-allowlisted binary / gate deny) FAILS CLOSED —
 *    it is a non-zero check, never a silent pass. `pnpm` is NOT on governed-exec's
 *    default allowlist; the operator must add it to IKBI_GOVERNED_EXEC_ALLOWLIST for
 *    real verification (governed-exec's default-deny posture is intentionally kept).
 *    governed-exec needs a validated OperationContext (#10) — the orchestrator threads
 *    the run's parent ctx (the spawned role identity is not a minted ValidatedIdentity,
 *    so it cannot itself authorize a governed exec).
 *
 *  LAYER 2 — SCRIPT INTEGRITY. The BUILDER controls the workspace, including
 *    `package.json`'s "scripts". A governed invocation of an attacker-rewritten `test`
 *    script is still arbitrary execution — and a build that makes its own tests "pass"
 *    by rewriting them would forge a passing signal to the judge/promote. So BEFORE any
 *    check, the verifier inspects the workspace diff (base..scratch) and REJECTS the
 *    verification as UNTRUSTED if the builder modified the script surface the verifier
 *    relies on. A test suite the builder rewrote cannot verify the builder's own work.
 *    Fail-closed: a mutated-scripts build CANNOT pass verification (in competitive mode
 *    the judge then disqualifies it). When no diff source is wired, integrity cannot be
 *    proven — a documented limitation surfaced in the verdict detail.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Read-only: the checks below (`tsc --noEmit`, `test`) do not mutate the workspace.
 * Commands run with `cwd: ctx.workspace.path`.
 */

import type { OperationContext } from "../../core/identity/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import type { ExecResult, GovernedExec } from "../governed-exec/index.js";

import type { RoleFn, RoleResult } from "./contract.js";

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

/** Captured output tail length retained in the result. */
const MAX_OUTPUT_TAIL = 2_000;

/**
 * The package.json script keys the verifier's checks depend on: `pnpm test` runs the
 * "test" script (and its pre/post hooks); `pnpm tsc`/build the tsc/build surface. A
 * builder change to ANY of these means the command the verifier runs is attacker-defined.
 * (A dependency bump touches "dependencies"/"devDependencies" — NOT these — so it does
 * not trip; this is precise scope, not "any package.json change".)
 */
const GUARDED_SCRIPT_KEYS: readonly string[] = [
  "test", "pretest", "posttest",
  "build", "prebuild", "postbuild",
  "tsc", "pretsc", "posttsc",
];

/** One check's outcome. Lives in the open `detail` bag — NOT a contract type. */
export interface CheckResult {
  readonly name: string;
  readonly command: string;
  readonly exitCode: number;
  readonly outputTail: string;
}

/** Injectable dependencies. Defaults wire the live governed-exec singleton (lazily). */
export interface VerifierDeps {
  /** Governed executor — every check routes through it (gate-wall + allowlist + receipts). */
  readonly governedExec?: Pick<GovernedExec, "run">;
  /**
   * The run's validated OperationContext. governed-exec requires a minted
   * ValidatedIdentity (#10) + honors `dryRun`. Absent ⇒ the verifier fails closed.
   */
  readonly parentCtx?: OperationContext;
  /** Workspace diff source (base..scratch) for the LAYER-2 script-integrity guard. */
  readonly diff?: (workspace: WorkspaceHandle) => Promise<string>;
}

function tail(s: string, max: number): string {
  return s.length <= max ? s : s.slice(s.length - max);
}

/** Lazy live governed-exec — importing it eagerly would force the gate-wall/egress wiring order. */
function lazyGovernedExec(): Pick<GovernedExec, "run"> {
  return { run: async (req) => (await import("../governed-exec/index.js")).governedExec.run(req) };
}

/** The UNTRUSTED verdict — a mutated/unprovable build fails verification, fail-closed. */
function untrusted(reason: string): RoleResult {
  return { role: "verifier", outcome: "failure", summary: reason, detail: { verdict: "untrusted", reason, checks: [] } };
}

/**
 * LAYER-2 detector: does the unified workspace diff modify package.json's "scripts"
 * surface? Returns mutated:true when any changed (added/removed) line inside a
 * package.json file touches the "scripts" key or a guarded script entry. EXPORTED for
 * unit tests. Fail-closed by design: it flags the verifier-relied-on script commands
 * (the attack is rewriting `test`); a dependency bump does NOT match these keys.
 */
export function detectScriptMutation(diff: string): { mutated: boolean; reason?: string } {
  let inPackageJson = false;
  for (const line of diff.split("\n")) {
    // A new file section. `git diff` emits `diff --git a/<p> b/<p>` naming the file.
    if (line.startsWith("diff --git ")) {
      inPackageJson = /package\.json/.test(line);
      continue;
    }
    // The `+++ b/<p>` header also names the file (diffs without a `diff --git` line).
    if (line.startsWith("+++ ")) {
      if (/package\.json/.test(line)) inPackageJson = true;
      continue;
    }
    if (line.startsWith("--- ")) continue; // old-file header — not a content line
    if (!inPackageJson) continue;
    // A CHANGED content line (added/removed) — not a header (`+++`/`---` handled above).
    const changed = line.startsWith("+") || line.startsWith("-");
    if (!changed) continue;
    const body = line.slice(1);
    if (/^\s*"scripts"\s*:/.test(body)) {
      return { mutated: true, reason: 'builder modified package.json "scripts"' };
    }
    const key = /^\s*"([A-Za-z0-9:_-]+)"\s*:/.exec(body);
    if (key !== null && GUARDED_SCRIPT_KEYS.includes(key[1]!)) {
      return { mutated: true, reason: `builder modified package.json script "${key[1]}"` };
    }
  }
  return { mutated: false };
}

/** Map one governed ExecResult onto a CheckResult (fail-closed on deny). */
function mapExec(name: string, command: string, res: ExecResult): { check: CheckResult; dryRun: boolean } {
  if (res.executed) {
    const output = `${res.stdoutTail ?? ""}${res.stderrTail ?? ""}`;
    return { check: { name, command, exitCode: res.exitCode ?? 1, outputTail: tail(output, MAX_OUTPUT_TAIL) }, dryRun: false };
  }
  if (res.denied === true) {
    // FAIL CLOSED: a denied / non-allowlisted check is a non-zero check, NEVER a pass.
    const note = `governed-exec DENIED: ${res.reason ?? "denied"} — add "${command.split(" ")[0]}" to IKBI_GOVERNED_EXEC_ALLOWLIST for real verification`;
    return { check: { name, command, exitCode: res.exitCode ?? 1, outputTail: tail(note, MAX_OUTPUT_TAIL) }, dryRun: false };
  }
  // executed:false, not denied ⇒ DRY-RUN (governed-exec reported intent, ran nothing).
  const note = `governed-exec dry-run: ${res.reason ?? "intent only — not executed"}`;
  return { check: { name, command, exitCode: 1, outputTail: tail(note, MAX_OUTPUT_TAIL) }, dryRun: true };
}

/** Build a verifier. Tests inject fakes; the default wires the live governed-exec. */
export function createVerifier(deps: VerifierDeps = {}): RoleFn {
  const governedExec = deps.governedExec ?? lazyGovernedExec();
  return async (ctx) => {
    // ── LAYER 2: SCRIPT-INTEGRITY GUARD (before ANY check) ────────────────────
    let integrityNote: string | undefined;
    if (deps.diff !== undefined) {
      let diffText: string;
      try {
        diffText = await deps.diff(ctx.workspace);
      } catch (err) {
        // Cannot read the diff ⇒ cannot prove integrity ⇒ fail-closed UNTRUSTED.
        return untrusted(`verification untrusted: workspace diff unavailable (${err instanceof Error ? err.message : String(err)})`);
      }
      const mutation = detectScriptMutation(diffText);
      if (mutation.mutated) {
        // The builder controls the test command — a passing result cannot be trusted and
        // must NOT feed the judge/promote. Do NOT run the mutated script as a real check.
        return untrusted(`verification untrusted: ${mutation.reason}`);
      }
    } else {
      // No diff source wired ⇒ integrity cannot be proven (documented limitation).
      integrityNote = "integrity unverified: no workspace diff source wired";
    }

    // ── LAYER 1: GOVERNED CHECKS ──────────────────────────────────────────────
    // governed-exec needs a validated OperationContext (#10). Without it, fail closed.
    if (deps.parentCtx === undefined) {
      return untrusted("verifier not wired with an operation context — cannot run governed checks");
    }
    const parentCtx = deps.parentCtx;

    const checks: CheckResult[] = [];
    let sawDryRun = false;
    for (const c of VERIFIER_CHECKS) {
      const res = await governedExec.run({
        parentCtx,
        command: c.command,
        args: [...c.args],
        cwd: ctx.workspace.path,
        purpose: `verifier check: ${c.name}`,
      });
      const { check, dryRun } = mapExec(c.name, `${c.command} ${c.args.join(" ")}`, res);
      checks.push(check);
      sawDryRun = sawDryRun || dryRun;
    }

    // DRY-RUN: governed-exec executed nothing → report a dry-run verdict, NOT a pass
    // (and never a promote). Explicitly handled so "didn't run" is not mistaken for OK.
    if (sawDryRun) {
      return {
        role: "verifier",
        outcome: "stub",
        summary: "dry-run: governed checks reported intent, executed nothing",
        detail: { verdict: "dry-run", checks, ...(integrityNote !== undefined ? { integrityNote } : {}) },
      };
    }

    const allPass = checks.every((c) => c.exitCode === 0);
    const failed = checks.filter((c) => c.exitCode !== 0).map((c) => c.name);
    return {
      role: "verifier",
      outcome: allPass ? "success" : "failure",
      summary: allPass ? "all checks passed" : `checks failed: ${failed.join(", ")}`,
      detail: { verdict: allPass ? "pass" : "fail", checks, ...(integrityNote !== undefined ? { integrityNote } : {}) },
    };
  };
}

/** The default verifier (live governed-exec; the orchestrator threads parentCtx + diff). */
export const verifier: RoleFn = createVerifier();

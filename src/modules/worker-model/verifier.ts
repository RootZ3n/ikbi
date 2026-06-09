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
 *    the judge then disqualifies it). The guard is MANDATORY: without a diff source to
 *    inspect, integrity cannot be proven, so verification fails closed (untrusted) — a
 *    missing diff capability is treated exactly like a diff read failure.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Read-only: the checks below (`tsc --noEmit`, `test`) do not mutate the workspace.
 * Commands run with `cwd: ctx.workspace.path`.
 */

import { join } from "node:path";

import type { OperationContext } from "../../core/identity/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import type { GovernedExec } from "../governed-exec/index.js";

// The check SET is the single shared definition (worker-model/checks.ts) — the SAME
// constant the builder's in-loop run_checks imports, so the builder previews the
// verifier's EXACT checks. Behavior here is unchanged; the constant just relocated.
import { type CheckResult, type ChecksResolution, mapExec, VERIFIER_CHECKS } from "./checks.js";
import type { RoleFn, RoleResult } from "./contract.js";
// LADDER MODE (opt-in, IKBI_VERIFY=ladder): package/impact-aware verification. These are
// library-only consumers — no side effects at import; the default (legacy) path never calls them.
import { projectIndex, type ProjectIndexData } from "../project-index/index.js";
import { verificationLadder, type VerificationPlan } from "../verification-ladder/index.js";
import { parseCheckOutput, type CheckTriage } from "../check-triage/index.js";
import { resolveVerificationMode, type VerificationMode } from "./modes.js";

/** Default per-check wall-clock budget (ms) for ladder verification — SEPARATE from the model
 *  role timeout, and larger than governed-exec's read-only-tool default so real suites don't get
 *  SIGKILL'd. Overridable via IKBI_CHECK_TIMEOUT_MS. */
export const DEFAULT_CHECK_TIMEOUT_MS = 600_000;

/** Upper clamp for IKBI_CHECK_TIMEOUT_MS — Node's setTimeout overflows past 2^31-1 ms (fires ~at
 *  once), which would SIGKILL every check instantly. Clamp to the max safe 32-bit delay. */
export const MAX_CHECK_TIMEOUT_MS = 2_147_483_647;

/** Extract changed file paths (repo-relative POSIX) from a unified `git diff`. */
export function parseChangedFiles(diff: string): string[] {
  const out = new Set<string>();
  for (const line of diff.split("\n")) {
    const g = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (g) {
      if (g[1] !== undefined && g[1] !== "/dev/null") out.add(g[1]);
      if (g[2] !== undefined && g[2] !== "/dev/null") out.add(g[2]);
      continue;
    }
    const p = /^\+\+\+ b\/(.+)$/.exec(line);
    if (p && p[1] !== undefined && p[1] !== "/dev/null") out.add(p[1]);
    const m = /^--- a\/(.+)$/.exec(line);
    if (m && m[1] !== undefined && m[1] !== "/dev/null") out.add(m[1]);
  }
  return [...out].sort();
}

/** Re-exported for consumers (and tests) that import it from the verifier. */
export type { CheckResult } from "./checks.js";

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
  // T1: also guard the other scripts an operator may trust as verification signals.
  "typecheck", "lint", "check", "validate", "ci", "e2e", "integration", "coverage",
];

/** Injectable dependencies. Defaults wire the live governed-exec singleton (lazily). */
export interface VerifierDeps {
  /** Governed executor — every check routes through it (gate-wall + allowlist + receipts). */
  readonly governedExec?: Pick<GovernedExec, "run">;
  /**
   * The run's validated OperationContext. governed-exec requires a minted
   * ValidatedIdentity (#10) + honors `dryRun`. Absent ⇒ the verifier fails closed.
   */
  readonly parentCtx?: OperationContext;
  /**
   * Workspace diff source (base..scratch) for the MANDATORY LAYER-2 script-integrity
   * guard. Optional in the type (injectable/omittable for tests), but a verifier built
   * WITHOUT it fails closed at run time (untrusted) — it cannot prove script integrity.
   */
  readonly diff?: (workspace: WorkspaceHandle) => Promise<string>;
  /**
   * Diff used by ladder impact planning. When omitted, ladder falls back to `diff`; production
   * wires this to the full verifier-time working-tree diff while keeping `diff` scoped to the
   * package.json script-integrity surface.
   */
  readonly planningDiff?: (workspace: WorkspaceHandle) => Promise<string>;
  /**
   * Resolve the per-target check set, with the fail-closed PROJECT-ROOT GUARD (Fix 1) and
   * the operator/repo-configured command set (Fix 2). The orchestrator wires the live
   * `resolveChecks` here. DEFAULT (tests / direct construction): the pnpm VERIFIER_CHECKS
   * with NO guard — so existing direct-construction callers are byte-unchanged.
   */
  readonly resolveChecks?: (worktreeReal: string) => ChecksResolution;
  /** Env source for IKBI_VERIFY / IKBI_CHECK_TIMEOUT_MS (tests inject). Default: process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Explicit verification mode, set by the PRODUCTION wiring (`createProductionWorker` →
   * orchestrator) so production defaults to the HARDENED ladder. When set it WINS over env;
   * when omitted, the mode is env-derived with legacy as the bare-construction default
   * (so direct `createVerifier()` callers / existing tests are byte-unchanged). An explicit
   * `IKBI_VERIFY=legacy` is honored by the production resolver BEFORE this is computed.
   */
  readonly mode?: VerificationMode;
  /** Project-index for ladder mode. Default: the live `projectIndex` (built/refreshed per run). */
  readonly index?: { refresh: (repo: string) => Promise<{ data: ProjectIndexData }> };
  /** Verification planner for ladder mode. Default: the live `verificationLadder`. */
  readonly plan?: (req: { data: ProjectIndexData; changedFiles: string[] }) => VerificationPlan;
  /** Check-output triage for ladder mode. Default: the live `parseCheckOutput`. */
  readonly triage?: typeof parseCheckOutput;
}

/** Lazy live governed-exec — importing it eagerly would force the gate-wall/egress wiring order. */
function lazyGovernedExec(): Pick<GovernedExec, "run"> {
  return { run: async (req) => (await import("../governed-exec/index.js")).governedExec.run(req) };
}

/** The UNTRUSTED verdict — a mutated/unprovable build fails verification, fail-closed. */
function untrusted(reason: string): RoleResult {
  return { role: "verifier", outcome: "failure", summary: reason, detail: { verdict: "untrusted", reason, checks: [] } };
}

/** A RED verdict — no valid project to check (wrong repo / no manifest). Fail-closed, never a vacuous pass. */
function red(reason: string): RoleResult {
  return { role: "verifier", outcome: "failure", summary: reason, detail: { verdict: "fail", reason, checks: [] } };
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

/** Build a verifier. Tests inject fakes; the default wires the live governed-exec. */
export function createVerifier(deps: VerifierDeps = {}): RoleFn {
  const governedExec = deps.governedExec ?? lazyGovernedExec();
  return async (ctx) => {
    // ── LAYER 2: SCRIPT-INTEGRITY GUARD (MANDATORY, before ANY check) ─────────
    // The guard is not optional: WITHOUT the ability to inspect the diff the verifier
    // cannot prove the builder didn't rewrite package.json's scripts, so it cannot
    // safely verify. A missing diff capability fails closed EXACTLY like a diff read
    // failure — both return untrusted before any governed-exec call. (A guard that
    // silently disappears when its input is absent is not a guard.)
    if (deps.diff === undefined) {
      return untrusted("verification untrusted: script-integrity guard unavailable — no workspace diff source wired");
    }
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

    // ── LAYER 1: GOVERNED CHECKS ──────────────────────────────────────────────
    // governed-exec needs a validated OperationContext (#10). Without it, fail closed.
    if (deps.parentCtx === undefined) {
      return untrusted("verifier not wired with an operation context — cannot run governed checks");
    }
    const parentCtx = deps.parentCtx;

    // ── LADDER MODE (opt-in: IKBI_VERIFY=ladder) ──────────────────────────────
    // Package/impact-aware verification. The script-integrity guard (above) has ALREADY run, so a
    // build that touched any package.json scripts is rejected before we read package scripts here.
    const env = deps.env ?? process.env;
    // Mode precedence: an explicit production `mode` wins; otherwise env-derived with legacy
    // as the bare-construction default (resolveVerificationMode(..., { production: false })).
    const verificationMode: VerificationMode = deps.mode ?? resolveVerificationMode(env, { production: false });
    if (verificationMode === "ladder") {
      return await runLadder(ctx, parentCtx, diffText, env);
    }

    // PROJECT-ROOT GUARD + per-target check set (Fix 1/2). Default (direct construction):
    // pnpm VERIFIER_CHECKS, no guard. The orchestrator wires the live resolver, which fails
    // closed RED when the worktree has no project of its own (so a no-manifest target can
    // NEVER pass vacuously by walking up into ikbi's workspace).
    const resolveChecks = deps.resolveChecks ?? ((): ChecksResolution => ({ ok: true, checks: VERIFIER_CHECKS, source: "default" }));
    const resolved = resolveChecks(ctx.workspace.path);
    if (!resolved.ok) return red(`verification RED: ${resolved.reason}`);
    const checkSet = resolved.checks;

    const checks: CheckResult[] = [];
    let sawDryRun = false;
    for (const c of checkSet) {
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
        detail: { verdict: "dry-run", verificationMode, checks },
      };
    }

    const allPass = checks.every((c) => c.exitCode === 0);
    const failed = checks.filter((c) => c.exitCode !== 0).map((c) => c.name);
    return {
      role: "verifier",
      outcome: allPass ? "success" : "failure",
      summary: allPass ? "all checks passed" : `checks failed: ${failed.join(", ")}`,
      detail: { verdict: allPass ? "pass" : "fail", verificationMode, checks },
    };

    // ── LADDER MODE implementation (hoisted; reached only when IKBI_VERIFY=ladder) ──────────
    async function runLadder(rctx: typeof ctx, pctx: OperationContext, diff: string, runEnv: NodeJS.ProcessEnv): Promise<RoleResult> {
      const worktree = rctx.workspace.path;
      const indexApi = deps.index ?? projectIndex;
      const planFn = deps.plan ?? ((r) => verificationLadder.planVerification(r));
      const triageFn = deps.triage ?? parseCheckOutput;
      const raw = (runEnv.IKBI_CHECK_TIMEOUT_MS ?? "").trim();
      const parsedTimeout = Number.parseInt(raw, 10);
      // Invalid / non-positive ⇒ default; valid ⇒ CLAMP to MAX_CHECK_TIMEOUT_MS (above which Node's
      // setTimeout overflows and fires ~immediately → every check SIGKILL'd → false RED).
      const checkTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? Math.min(parsedTimeout, MAX_CHECK_TIMEOUT_MS) : DEFAULT_CHECK_TIMEOUT_MS;

      let data: ProjectIndexData;
      try {
        data = (await indexApi.refresh(worktree)).data;
      } catch (e) {
        // Fail closed: without an index we cannot scope impact — RED, never a vacuous pass.
        return red(`verification RED (ladder): project-index unavailable — ${e instanceof Error ? e.message : String(e)}`);
      }

      let planningDiff = diff;
      if (deps.planningDiff !== undefined) {
        try {
          planningDiff = await deps.planningDiff(rctx.workspace);
        } catch (e) {
          return red(`verification RED (ladder): planning diff unavailable — ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const changedFiles = parseChangedFiles(planningDiff);
      const plan = planFn({ data, changedFiles });
      const baseReceipts = [...plan.receipts, `check timeout: ${checkTimeoutMs}ms (per check, separate from the model role budget)`];

      if (plan.blocked) {
        return {
          role: "verifier", outcome: "failure",
          summary: `verification BLOCKED (scope ${plan.scope}): ${plan.blockReasons.join("; ")}`,
          detail: { verdict: "fail", verificationScope: plan.scope, blocked: true, blockReasons: plan.blockReasons, checks: [], stagesRun: [], neutralPackages: plan.neutralPackages, receipts: baseReceipts },
        };
      }

      const checks: CheckResult[] = [];
      const triages: Array<{ stage: string; name: string; package: string; passed: boolean; failures: readonly string[]; errorSummary: string; detectedFrameworks: readonly string[] }> = [];
      const stagesRun: string[] = [];
      const neutralNote = plan.neutralPackages.length > 0 ? [`neutral packages (no runnable check — NOT counted green): ${plan.neutralPackages.join(", ")}`] : [];

      for (const stage of plan.stages) {
        stagesRun.push(stage.stage);
        for (const task of stage.tasks) {
          if (task.blocking || task.command === "") {
            // Defensive: a blocking marker must never be run or passed. (Blocked plans return above.)
            return {
              role: "verifier", outcome: "failure",
              summary: `verification BLOCKED (scope ${plan.scope}): ${task.reason}`,
              detail: { verdict: "fail", verificationScope: plan.scope, blocked: true, blockReasons: [task.reason], checks, stagesRun, neutralPackages: plan.neutralPackages, receipts: [...baseReceipts, `BLOCKED at ${stage.stage}: ${task.reason}`] },
            };
          }
          const cmdStr = `${task.command} ${task.args.join(" ")}`;
          const res = await governedExec.run({
            parentCtx: pctx,
            command: task.command,
            args: [...task.args],
            cwd: task.cwd === "" ? worktree : join(worktree, task.cwd),
            purpose: `verifier[ladder:${task.scope}] ${task.name} (${task.package || "(root)"})`,
            timeoutMs: checkTimeoutMs,
          });
          const { check, dryRun } = mapExec(task.name, cmdStr, res);
          checks.push(check);
          if (dryRun) {
            return {
              role: "verifier", outcome: "stub",
              summary: "dry-run: governed checks reported intent, executed nothing",
              detail: { verdict: "dry-run", verificationScope: plan.scope, checks, stagesRun, neutralPackages: plan.neutralPackages, receipts: baseReceipts },
            };
          }
          const tr: CheckTriage = triageFn({ name: task.name, command: cmdStr, exitCode: check.exitCode, stdout: res.stdoutTail ?? "", stderr: res.stderrTail ?? "" });
          triages.push({ stage: stage.stage, name: task.name, package: task.package, passed: tr.passed, failures: tr.failures, errorSummary: tr.errorSummary, detectedFrameworks: tr.detectedFrameworks });
          if (!tr.passed) {
            // FAIL FAST — stop before any later stage/task.
            return {
              role: "verifier", outcome: "failure",
              summary: `verification FAILED (scope ${plan.scope}) at ${stage.stage}/${task.name}: ${tr.errorSummary}`,
              detail: {
                verdict: "fail", verificationMode, verificationScope: plan.scope, checks, triage: triages, stagesRun,
                neutralPackages: plan.neutralPackages, failedAt: { stage: stage.stage, task: task.name },
                receipts: [...baseReceipts, `ran stages: ${stagesRun.join(" → ")}`, `FAILED at ${stage.stage}/${task.name}: ${tr.errorSummary}`, ...neutralNote, ...tr.failures.slice(0, 10)],
              },
            };
          }
        }
      }

      // DEFENSE-IN-DEPTH (no vacuous green): a non-blocked plan that executed ZERO checks must NOT
      // pass. The planner guarantees ≥1 runnable task for a non-blocked plan, but the verifier does
      // not trust that cross-module invariant — fail closed if nothing actually ran.
      if (checks.length === 0) {
        return {
          role: "verifier", outcome: "failure",
          summary: `verification FAILED (scope ${plan.scope}): no verification checks ran — refusing a vacuous green`,
          detail: {
            verdict: "fail", verificationScope: plan.scope, checks: [], triage: triages, stagesRun,
            neutralPackages: plan.neutralPackages,
            receipts: [...baseReceipts, "FAILED: no runnable verification checks executed (refusing a vacuous green)", ...neutralNote],
          },
        };
      }

      // ALL runnable tasks passed — SCOPE-STAMPED green (never a plain "all checks passed").
      return {
        role: "verifier", outcome: "success",
        summary: `verification PASSED for scope "${plan.scope}" — ran ${checks.length} check(s) across [${stagesRun.join(" → ")}]${plan.neutralPackages.length > 0 ? `; ${plan.neutralPackages.length} neutral package(s) recorded (not counted green)` : ""}`,
        detail: {
          verdict: "pass", verificationMode, verificationScope: plan.scope, checks, triage: triages, stagesRun,
          neutralPackages: plan.neutralPackages,
          receipts: [...baseReceipts, `ran stages: ${stagesRun.join(" → ")}`, ...neutralNote, `GREEN for scope: ${plan.scope}`],
        },
      };
    }
  };
}

/** The default verifier (live governed-exec; the orchestrator threads parentCtx + diff). */
export const verifier: RoleFn = createVerifier();

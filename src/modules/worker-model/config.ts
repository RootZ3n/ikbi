/**
 * ikbi worker-model substrate — its OWN config slice (per-module config seam).
 *
 * Read ONLY through `moduleEnv("worker-model")` — never `configEnv` directly
 * (module plan ## 8). The reader auto-prefixes `IKBI_WORKER_MODEL_`.
 *
 *   IKBI_WORKER_MODEL_ENABLED        on/off. DEFAULT OFF — the substrate is opt-in
 *                                    (a disabled run throws WorkerError "disabled",
 *                                    so it cannot silently no-op real work).
 *   IKBI_WORKER_MODEL_ROLE_TIMEOUT_MS  per-role wall-clock budget. Default DEFAULT_ROLE_TIMEOUT_MS.
 *   IKBI_WORKER_MODEL_MAX_CONCURRENT_RUNS  concurrent runs cap. Default DEFAULT_MAX_CONCURRENT_RUNS
 *                                    (concurrency the FEATURE is deferred — the core is built
 *                                    safe for it; default 1).
 *   IKBI_WORKER_MODEL_COMPETITIVE      competitive build mode on/off. DEFAULT OFF — when off,
 *                                    `run` is byte-identical to single-workspace behavior.
 *   IKBI_WORKER_MODEL_COMPETITIVE_N    candidate count when competitive. Default 2, bounded
 *                                    [MIN_COMPETITIVE_N, MAX_COMPETITIVE_N].
 *   IKBI_WORKER_MODEL_TRUST_LADDER   on/off. DEFAULT OFF — the earned-trust tier ladder
 *                                    (demotion + tier-gated autoCommit) is opt-in governance;
 *                                    off, build outcomes never move trust and verified-green work
 *                                    promotes regardless of tier. Safety controls (sandbox, gate-wall,
 *                                    neutralization) are unaffected. See `trustLadder` below.
 *   IKBI_WORKER_MODEL_RETAIN_FAILED_WORKSPACES  on/off. DEFAULT ON — when a build FAILS
 *                                    (timeout, tool rejection, non-converging loop), the
 *                                    workspace is RETAINED (worktree kept on disk) instead of
 *                                    discarded, so the operator can inspect what was built.
 *                                    `ikbi clean` reclaims retained workspaces. Set OFF to
 *                                    restore the old eager-discard behavior.
 */

import { configEnv } from "../../core/config.js";
import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("worker-model");

/** Valid builder lanes. "agent" = autonomous tool-caller; "patch" = the Patchsmith diff lane. */
export type BuilderMode = "agent" | "patch";
/** The default lane when neither the task nor IKBI_BUILDER_MODE selects one. */
export const DEFAULT_BUILDER_MODE: BuilderMode = "agent";

/**
 * Resolve the operator default builder lane from `IKBI_BUILDER_MODE`. Read at the bare
 * (un-prefixed) env name because the lane is an operator-facing switch, not a worker-model
 * sub-knob. Unknown/blank values fall back to the safe default ("agent") rather than throwing —
 * an unrecognised lane must never silently disable the autonomous builder.
 */
export function loadBuilderMode(env: NodeJS.ProcessEnv = configEnv): BuilderMode {
  const raw = (env.IKBI_BUILDER_MODE ?? "").trim().toLowerCase();
  return raw === "patch" ? "patch" : raw === "agent" ? "agent" : DEFAULT_BUILDER_MODE;
}

/**
 * Resolve the TOURNAMENT candidate model list from `IKBI_CANDIDATE_MODELS` (bare, comma-separated).
 * Read at the un-prefixed env name because, like IKBI_BUILDER_MODE / IKBI_COMPETITIVE_MODELS, it is
 * an operator-facing switch, not a worker-model sub-knob. A non-empty list ENABLES the candidate
 * tournament: each listed model races independently, ikbi verifies + scores all of them, and the
 * winner's diff is replayed into a clean shadow workspace (re-verified) before the existing promote
 * path. Empty/absent ⇒ no tournament (the single-workspace / competitive paths are byte-unchanged).
 * Capped at MAX_CANDIDATE_MODELS to bound cost + disk (one isolated worktree per candidate + shadow).
 */
export function loadCandidateModels(env: NodeJS.ProcessEnv = configEnv): readonly string[] {
  const raw = (env.IKBI_CANDIDATE_MODELS ?? "").trim();
  if (raw.length === 0) return [];
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return Object.freeze(list.slice(0, MAX_CANDIDATE_MODELS));
}

/** Default per-role wall-clock budget (ms) — a named constant, not a magic number. */
export const DEFAULT_ROLE_TIMEOUT_MS = 300_000; // 5 minutes
/**
 * Default WHOLE-PIPELINE wall-clock ceiling (ms). Per-role timeouts bound each role, but
 * a run does scout→builder→critic→verifier→integrator with retry/rescue and competitive/
 * tournament fan-out, each role re-armed with a fresh role budget — so without a total
 * ceiling a misbehaving run can consume many multiples of the role timeout. Checked at
 * every role boundary (the same checkpoints as the kill-switch). 0 disables.
 */
export const DEFAULT_TOTAL_BUDGET_MS = 1_800_000; // 30 minutes
/**
 * Wall-clock MULTIPLIER applied to a `--complexity large` build's BUILDER role (and, so the longer
 * builder actually fits, to the whole-pipeline budget). A large build — a greenfield scaffold or a
 * many-file feature — legitimately needs more wall-clock than a focused edit: the osapa whole-project
 * build wrote 34 files / 3025 lines and was still ~75% done when the base 5-minute role timeout fired,
 * discarding a nearly-complete tree. The bump applies ONLY to the builder role (the one doing the long
 * generative work) and ONLY when `complexity === "large"`; every other role and complexity is unchanged.
 * The base is a NAMED knob, not a heuristic — the operator still opts into "large" explicitly (the same
 * flag that bumps the builder to the mid tier), so this never silently lengthens an ordinary build.
 */
export const LARGE_COMPLEXITY_TIMEOUT_FACTOR = 3;

/**
 * The BUILDER role's effective wall-clock timeout (ms) for a task: the base `roleTimeoutMs`, scaled by
 * {@link LARGE_COMPLEXITY_TIMEOUT_FACTOR} when the task is `--complexity large`. A disabled guard
 * (base ≤ 0, meaning "no per-role timeout") stays disabled — scaling zero would be meaningless.
 */
export function resolveBuilderTimeoutMs(baseRoleTimeoutMs: number, complexity?: "small" | "medium" | "large"): number {
  if (!(baseRoleTimeoutMs > 0)) return baseRoleTimeoutMs;
  return complexity === "large" ? baseRoleTimeoutMs * LARGE_COMPLEXITY_TIMEOUT_FACTOR : baseRoleTimeoutMs;
}

/**
 * The WHOLE-PIPELINE wall-clock budget (ms) for a task: the base `totalBudgetMs`, scaled by
 * {@link LARGE_COMPLEXITY_TIMEOUT_FACTOR} when the task is `--complexity large` — so the scaled builder
 * role (plus the usual scout/critic/verifier/integrator and any retry) can run to completion inside it
 * rather than tripping the total ceiling. A disabled budget (base ≤ 0) stays disabled.
 */
export function resolveTotalBudgetMs(baseTotalBudgetMs: number, complexity?: "small" | "medium" | "large"): number {
  if (!(baseTotalBudgetMs > 0)) return baseTotalBudgetMs;
  return complexity === "large" ? baseTotalBudgetMs * LARGE_COMPLEXITY_TIMEOUT_FACTOR : baseTotalBudgetMs;
}
/** Default concurrent-run cap (concurrency feature deferred; safe default 1). */
export const DEFAULT_MAX_CONCURRENT_RUNS = 1;
/** Competitive candidate count: default + bounds (≥2 to be a competition; small cap on cost/disk). */
export const DEFAULT_COMPETITIVE_N = 2;
export const MIN_COMPETITIVE_N = 2;
export const MAX_COMPETITIVE_N = 4;
/** Tournament candidate cap — one isolated worktree per candidate (+ one shadow), so bound it. */
export const MAX_CANDIDATE_MODELS = 6;

export interface WorkerModelConfig {
  /** When false, `run` throws WorkerError("disabled") (opt-in substrate). */
  readonly enabled: boolean;
  /** Per-role wall-clock budget in ms. */
  readonly roleTimeoutMs: number;
  /**
   * Whole-pipeline wall-clock ceiling in ms (0 disables). Enforced at role boundaries.
   * Optional in the type so pre-existing config literals stay valid; the loader always sets it.
   */
  readonly totalBudgetMs?: number;
  /** Max concurrent runs (the orchestrator does not yet enforce; concurrency deferred). */
  readonly maxConcurrentRuns: number;
  /**
   * Competitive build mode. DEFAULT OFF. Optional in the type so pre-existing config
   * literals stay valid; the loader always sets it. When undefined/false the single-
   * workspace path runs (unchanged).
   */
  readonly competitive?: boolean;
  /** Candidate count when competitive (bounded [MIN,MAX]). */
  readonly competitiveN?: number;
  /**
   * Retain (don't discard) a workspace when the build FAILS, keeping its worktree on disk for
   * inspection. DEFAULT ON. Optional in the type so pre-existing config literals stay valid;
   * the loader always sets it.
   */
  readonly retainFailedWorkspaces?: boolean;
  /**
   * POLICY: count a role's PERFORMANCE failure (a wall-clock timeout or a non-converging
   * max-iterations stop) as a trust-penalizing signal. DEFAULT OFF — a slow/timed-out run is
   * not, by itself, evidence of unreliability, so it must not silently demote the worker (which
   * would disable autoCommit and block later GOOD builds). Real failures (failed verification,
   * bad output, safety/policy violations) ALWAYS count regardless of this flag. Set
   * IKBI_WORKER_MODEL_PENALIZE_TIMEOUTS=true to make timeouts trust-relevant by policy.
   */
  readonly penalizeTimeouts?: boolean;
  /**
   * TRUST LADDER for building. DEFAULT OFF. The earned-trust tier system (promotion/demotion +
   * tier-gated autoCommit) is GOVERNANCE, not a safety control — and for the local cheap-model build
   * workflow it mostly gets in the way: a single harness-caused rejection (an over-decomposition
   * artifact, a blocked no-effect probe classified as a policy violation) demotes the worker a full
   * tier, which then BLOCKS promotion of later verified-green work. With the ladder OFF (default):
   *   - build outcomes do NOT move the worker's trust tier (no demotion, no promotion-streak);
   *   - verified-green work promotes regardless of tier (autoCommit forced on, approval gate dropped).
   * What the toggle does NOT touch — these are SAFETY, always on: the OS/bubblewrap sandbox, the
   * governed-exec allowlist + gate-wall, worktree confinement, and untrusted-content NEUTRALIZATION
   * (injection defense). Set IKBI_WORKER_MODEL_TRUST_LADDER=true to restore the earned-trust ladder.
   */
  readonly trustLadder?: boolean;
  /**
   * Iterative fix loop: after the builder succeeds, run the verifier and feed
   * test failures back to the builder for automatic fixing. DEFAULT OFF (opt-in).
   * Set IKBI_WORKER_MODEL_FIX_LOOP=true to enable.
   */
  readonly fixLoop?: boolean;
  /**
   * DEDICATED FIXER model for the last mile. When a builder terminates on a PROTOCOL stop
   * (no_progress / max_iterations / timeout / stuck_detected) having written files, the auto-verify
   * rescue runs the real checks; if they are RED, a cheap builder often can't close the final errors
   * it left (it wrote the whole project then floundered re-reading). If a fixer model is set, ikbi runs
   * ONE bounded fix pass with THAT model on the same workspace — it runs run_checks, reads the errors,
   * and repairs them — then re-verifies. On GREEN the build is rescued; on RED the original failure
   * stands. This is the automatic form of the staged, verify-between-modules oversight a human used to
   * provide. A DIFFERENT model than the builder is the point (model-diversity as a harness advantage:
   * e.g. deepseek builds, mimo-v2.5-pro fixes). Empty/unset ⇒ no fixer pass (default). Set
   * IKBI_WORKER_MODEL_FIXER_MODEL=<model-id> to enable. Optional in the type so pre-existing config
   * literals stay valid; the loader always sets it.
   */
  readonly fixerModel?: string;
  /**
   * Critic-driven fix loop: when the CRITIC returns a subjective FAIL verdict (the build is
   * objectively green but semantically wrong / off-goal), feed the critic's feedback back to the
   * builder as a fix goal, re-verify, and re-critique ONCE. Distinct from the verifier-driven
   * `fixLoop` (which retries on red checks) — this catches what objective checks cannot. Capped
   * at a single retry (subjective feedback must not loop forever). DEFAULT ON: an off-goal-but-green
   * build is FIXABLE work that would otherwise be discarded, so one corrective pass earns it — the
   * "no-babysit" default. Contained by the budget guards (the wall-clock deadline gates whether it
   * fires; the per-call dollar budget hard-stops runaway spend). Set IKBI_WORKER_MODEL_CRITIC_FIX_LOOP=false to disable.
   */
  readonly criticFixLoop?: boolean;
  /**
   * Skip the critic on discard-bound builds: when the verifier is RED and no retry will happen
   * (the verifier-driven `fixLoop` is off), the build is already condemned — the integrator
   * discards on verifierPass=false regardless of the critic. Running the critic there only spends
   * model tokens on a goal-alignment verdict nobody acts on. With this ON, the critic is skipped
   * in exactly that case (red verifier + fixLoop off). When fixLoop IS active the critic still
   * runs — its feedback can inform the objective-driven retry. DEFAULT ON: a discard-bound critic
   * call on a red verifier is not paid for unless a retry will consume its feedback. Set
   * IKBI_WORKER_MODEL_SKIP_CRITIC_ON_RED=false to opt back into running the critic after a red
   * verifier.
   */
  readonly skipCriticOnRed?: boolean;
  /**
   * Enable the adversarial REFUTER gate (runs after the critic, before the integrator). It runs a
   * fixed refutation checklist that tries to PROVE the build is broken/lying; a single critical
   * finding refutes the build and the orchestrator files PROPOSED corrections from the findings.
   * DEFAULT OFF — adding the refuter to WORKER_ROLES must not change the default five-role pipeline.
   * Set IKBI_WORKER_MODEL_ENABLE_REFUTER=true to opt in. Optional in the type so pre-existing
   * config literals stay valid; the loader always sets it.
   */
  readonly enableRefuter?: boolean;
  /**
   * The DEFAULT builder lane (agent | patch) from IKBI_BUILDER_MODE. A task's own `builderMode`
   * overrides this. DEFAULT "agent" — the autonomous builder lane is unchanged unless opted out.
   * Optional in the type so pre-existing config literals stay valid; the loader always sets it.
   */
  readonly builderMode?: BuilderMode;
  /**
   * The TOURNAMENT candidate model list (IKBI_CANDIDATE_MODELS). A non-empty list enables the
   * candidate tournament path: N models race independently, ikbi verifies + scores all of them
   * deterministically, and the winner's diff is REPLAYED into a clean shadow workspace and
   * re-verified before the existing promote path runs. Empty/absent ⇒ no tournament (the
   * single-workspace / competitive paths are byte-unchanged). Optional in the type so pre-existing
   * config literals stay valid; the loader always sets it (to [] when unset).
   */
  readonly candidateModels?: readonly string[];
}

/** Load the worker-model config slice from `IKBI_WORKER_MODEL_*`. */
export function loadWorkerModelConfig(reader = env): WorkerModelConfig {
  const fixerModel = reader.str("FIXER_MODEL");
  return Object.freeze({
    enabled: reader.bool("ENABLED", false),
    roleTimeoutMs: reader.int("ROLE_TIMEOUT_MS", DEFAULT_ROLE_TIMEOUT_MS, { min: 1 }),
    totalBudgetMs: reader.int("TOTAL_BUDGET_MS", DEFAULT_TOTAL_BUDGET_MS, { min: 0 }),
    maxConcurrentRuns: reader.int("MAX_CONCURRENT_RUNS", DEFAULT_MAX_CONCURRENT_RUNS, { min: 1 }),
    competitive: reader.bool("COMPETITIVE", false),
    competitiveN: reader.int("COMPETITIVE_N", DEFAULT_COMPETITIVE_N, { min: MIN_COMPETITIVE_N, max: MAX_COMPETITIVE_N }),
    retainFailedWorkspaces: reader.bool("RETAIN_FAILED_WORKSPACES", true),
    penalizeTimeouts: reader.bool("PENALIZE_TIMEOUTS", false),
    trustLadder: reader.bool("TRUST_LADDER", false),
    fixLoop: reader.bool("FIX_LOOP", false),
    ...(fixerModel !== undefined ? { fixerModel } : {}),
    criticFixLoop: reader.bool("CRITIC_FIX_LOOP", true),
    skipCriticOnRed: reader.bool("SKIP_CRITIC_ON_RED", true),
    enableRefuter: reader.bool("ENABLE_REFUTER", false),
    builderMode: loadBuilderMode(),
    candidateModels: loadCandidateModels(),
  });
}

/** The process-wide worker-model config. */
export const workerModelConfig: WorkerModelConfig = loadWorkerModelConfig();

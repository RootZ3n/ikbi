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
   * Iterative fix loop: after the builder succeeds, run the verifier and feed
   * test failures back to the builder for automatic fixing. DEFAULT OFF (opt-in).
   * Set IKBI_WORKER_MODEL_FIX_LOOP=true to enable.
   */
  readonly fixLoop?: boolean;
  /**
   * Critic-driven fix loop: when the CRITIC returns a subjective FAIL verdict (the build is
   * objectively green but semantically wrong / off-goal), feed the critic's feedback back to the
   * builder as a fix goal, re-verify, and re-critique ONCE. Distinct from the verifier-driven
   * `fixLoop` (which retries on red checks) — this catches what objective checks cannot. Capped
   * at a single retry (subjective feedback must not loop forever). DEFAULT OFF (opt-in). Set
   * IKBI_WORKER_MODEL_CRITIC_FIX_LOOP=true to enable.
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
  return Object.freeze({
    enabled: reader.bool("ENABLED", false),
    roleTimeoutMs: reader.int("ROLE_TIMEOUT_MS", DEFAULT_ROLE_TIMEOUT_MS, { min: 1 }),
    maxConcurrentRuns: reader.int("MAX_CONCURRENT_RUNS", DEFAULT_MAX_CONCURRENT_RUNS, { min: 1 }),
    competitive: reader.bool("COMPETITIVE", false),
    competitiveN: reader.int("COMPETITIVE_N", DEFAULT_COMPETITIVE_N, { min: MIN_COMPETITIVE_N, max: MAX_COMPETITIVE_N }),
    retainFailedWorkspaces: reader.bool("RETAIN_FAILED_WORKSPACES", true),
    penalizeTimeouts: reader.bool("PENALIZE_TIMEOUTS", false),
    fixLoop: reader.bool("FIX_LOOP", false),
    criticFixLoop: reader.bool("CRITIC_FIX_LOOP", false),
    skipCriticOnRed: reader.bool("SKIP_CRITIC_ON_RED", true),
    builderMode: loadBuilderMode(),
    candidateModels: loadCandidateModels(),
  });
}

/** The process-wide worker-model config. */
export const workerModelConfig: WorkerModelConfig = loadWorkerModelConfig();

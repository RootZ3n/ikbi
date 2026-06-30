/**
 * ikbi escalation — config slice (`moduleEnv("escalation")`, prefix `IKBI_ESCALATION_`).
 *
 *   IKBI_ESCALATION_ENABLED                      orchestrator hook on/off. Default true.
 *   IKBI_ESCALATION_WORKER_TO_MID_THRESHOLD      worker→mid score gate (0-100). Default 50.
 *   IKBI_ESCALATION_MID_TO_FRONTIER_THRESHOLD    mid→frontier score gate (0-100). Default 70.
 *   IKBI_ESCALATION_MAX_ESCALATIONS              per-task transition cap. Default 2.
 *
 *   Per-signal weights (each IKBI_ESCALATION_WEIGHT_*):
 *     SCHEMA_FAILURES 15 · RETRY_COUNT 10 · SCOUT_SCORE 10 · CONTEXT_PRESSURE 5
 *     CRITIC_REJECTED 20 · VERIFICATION_FAILED 25 · REJECTED_TOOL_CALLS 10 · BENCHMARK_PASS_RATE 5
 *
 *   Tier rosters (comma-separated; price-bracketed, attempted cost-ascending within a tier):
 *     IKBI_ESCALATION_WORKER_MODELS    Default deepseek-v4-flash,mimo-v2.5
 *     IKBI_ESCALATION_MID_MODELS       Default mimo-v2.5-pro,deepseek-v4-pro,minimax-m3,glm-5.2
 *     IKBI_ESCALATION_FRONTIER_MODELS  Default sonnet-4.6,opus-4.8,gpt-5.5
 */

import { moduleEnv } from "../../core/module-config.js";
import type { EscalationConfig, EscalationWeights } from "./contract.js";

const env = moduleEnv("escalation");

export const DEFAULT_WORKER_TO_MID_THRESHOLD = 50;
export const DEFAULT_MID_TO_FRONTIER_THRESHOLD = 70;
export const DEFAULT_MAX_ESCALATIONS = 2;

export const DEFAULT_WEIGHTS: EscalationWeights = Object.freeze({
  schemaFailures: 15,
  retryCount: 10,
  scoutScore: 10,
  contextPressure: 5,
  criticRejected: 20,
  verificationFailed: 25,
  rejectedToolCalls: 10,
  benchmarkPassRate: 5,
  builderFailed: 50,
});

// Tiers are bracketed by PRICE (the cheapest-that-can-do-the-job principle); within a tier the
// cascade attempts models cost-ascending, with reasoning-quality (Luak) as the tie-break, and
// only escalates to a higher tier once the current one is exhausted. Roster order below IS the
// attempt order until live cost data is wired (then cost-asc governs).
//   worker   — the truly-cheap pre-pass (~$0.42 blended): flash, then mimo-v2.5.
//   mid      — the bang-for-buck cluster, tried before any frontier spend: the pro pair first
//              (mimo-v2.5-pro ahead of deepseek-v4-pro — both $0.435/$0.87, Luak ranks Mimo
//              ~21% higher), then minimax-m3 (effective ~$1.50), then glm-5.2 (~$5.80). mid[0]
//              is also the single-swap build-mode escalation target, so it must be a pro.
//   frontier — break-glass gated, cost-ascending: sonnet-4.6 → opus-4.8 → gpt-5.5.
export const DEFAULT_WORKER_MODELS = ["deepseek-v4-flash", "mimo-v2.5"] as const;
export const DEFAULT_MID_MODELS = ["mimo-v2.5-pro", "deepseek-v4-pro", "minimax-m3", "glm-5.2"] as const;
export const DEFAULT_FRONTIER_MODELS = ["sonnet-4.6", "opus-4.8", "gpt-5.5"] as const;

export function loadEscalationConfig(reader = env): EscalationConfig {
  const weights: EscalationWeights = Object.freeze({
    schemaFailures: reader.number("WEIGHT_SCHEMA_FAILURES", DEFAULT_WEIGHTS.schemaFailures, { min: 0 }),
    retryCount: reader.number("WEIGHT_RETRY_COUNT", DEFAULT_WEIGHTS.retryCount, { min: 0 }),
    scoutScore: reader.number("WEIGHT_SCOUT_SCORE", DEFAULT_WEIGHTS.scoutScore, { min: 0 }),
    contextPressure: reader.number("WEIGHT_CONTEXT_PRESSURE", DEFAULT_WEIGHTS.contextPressure, { min: 0 }),
    criticRejected: reader.number("WEIGHT_CRITIC_REJECTED", DEFAULT_WEIGHTS.criticRejected, { min: 0 }),
    verificationFailed: reader.number("WEIGHT_VERIFICATION_FAILED", DEFAULT_WEIGHTS.verificationFailed, { min: 0 }),
    rejectedToolCalls: reader.number("WEIGHT_REJECTED_TOOL_CALLS", DEFAULT_WEIGHTS.rejectedToolCalls, { min: 0 }),
    benchmarkPassRate: reader.number("WEIGHT_BENCHMARK_PASS_RATE", DEFAULT_WEIGHTS.benchmarkPassRate, { min: 0 }),
    builderFailed: reader.number("WEIGHT_BUILDER_FAILED", DEFAULT_WEIGHTS.builderFailed, { min: 0 }),
  });

  const tierModels = Object.freeze({
    worker: Object.freeze(reader.list("WORKER_MODELS", DEFAULT_WORKER_MODELS)),
    mid: Object.freeze(reader.list("MID_MODELS", DEFAULT_MID_MODELS)),
    frontier: Object.freeze(reader.list("FRONTIER_MODELS", DEFAULT_FRONTIER_MODELS)),
  });

  return Object.freeze({
    enabled: reader.bool("ENABLED", true),
    workerToMidThreshold: reader.number("WORKER_TO_MID_THRESHOLD", DEFAULT_WORKER_TO_MID_THRESHOLD, { min: 0, max: 100 }),
    midToFrontierThreshold: reader.number("MID_TO_FRONTIER_THRESHOLD", DEFAULT_MID_TO_FRONTIER_THRESHOLD, { min: 0, max: 100 }),
    maxEscalations: reader.int("MAX_ESCALATIONS", DEFAULT_MAX_ESCALATIONS, { min: 0 }),
    weights,
    tierModels,
  });
}

export const escalationConfig: EscalationConfig = loadEscalationConfig();

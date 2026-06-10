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
 *   Tier rosters (comma-separated; the retry picks the FIRST entry):
 *     IKBI_ESCALATION_WORKER_MODELS    Default deepseek-v4-flash,mimo-v2.5,minimax-m3
 *     IKBI_ESCALATION_MID_MODELS       Default deepseek-v4-pro,mimo-v2.5-pro
 *     IKBI_ESCALATION_FRONTIER_MODELS  Default gpt-5.5,opus-4.8
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
});

export const DEFAULT_WORKER_MODELS = ["deepseek-v4-flash", "mimo-v2.5", "minimax-m3"] as const;
export const DEFAULT_MID_MODELS = ["deepseek-v4-pro", "mimo-v2.5-pro"] as const;
export const DEFAULT_FRONTIER_MODELS = ["gpt-5.5", "opus-4.8"] as const;

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

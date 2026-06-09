/**
 * ikbi check-triage — config slice (`moduleEnv("check-triage")`, prefix `IKBI_CHECK_TRIAGE_`).
 *
 *   IKBI_CHECK_TRIAGE_MAX_HEAD_BYTES   head capture cap. Default 4000.
 *   IKBI_CHECK_TRIAGE_MAX_TAIL_BYTES   tail capture cap. Default 4000.
 *   IKBI_CHECK_TRIAGE_MAX_FAILURES     max failing identifiers retained. Default 50.
 *   IKBI_CHECK_TRIAGE_MAX_FAILURE_LEN  per-failure length cap. Default 200.
 */

import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("check-triage");

export const DEFAULT_MAX_HEAD_BYTES = 4_000;
export const DEFAULT_MAX_TAIL_BYTES = 4_000;
export const DEFAULT_MAX_FAILURES = 50;
export const DEFAULT_MAX_FAILURE_LEN = 200;

export interface CheckTriageConfig {
  readonly maxHeadBytes: number;
  readonly maxTailBytes: number;
  readonly maxFailures: number;
  readonly maxFailureLen: number;
}

export function loadCheckTriageConfig(reader = env): CheckTriageConfig {
  return Object.freeze({
    maxHeadBytes: reader.int("MAX_HEAD_BYTES", DEFAULT_MAX_HEAD_BYTES, { min: 1 }),
    maxTailBytes: reader.int("MAX_TAIL_BYTES", DEFAULT_MAX_TAIL_BYTES, { min: 1 }),
    maxFailures: reader.int("MAX_FAILURES", DEFAULT_MAX_FAILURES, { min: 1 }),
    maxFailureLen: reader.int("MAX_FAILURE_LEN", DEFAULT_MAX_FAILURE_LEN, { min: 1 }),
  });
}

export const checkTriageConfig: CheckTriageConfig = loadCheckTriageConfig();

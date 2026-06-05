/**
 * ikbi drift-prevention — its events (namespaced `drift.*` per module plan ## 8).
 *
 * Published with `source: "drift-prevention"`. Payloads carry rates / counts / agent /
 * operation — NEVER raw receipt content, build output, or secrets.
 */

import { defineEvent } from "../../core/events/index.js";
import type { DriftSeverity } from "./contract.js";

/** A drift check ran for an agent (how many operations were evaluated). */
export const driftChecked = defineEvent<{ agent: string; operationCount: number }>("drift.checked");

/** A degradation was detected (rates + drop only — no raw outcomes). */
export const driftDetected = defineEvent<{
  agent: string;
  operation: string;
  project?: string;
  baselineRate: number;
  recentRate: number;
  drop: number;
  sampleSize: number;
  severity: DriftSeverity;
}>("drift.detected");

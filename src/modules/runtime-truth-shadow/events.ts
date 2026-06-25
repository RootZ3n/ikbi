/**
 * ikbi runtime-truth-shadow - its event (namespaced `cognition.*`).
 *
 * Emitted once per shadow run alongside a cognition decision, for offline comparison. Carries only
 * STRUCTURED LABELS (verdict / scores / counts / decision label) - never the goal, rationale text,
 * or memory contents, matching the cognition-layer event convention.
 */

import { defineEvent } from "../../core/events/index.js";

export const runtimeTruthShadowObserved = defineEvent<{
  agentId: string;
  project?: string;
  /** Truth Firewall consistency verdict for the referenced memory. */
  consistencyVerdict: string;
  summaryConfidence: number;
  riskCount: number;
  driftScore: number;
  driftSeverity: string;
  overallTrust: number;
  /** The cognition decision this shadow ran alongside (for comparison). */
  cognitionDecision: string;
  cognitionConfidence: number;
  /** Always true - never an executable recommendation. */
  advisoryOnly: true;
}>("cognition.runtime_truth_shadow");

/**
 * ikbi runtime-truth-shadow - THE MODULE CONTRACT (versioned).
 *
 * A SHADOW-ONLY bridge that lets ikbi's cognition layer consume a Truth Firewall
 * RuntimeTruthReader's advisory output as READ-ONLY context. It is strictly observational:
 *   - it NEVER changes a cognition decision (shadow output is logged/receipted for comparison only);
 *   - it NEVER writes memory, approves/installs, enforces, or executes anything;
 *   - it depends on Truth Firewall through a LOCAL PORT only - it imports NO Truth Firewall code.
 *
 * The port (`RuntimeTruthReaderPort`) is structurally compatible with Truth Firewall's
 * `RuntimeTruthReader.summarizeForCognition`, so the operator can inject the real reader at the edge
 * without ikbi taking a cross-repo dependency (ikbi stays standalone).
 *
 * CONTRACT_VERSION changelog (newest on top):
 *   1.0.0 - initial shadow bridge: RuntimeTruthReaderPort + RuntimeTruthSummary + shadow record;
 *           advisory-only, non-executing, logged via a cognition.* event.
 */

/** Semantic version of the runtime-truth-shadow contract. Bump on breaking change. */
export const CONTRACT_VERSION = "1.0.0";

/** off = disabled (default). shadow = compute + log alongside cognition, never change the decision. */
export type RuntimeTruthMode = "off" | "shadow";

/**
 * The advisory summary a RuntimeTruthReader produces. Structurally matches Truth Firewall's
 * `CognitionSummary`. Inputs ONLY for a CognitionDecision - never executable actions.
 */
export interface RuntimeTruthSummary {
  readonly rationale: string;
  readonly confidence: number;
  readonly risks: readonly string[];
  readonly missingInfo: readonly string[];
  readonly memoryUsed: readonly string[];
  readonly evidenceNotes: readonly string[];
  readonly consistency: { readonly verdict: string; readonly confidence: number };
  readonly health: {
    readonly memoryCount: number;
    readonly overallTrust: number;
    readonly evidenceCoverage: number;
    readonly driftScore: number;
    readonly driftSeverity: string;
  };
  /** Hard marker: the layer emits advisory inputs only. The shadow runner REJECTS anything else. */
  readonly advisoryOnly: true;
}

/** The injected reader port. The real implementation is Truth Firewall's RuntimeTruthReader. */
export interface RuntimeTruthReaderPort {
  summarizeForCognition(task: string, recentRefs: readonly string[]): RuntimeTruthSummary | Promise<RuntimeTruthSummary>;
}

/** The cognition decision facts the shadow compares against (labels only - no goal/rationale text). */
export interface ShadowDecisionRef {
  readonly decision: string;
  readonly confidence: number;
  readonly recommendedModule: string | null;
}

/** What the shadow run produced (returned for receipts/tests; cognition ignores it). */
export interface RuntimeTruthShadowRecord {
  readonly mode: RuntimeTruthMode;
  readonly agentId: string;
  readonly project?: string;
  readonly consistencyVerdict: string;
  readonly summaryConfidence: number;
  readonly riskCount: number;
  readonly driftScore: number;
  readonly driftSeverity: string;
  readonly overallTrust: number;
  readonly cognitionDecision: string;
  readonly cognitionConfidence: number;
  /** Always true - the shadow never carries or recommends an executable action. */
  readonly advisoryOnly: true;
  /** The advisory warnings surfaced (risks + evidence notes), for the comparison log. */
  readonly warnings: readonly string[];
}

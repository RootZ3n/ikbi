/**
 * ikbi runtime-truth-shadow - the shadow runner.
 *
 * `runRuntimeTruthShadow` computes a Truth Firewall RuntimeTruthReader summary ALONGSIDE a cognition
 * decision and emits a `cognition.runtime_truth_shadow` event for comparison. It is a no-op unless
 * mode is `shadow` AND a reader is injected. It NEVER returns anything that changes the decision,
 * NEVER writes memory, NEVER approves/installs/enforces/executes, and FAILS CLOSED:
 *   - a reader error is swallowed (shadow must never break deliberation);
 *   - a summary that is not strictly `advisoryOnly === true` is REJECTED (dropped, not logged as a
 *     verdict) so a non-advisory payload can never leak into ikbi.
 */

import type { EventInput } from "../../core/events/index.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import { runtimeTruthShadowObserved } from "./events.js";
import type {
  RuntimeTruthMode,
  RuntimeTruthReaderPort,
  RuntimeTruthShadowRecord,
  ShadowDecisionRef,
} from "./contract.js";

const EVENT_SOURCE = "runtime-truth-shadow";
const SHADOW_OPERATION = "cognition.runtime_truth_shadow";

export interface ShadowRunArgs {
  readonly mode: RuntimeTruthMode;
  /** Injected Truth Firewall reader (absent ⇒ no-op). */
  readonly reader?: RuntimeTruthReaderPort;
  /** The current task/goal text (used only to build the reader's advisory rationale). */
  readonly task: string;
  /** Memory ids the cognition used / referenced. */
  readonly recentRefs: readonly string[];
  readonly decision: ShadowDecisionRef;
  readonly agentId: string;
  readonly project?: string;
  readonly identity: AgentIdentity;
  readonly publish: (input: EventInput<unknown>) => void;
}

/**
 * Run the shadow comparison. Returns the recorded shadow facts, or `null` when disabled, when no
 * reader is injected, when the reader throws, or when the summary is not strictly advisory-only.
 */
export async function runRuntimeTruthShadow(args: ShadowRunArgs): Promise<RuntimeTruthShadowRecord | null> {
  if (args.mode !== "shadow" || args.reader === undefined) return null;

  let summary;
  try {
    summary = await Promise.resolve(args.reader.summarizeForCognition(args.task, args.recentRefs));
  } catch {
    return null; // a reader failure must never break deliberation
  }

  // FAIL CLOSED: only a strictly advisory-only summary is accepted. Anything else is dropped.
  if (summary === null || typeof summary !== "object" || (summary as { advisoryOnly?: unknown }).advisoryOnly !== true) {
    return null;
  }

  const warnings: string[] = [...(summary.risks ?? []), ...(summary.evidenceNotes ?? [])];
  const record: RuntimeTruthShadowRecord = {
    mode: args.mode,
    agentId: args.agentId,
    ...(args.project !== undefined ? { project: args.project } : {}),
    consistencyVerdict: summary.consistency.verdict,
    summaryConfidence: summary.confidence,
    riskCount: summary.risks.length,
    driftScore: summary.health.driftScore,
    driftSeverity: summary.health.driftSeverity,
    overallTrust: summary.health.overallTrust,
    cognitionDecision: args.decision.decision,
    cognitionConfidence: args.decision.confidence,
    advisoryOnly: true,
    warnings,
  };

  args.publish(
    runtimeTruthShadowObserved.create(
      {
        agentId: record.agentId,
        ...(record.project !== undefined ? { project: record.project } : {}),
        consistencyVerdict: record.consistencyVerdict,
        summaryConfidence: record.summaryConfidence,
        riskCount: record.riskCount,
        driftScore: record.driftScore,
        driftSeverity: record.driftSeverity,
        overallTrust: record.overallTrust,
        cognitionDecision: record.cognitionDecision,
        cognitionConfidence: record.cognitionConfidence,
        advisoryOnly: true,
      },
      { source: EVENT_SOURCE, attribution: { identity: args.identity, operation: SHADOW_OPERATION } },
    ),
  );

  return record;
}

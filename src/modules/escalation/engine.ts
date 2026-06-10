/**
 * ikbi escalation — THE ENGINE.
 *
 * The entry point the orchestrator calls after a role attempt. It is the only
 * STATEFUL piece (it tracks the per-task escalation count that bounds the cap);
 * everything decision-shaped is delegated to the pure scorer + policy, so a given
 * `(context, history)` always yields the same `EscalationDecision`.
 *
 *   evaluate          score the attempt → tier-aware decision (+ handoff if escalating)
 *   recordEscalation  note a transition actually happened (feeds the cap)
 *   getHistory        the transitions taken for a task
 *   forget            drop a task's history when its run terminates (bounds memory)
 *
 * `evaluate` NEVER mutates history — it is safe to call repeatedly. The orchestrator
 * calls `recordEscalation` only once a transition is actually enacted (after human
 * approval, for a frontier target).
 */

import { CONTRACT_VERSION } from "./contract.js";
import type {
  EscalationConfig,
  EscalationContext,
  EscalationDecision,
  EscalationEngine,
  EscalationRecord,
  ModelTier,
} from "./contract.js";
import { escalationConfig } from "./config.js";
import { computeScore } from "./scorer.js";
import { decideEscalation } from "./policy.js";
import { buildHandoff } from "./handoff.js";

/** Build an escalation engine bound to `config` (defaults to the loaded module config). */
export function createEscalationEngine(config: EscalationConfig = escalationConfig): EscalationEngine {
  const history = new Map<string, EscalationRecord[]>();

  function rawHistory(taskId: string): EscalationRecord[] {
    return history.get(taskId) ?? [];
  }

  function getHistory(taskId: string): readonly EscalationRecord[] {
    return Object.freeze([...rawHistory(taskId)]);
  }

  function recordEscalation(taskId: string, from: ModelTier, to: ModelTier): void {
    const list = rawHistory(taskId);
    list.push(Object.freeze({ taskId, from, to, requiresApproval: to === "frontier" }));
    history.set(taskId, list);
  }

  function forget(taskId: string): void {
    history.delete(taskId);
  }

  function evaluate(context: EscalationContext): EscalationDecision {
    const raw = computeScore(context.signals, config.weights);
    const count = rawHistory(context.taskId).length;
    const outcome = decideEscalation(raw, context.currentTier, config, count);

    if (!outcome.escalate || outcome.targetTier === undefined) {
      return Object.freeze({
        contractVersion: CONTRACT_VERSION,
        escalate: false,
        currentTier: context.currentTier,
        score: outcome.score,
        requiresApproval: false,
        ...(outcome.declineReason !== undefined ? { declineReason: outcome.declineReason } : {}),
      });
    }

    const target = outcome.targetTier;
    const handoffContext = buildHandoff(context, outcome.score, target, getHistory(context.taskId));

    return Object.freeze({
      contractVersion: CONTRACT_VERSION,
      escalate: true,
      currentTier: context.currentTier,
      targetTier: target,
      score: outcome.score,
      requiresApproval: outcome.requiresApproval,
      ...(outcome.targetModel !== undefined ? { targetModel: outcome.targetModel } : {}),
      handoffContext,
    });
  }

  return Object.freeze({ evaluate, recordEscalation, getHistory, forget });
}

/** The process-wide escalation engine (history is per-task, keyed by taskId). */
export const escalationEngine: EscalationEngine = createEscalationEngine();

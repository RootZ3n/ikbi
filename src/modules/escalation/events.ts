/**
 * ikbi escalation — its events (namespaced `escalation.*`).
 *
 * Published on the process-wide bus with `source: "escalation"`. Transient live
 * signals for the operator stream / monitoring; the durable record of WHY a tier
 * changed is the handoff's `escalationReason` + receipts, not the bus.
 */

import { defineEvent } from "../../core/events/index.js";
import type { ModelTier } from "./contract.js";

/** Source tag carried on every escalation event. */
export const EVENT_SOURCE = "escalation" as const;

/** A role attempt was scored (whether or not it escalated). Carries the score + decision. */
export const escalationEvaluated = defineEvent<{
  taskId: string;
  currentTier: ModelTier;
  total: number;
  shouldEscalate: boolean;
  escalate: boolean;
}>("escalation.evaluated");

/** Escalation FIRED — a tier transition is recommended. (worker→mid auto; mid→frontier needs approval.) */
export const escalationTriggered = defineEvent<{
  taskId: string;
  from: ModelTier;
  to: ModelTier;
  total: number;
  requiresApproval: boolean;
  targetModel?: string;
}>("escalation.triggered");

/** Escalation was declined despite a crossing/eligibility (cap hit / already at frontier). */
export const escalationDeclined = defineEvent<{
  taskId: string;
  currentTier: ModelTier;
  total: number;
  reason: string;
}>("escalation.declined");

/** Break-glass: a frontier transition is PAUSED awaiting human approval. */
export const escalationApprovalRequested = defineEvent<{ taskId: string; targetTier: ModelTier; total: number }>(
  "escalation.approval.requested",
);

/** Break-glass: the human's decision resolved. */
export const escalationApprovalResolved = defineEvent<{ taskId: string; targetTier: ModelTier; approved: boolean }>(
  "escalation.approval.resolved",
);

/**
 * ikbi gate-wall — its events (namespaced `gate.*` per module plan ## 8).
 *
 * Published with `source: "gate-wall"` and identity attribution so every
 * governance decision is observable live. Receipts are the durable record.
 */

import { defineEvent } from "../../core/events/index.js";

/** Payload common to the gate lifecycle events. */
export interface GateEventPayload {
  /** The trust tier evaluated. */
  readonly tier: string;
  /** The verdict. */
  readonly allow: boolean;
  /** Human/audit reason for the verdict. */
  readonly reason: string;
  /** Audit-correlation id for this evaluation. */
  readonly gateId: string;
}

/** Emitted for every evaluation (allow or deny). */
export const gateEvaluated = defineEvent<GateEventPayload>("gate.evaluated");
/** Emitted when the gate allows the promote. */
export const gateAllowed = defineEvent<GateEventPayload>("gate.allowed");
/** Emitted when the gate denies the promote (fail-closed). */
export const gateDenied = defineEvent<GateEventPayload>("gate.denied");

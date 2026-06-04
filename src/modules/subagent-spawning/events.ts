/**
 * ikbi subagent-spawning — its events (namespaced `subagent.*` per module plan ## 8).
 *
 * Published with `source: "subagent-spawning"` and identity attribution so every
 * spawn decision — the request, a clamp-down, a fail-closed deny, the completion —
 * is observable live. Receipts (written by the orchestrator + gate-wall under the
 * spawned identities) are the durable record.
 */

import { defineEvent } from "../../core/events/index.js";
import type { TrustTier } from "../../core/identity/index.js";

/** Payload common to the spawn lifecycle events (fields populated as known). */
export interface SpawnEventPayload {
  /** The agent id the event is about (parent for request/clamp/deny, child for completed). */
  readonly agentId?: string;
  /** The spawning parent's tier (the ceiling). */
  readonly parentTier?: TrustTier;
  /** The child's effective / permitted tier. */
  readonly childTier?: TrustTier;
  /** The tier the subagent requested. */
  readonly requestedTier?: TrustTier;
  /** The parent the child was spawned under (child events). */
  readonly spawnedFrom?: string;
  /** Whether the spawned run promoted (completed events). */
  readonly promoted?: boolean;
  /** The worker run outcome (completed events). */
  readonly outcome?: string;
  /** Human/audit reason (deny events). */
  readonly reason?: string;
}

/** Emitted when a spawn is requested (before the child is resolved/run). */
export const spawnRequested = defineEvent<SpawnEventPayload>("subagent.spawn.requested");
/** Emitted when the requested tier is clamped DOWN to the parent ceiling (#10). */
export const spawnClamped = defineEvent<SpawnEventPayload>("subagent.spawn.clamped");
/** Emitted when a spawn is refused fail-closed (disabled / non-validated parent). */
export const spawnDenied = defineEvent<SpawnEventPayload>("subagent.spawn.denied");
/** Emitted when a spawned worker run completes. */
export const spawnCompleted = defineEvent<SpawnEventPayload>("subagent.spawn.completed");

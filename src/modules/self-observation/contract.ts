/**
 * ikbi self-observation — THE MODULE CONTRACT (versioned).
 *
 * A PASSIVE, read-only engine observer. It subscribes to the event bus and reads the
 * receipt log to produce a status/health snapshot — it NEVER intercepts, wraps, or
 * executes anything, and imports NO action module. That passivity is the 2-eyes
 * guarantee: there is no action surface, hence no gate-wall.
 *
 * Engine-generic: nothing here names a specific agent or project.
 *
 * NO-LEAK: the observer records event METADATA only (type, source, seq, timestamp,
 * attribution agentId) — NEVER event payloads (which may carry arg summaries, reasons,
 * etc.). Receipts are read only for counts/status — never their metadata/requestSummary
 * contents. A secret in a payload or receipt field can never reach a snapshot.
 *
 * No frozen-core change.
 *
 * CONTRACT_VERSION changelog (newest on top):
 *   1.0.0 — initial self-observation contract: ObservationSnapshot + ObservedEvent,
 *           a passive observer over events + receipts with bounded recent-events,
 *           receipt summary, and subscription health. Snapshots persist under the
 *           state root. Status route mounted in the deferred barrel-wiring pass.
 */

/** Semantic version of the self-observation contract. Bump on breaking change. */
export const CONTRACT_VERSION = "1.0.0";

/** A redacted record of one observed event — METADATA ONLY, never the payload. */
export interface ObservedEvent {
  readonly seq: number;
  readonly type: string;
  readonly source?: string;
  readonly timestamp: number;
  /** Attribution agent id, when the event carried one. */
  readonly agentId?: string;
}

/** Subscription health counters (from `Subscription.stats()`). */
export interface SubscriptionHealth {
  readonly delivered: number;
  readonly dropped: number;
  readonly failures: number;
  readonly queued: number;
}

/** The read-only status/health view the status route returns. */
export interface ObservationSnapshot {
  /** Milliseconds since the observer's start reference. */
  readonly uptimeMs: number;
  /** Live counts by event type. */
  readonly eventCounts: Readonly<Record<string, number>>;
  /** Live counts by source module. */
  readonly eventsBySource: Readonly<Record<string, number>>;
  /** The last N observed events (bounded ring buffer), redacted — NO payloads. */
  readonly recentEvents: readonly ObservedEvent[];
  /** Durable historical view from the receipt log (counts/status only). */
  readonly receiptSummary: { readonly total: number; readonly byStatus: Readonly<Record<string, number>> };
  /** Health of the observer's own subscription. */
  readonly subscriptionHealth: SubscriptionHealth;
  /** When this snapshot was generated (ms epoch). */
  readonly generatedAt: number;
}

/** The self-observation surface (passive — observe + read + snapshot). */
export interface SelfObservation {
  /** Subscribe to the bus and begin accumulating. Idempotent. */
  start(): void;
  /** Unsubscribe (clean shutdown). */
  stop(): void;
  /** Build (and persist) the current status/health snapshot. */
  snapshot(): Promise<ObservationSnapshot>;
}

/**
 * ikbi self-observation — the passive observer (factory + start/stop/snapshot).
 *
 * PASSIVE: it subscribes to the bus (observe) and reads receipts (query) to build a
 * read-only snapshot. It imports NO action module, never calls invokeModel, never
 * publishes a command, never executes or intercepts anything. Its only writes are its
 * OWN snapshot docs + two lifecycle events.
 *
 * NO-LEAK: the event handler records METADATA ONLY (type/source/seq/timestamp/agentId)
 * and never reads `event.payload`; the receipt read touches only `outcome.status`,
 * never `metadata`/`requestSummary`.
 */

import { createDocumentStore } from "../../core/substrate/index.js";
import { events as coreEvents } from "../../core/events/index.js";
import type { EventBusSurface, EventInput, IkbiEvent, Subscription } from "../../core/events/index.js";
import { receipts as coreReceipts } from "../../core/receipt/index.js";
import type { Receipt, ReceiptQuery } from "../../core/receipt/contract.js";
import { selfObservationConfig, type SelfObservationConfig } from "./config.js";
import { selfobsSnapshot, selfobsStarted, type SelfObsEventPayload } from "./events.js";
import type { ObservationSnapshot, ObservedEvent, SelfObservation, SubscriptionHealth } from "./contract.js";

const EVENT_SOURCE = "self-observation";

const ZERO_HEALTH: SubscriptionHealth = { delivered: 0, dropped: 0, failures: 0, queued: 0 };

/** READ-ONLY receipt surface the observer uses (it never appends). */
export interface ReceiptReader {
  query(filter?: ReceiptQuery): Promise<Receipt[]>;
}

/** Minimal snapshot store surface (substitutable in tests). */
export interface SnapshotStore {
  get(id: string): Promise<ObservationSnapshot | undefined>;
  put(id: string, value: ObservationSnapshot): Promise<void>;
}

/** Injectable dependencies (tests substitute events / receipts / store / clock). */
export interface SelfObservationDeps {
  readonly config?: SelfObservationConfig;
  readonly events?: EventBusSurface;
  /** READ-ONLY receipts. Default: the live receipt store (queried, never appended). */
  readonly receipts?: ReceiptReader;
  readonly store?: SnapshotStore;
  /** Publish for the observer's own lifecycle events. Default: core bus publish. */
  readonly publish?: (input: EventInput<SelfObsEventPayload>) => void;
  readonly now?: () => number;
}

function bump(m: Map<string, number>, k: string): void {
  m.set(k, (m.get(k) ?? 0) + 1);
}

/** Build a passive observer. The default deps wire the live singletons + a DocumentStore. */
export function createSelfObservation(deps: SelfObservationDeps = {}): SelfObservation {
  const config = deps.config ?? selfObservationConfig;
  const events = deps.events ?? coreEvents;
  const receipts = deps.receipts ?? (coreReceipts as ReceiptReader);
  const store: SnapshotStore = deps.store ?? createDocumentStore<ObservationSnapshot>({ dir: config.snapshotDir });
  const publish = deps.publish ?? ((input: EventInput<SelfObsEventPayload>) => void coreEvents.publish(input));
  const now = deps.now ?? Date.now;

  const startedAt = now();
  const eventCounts = new Map<string, number>();
  const eventsBySource = new Map<string, number>();
  const recent: ObservedEvent[] = [];
  let subscription: Subscription | undefined;

  /** The observe handler — METADATA ONLY. It NEVER touches `event.payload`. */
  function observe(event: IkbiEvent): void {
    bump(eventCounts, event.type);
    if (event.source !== undefined) bump(eventsBySource, event.source);
    const agentId = event.attribution?.identity?.agentId;
    recent.push({
      seq: event.seq,
      type: event.type,
      timestamp: event.timestamp,
      ...(event.source !== undefined ? { source: event.source } : {}),
      ...(agentId !== undefined ? { agentId } : {}),
    });
    // Ring-buffer bound — drop oldest, never grow unbounded.
    if (recent.length > config.recentEventsMax) recent.splice(0, recent.length - config.recentEventsMax);
  }

  function start(): void {
    if (!config.enabled) return; // disabled ⇒ never subscribe (passive no-op)
    if (subscription !== undefined) return; // idempotent
    // Subscribe broadly; EXCLUDE our own source so lifecycle events don't feed back.
    subscription = events.subscribe(
      { predicate: (e) => e.source !== EVENT_SOURCE, label: EVENT_SOURCE },
      (e: IkbiEvent) => observe(e),
    );
    publish(selfobsStarted.create({}, { source: EVENT_SOURCE }));
  }

  function stop(): void {
    subscription?.unsubscribe();
    subscription = undefined;
  }

  async function snapshot(): Promise<ObservationSnapshot> {
    const generatedAt = now();
    if (!config.enabled) {
      // Minimal disabled view — no receipts read, no persistence.
      return {
        uptimeMs: generatedAt - startedAt,
        eventCounts: {},
        eventsBySource: {},
        recentEvents: [],
        receiptSummary: { total: 0, byStatus: {} },
        subscriptionHealth: ZERO_HEALTH,
        generatedAt,
      };
    }

    // Receipt summary — counts + by-status ONLY (never metadata/requestSummary).
    const all = await receipts.query({});
    const byStatus: Record<string, number> = {};
    for (const r of all) byStatus[r.outcome.status] = (byStatus[r.outcome.status] ?? 0) + 1;

    const snap: ObservationSnapshot = {
      uptimeMs: generatedAt - startedAt,
      eventCounts: Object.fromEntries(eventCounts),
      eventsBySource: Object.fromEntries(eventsBySource),
      recentEvents: recent.map((e) => ({ ...e })),
      receiptSummary: { total: all.length, byStatus },
      subscriptionHealth: subscription?.stats() ?? ZERO_HEALTH,
      generatedAt,
    };

    await store.put("latest", snap);
    publish(selfobsSnapshot.create({ observedTypes: eventCounts.size, recentCount: recent.length }, { source: EVENT_SOURCE }));
    return snap;
  }

  return { start, stop, snapshot };
}

/** The default process-wide observer, wired to the live singletons + a DocumentStore. */
export const selfObservation: SelfObservation = createSelfObservation();

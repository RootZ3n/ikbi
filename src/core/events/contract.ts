/**
 * ikbi event bus — THE FROZEN CORE connective tissue (contract).
 *
 * A single IN-PROCESS event bus that modules publish to and subscribe from,
 * decoupling emitters (workers, provider, governance) from consumers (monitoring,
 * the operator event stream, inter-module reactions). Events are typed,
 * attributed (via the frozen `AgentIdentity` where relevant), ordered, and
 * delivered reliably (no silent drop) with slow/failing-subscriber isolation.
 *
 * THE DELIVERY GUARANTEE (explicit):
 *   - IN-ORDER, PER SUBSCRIBER: each subscriber receives events in global publish
 *     order (a monotonic `seq`). Async handlers are awaited before the next event,
 *     so order holds even for async consumers.
 *   - AT-MOST-ONCE, ASYNCHRONOUS: `publish` assigns the event a seq and enqueues it
 *     onto each matching subscriber's OWN bounded queue, then returns immediately
 *     (emitters never block). Each subscriber drains its queue independently.
 *   - ISOLATED: a slow subscriber backs up only its own queue (never the emitter or
 *     other subscribers); a handler that throws is caught + logged per-subscriber
 *     and delivery continues.
 *   - NO SILENT DROP: delivery is reliable UP TO the per-subscriber buffer bound.
 *     Beyond the bound the bus drops per the subscription's policy and ALWAYS logs
 *     (warn) + counts it — drops are never silent. A subscriber that needs
 *     guaranteed delivery of audit-relevant events must PERSIST them (receipts);
 *     the bus is transient runtime signalling, NOT a persistence layer.
 *
 * Events are TRANSIENT runtime signals (observe live, react, stream to the UI).
 * Receipts (Phase 5) are the durable record; `log.ts` is operational telemetry.
 * The bus is none of those — a subscriber may persist events as receipts, but
 * that is the subscriber's job, not the bus's.
 *
 * SCOPE: in-process only (the engine is one service process). A cross-process /
 * distributed eventing seam (a bridge subscriber forwarding to other processes)
 * can be added with the deferred concurrency feature — NOT built here.
 */

import type { AgentIdentity } from "../provider/contract.js";

/** Semantic version of the event contract. Bump on breaking change. */
export const EVENT_CONTRACT_VERSION = "1.0.0";

/** Who/what produced an event (where applicable). Imports the frozen identity. */
export interface EventAttribution {
  /** The attributed agent identity (frozen shape) — for agent-produced events. */
  readonly identity?: AgentIdentity;
  /** The operation kind this event relates to (e.g. "model.invoke", "build.run"). */
  readonly operation?: string;
  /** Run / operation correlation id (groups events of one operation). */
  readonly runId?: string;
  /** Request correlation id. */
  readonly requestId?: string;
}

/**
 * The event envelope. Modules define their own event types against this common
 * envelope (see `defineEvent`): the `type` string namespaces the event and
 * `payload` carries the typed body. Complete enough for workers, monitoring,
 * governance, and the UI-stream to emit/consume without a contract change.
 */
export interface IkbiEvent<P = unknown> {
  readonly contractVersion: string;
  /** Unique event id. */
  readonly id: string;
  /** Global monotonic publish sequence — the ordering key. */
  readonly seq: number;
  /** Event type/name (dotted namespace, e.g. "worker.progress"). */
  readonly type: string;
  /** Creation time (ms epoch). */
  readonly timestamp: number;
  /** Typed payload (per type). */
  readonly payload: P;
  /** Logical source/component that emitted it (e.g. "worker", "provider"). */
  readonly source?: string;
  /** Attribution, where applicable. */
  readonly attribution?: EventAttribution;
}

/** What a caller supplies to `publish` — the bus fills id/seq/timestamp/contractVersion. */
export interface EventInput<P = unknown> {
  readonly type: string;
  readonly payload: P;
  readonly source?: string;
  readonly attribution?: EventAttribution;
}

/** An event handler. May be async; the bus awaits it (preserving per-subscriber order). */
export type EventHandler<P = unknown> = (event: IkbiEvent<P>) => void | Promise<void>;

/** Behavior when a subscriber's bounded queue is full. */
export type DropPolicy =
  | "drop_oldest" // evict the oldest queued event (keep latest) — default, good for live state
  | "drop_newest"; // reject the incoming event

/** Subscription filter + tuning. All provided filter clauses AND together. */
export interface SubscribeOptions {
  /** Match these exact event types. */
  readonly types?: readonly string[];
  /** Match events whose type starts with this prefix (e.g. "worker."). */
  readonly typePrefix?: string;
  /** Match this source only. */
  readonly source?: string;
  /** Match events attributed to this agent id only. */
  readonly agentId?: string;
  /** Arbitrary additional predicate. */
  readonly predicate?: (event: IkbiEvent) => boolean;
  /** Per-subscriber queue bound (defaults to config). */
  readonly maxQueue?: number;
  /** Overflow behavior at the bound (default "drop_oldest"). */
  readonly dropPolicy?: DropPolicy;
  /** Human label for logs. */
  readonly label?: string;
}

/** Observable per-subscription counters. */
export interface SubscriptionStats {
  readonly delivered: number;
  readonly dropped: number;
  readonly failures: number;
  readonly queued: number;
}

/** A live subscription handle. */
export interface Subscription {
  readonly id: string;
  unsubscribe(): void;
  stats(): SubscriptionStats;
}

/** The bus surface every module uses (the single canonical pub/sub). */
export interface EventBusSurface {
  publish<P>(input: EventInput<P>): IkbiEvent<P>;
  subscribe<P = unknown>(opts: SubscribeOptions, handler: EventHandler<P>): Subscription;
  /** Await all in-flight subscriber deliveries to drain (for tests / graceful shutdown). */
  flush(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Typed-event ergonomics (extensible: modules define their own types)
// ---------------------------------------------------------------------------

/** A typed event definition: a `type` string + helpers to create + narrow. */
export interface EventType<P> {
  readonly type: string;
  /** Build an `EventInput` for publishing this typed event. */
  create(payload: P, opts?: { source?: string; attribution?: EventAttribution }): EventInput<P>;
  /** Runtime type guard: is this envelope an event of this type? */
  is(event: IkbiEvent): event is IkbiEvent<P>;
}

/** Define a typed event against the common envelope. */
export function defineEvent<P>(type: string): EventType<P> {
  return {
    type,
    create: (payload, opts) => ({
      type,
      payload,
      ...(opts?.source !== undefined ? { source: opts.source } : {}),
      ...(opts?.attribution !== undefined ? { attribution: opts.attribution } : {}),
    }),
    is: (event): event is IkbiEvent<P> => event.type === type,
  };
}

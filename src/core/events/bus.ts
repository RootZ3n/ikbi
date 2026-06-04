/**
 * ikbi event bus — in-process, typed, ordered, isolated delivery.
 *
 * Each subscriber gets its OWN bounded FIFO queue and an independent async drain
 * loop. `publish` assigns a monotonic seq, enqueues onto each matching
 * subscriber's queue, and returns immediately — emitters never block. The drain
 * loop awaits each (possibly async) handler before the next event, so each
 * subscriber sees events in global publish order. A handler that throws is caught
 * + logged per-subscriber; a slow handler backs up only its own queue. At the
 * queue bound, the bus drops per the subscription's policy and LOUDLY logs +
 * counts the drop — never silent.
 */

import { randomBytes } from "node:crypto";
import type { Logger } from "pino";

import {
  type DropPolicy,
  type EventBusSurface,
  EVENT_CONTRACT_VERSION,
  type EventHandler,
  type EventInput,
  type IkbiEvent,
  type SubscribeOptions,
  type Subscription,
  type SubscriptionStats,
} from "./contract.js";

interface Sub {
  readonly id: string;
  readonly opts: SubscribeOptions;
  readonly handler: EventHandler;
  readonly maxQueue: number;
  readonly dropPolicy: DropPolicy;
  readonly queue: IkbiEvent[];
  draining: boolean;
  drainPromise: Promise<void>;
  closed: boolean;
  delivered: number;
  dropped: number;
  failures: number;
}

export interface EventBusDeps {
  readonly logger: Logger;
  readonly defaultMaxQueue: number;
  readonly now?: () => number;
}

export class EventBus implements EventBusSurface {
  private readonly log: Logger;
  private readonly defaultMaxQueue: number;
  private readonly now: () => number;
  private readonly subs = new Map<string, Sub>();
  private seq = 0;

  constructor(deps: EventBusDeps) {
    this.log = deps.logger;
    this.defaultMaxQueue = deps.defaultMaxQueue;
    this.now = deps.now ?? Date.now;
  }

  publish<P>(input: EventInput<P>): IkbiEvent<P> {
    const event: IkbiEvent<P> = {
      contractVersion: EVENT_CONTRACT_VERSION,
      id: randomBytes(12).toString("hex"),
      seq: (this.seq += 1),
      type: input.type,
      timestamp: this.now(),
      payload: input.payload,
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.attribution !== undefined ? { attribution: input.attribution } : {}),
    };

    for (const sub of this.subs.values()) {
      if (sub.closed || !this.matches(sub, event)) continue;
      this.enqueue(sub, event);
      this.kickDrain(sub);
    }
    return event;
  }

  subscribe<P = unknown>(opts: SubscribeOptions, handler: EventHandler<P>): Subscription {
    const id = randomBytes(8).toString("hex");
    const sub: Sub = {
      id,
      opts,
      handler: handler as EventHandler,
      maxQueue: opts.maxQueue ?? this.defaultMaxQueue,
      dropPolicy: opts.dropPolicy ?? "drop_oldest",
      queue: [],
      draining: false,
      drainPromise: Promise.resolve(),
      closed: false,
      delivered: 0,
      dropped: 0,
      failures: 0,
    };
    this.subs.set(id, sub);
    this.log.debug({ event: "bus_subscribed", subId: id, label: opts.label, types: opts.types, typePrefix: opts.typePrefix }, "event subscription added");

    const surface: Subscription = {
      id,
      unsubscribe: () => {
        const s = this.subs.get(id);
        if (s === undefined) return;
        s.closed = true;
        s.queue.length = 0;
        this.subs.delete(id);
        this.log.debug({ event: "bus_unsubscribed", subId: id, label: opts.label }, "event subscription removed");
      },
      stats: () => this.statsOf(id),
    };
    return surface;
  }

  /** Await all in-flight subscriber deliveries to drain. For tests / graceful shutdown. */
  async flush(): Promise<void> {
    // Loop until no subscriber has queued/in-flight work (handlers may enqueue more).
    for (;;) {
      const pending = [...this.subs.values()].filter((s) => s.draining || s.queue.length > 0);
      if (pending.length === 0) return;
      await Promise.all(pending.map((s) => s.drainPromise));
    }
  }

  private statsOf(id: string): SubscriptionStats {
    const s = this.subs.get(id);
    if (s === undefined) return { delivered: 0, dropped: 0, failures: 0, queued: 0 };
    return { delivered: s.delivered, dropped: s.dropped, failures: s.failures, queued: s.queue.length };
  }

  private matches(sub: Sub, event: IkbiEvent): boolean {
    const o = sub.opts;
    if (o.types !== undefined && !o.types.includes(event.type)) return false;
    if (o.typePrefix !== undefined && !event.type.startsWith(o.typePrefix)) return false;
    if (o.source !== undefined && event.source !== o.source) return false;
    if (o.agentId !== undefined && event.attribution?.identity?.agentId !== o.agentId) return false;
    if (o.predicate !== undefined && !o.predicate(event)) return false;
    return true;
  }

  private enqueue(sub: Sub, event: IkbiEvent): void {
    if (sub.queue.length >= sub.maxQueue) {
      if (sub.dropPolicy === "drop_newest") {
        sub.dropped += 1;
        this.logDrop(sub, event, "drop_newest");
        return;
      }
      // drop_oldest: evict the oldest to make room for the latest.
      const evicted = sub.queue.shift();
      sub.dropped += 1;
      this.logDrop(sub, evicted ?? event, "drop_oldest");
    }
    sub.queue.push(event);
  }

  private logDrop(sub: Sub, event: IkbiEvent, policy: DropPolicy): void {
    this.log.warn(
      {
        event: "bus_backpressure_drop",
        subId: sub.id,
        label: sub.opts.label,
        policy,
        droppedType: event.type,
        droppedSeq: event.seq,
        totalDropped: sub.dropped,
        maxQueue: sub.maxQueue,
      },
      "event bus dropped an event for a saturated subscriber (not silent)",
    );
  }

  private kickDrain(sub: Sub): void {
    if (sub.draining || sub.closed) return;
    sub.draining = true;
    sub.drainPromise = this.drain(sub);
  }

  private async drain(sub: Sub): Promise<void> {
    try {
      while (!sub.closed && sub.queue.length > 0) {
        const event = sub.queue.shift() as IkbiEvent;
        try {
          await sub.handler(event);
          sub.delivered += 1;
        } catch (err) {
          sub.failures += 1;
          this.log.warn(
            { event: "bus_handler_failed", subId: sub.id, label: sub.opts.label, eventType: event.type, eventSeq: event.seq, err },
            "event subscriber handler threw (isolated; delivery continues)",
          );
        }
      }
    } finally {
      sub.draining = false;
    }
  }
}

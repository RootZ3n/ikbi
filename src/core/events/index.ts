/**
 * ikbi event bus — public surface (frozen core).
 *
 * The single canonical in-process pub/sub. Modules do NOT hand-roll their own
 * pub/sub — they use this. Emitters publish; monitoring / the operator stream /
 * inter-module reactions subscribe.
 *
 *     const Progress = defineEvent<{ pct: number }>("worker.progress");
 *     const sub = events.subscribe({ typePrefix: "worker." }, (e) => { ... });
 *     events.publish(Progress.create({ pct: 50 }, { source: "worker", attribution: { identity } }));
 *     sub.unsubscribe();
 *
 * Delivery guarantee (in-order per subscriber, at-most-once, isolated, loud-drop
 * at the bound) is stated in `contract.ts`. Events are TRANSIENT — receipts are
 * the durable record, `log.ts` is telemetry; the bus is neither.
 */

import { config } from "../config.js";
import { childLogger } from "../log.js";
import { EventBus } from "./bus.js";

const log = childLogger("events");

/** The process-wide event bus. */
export const events: EventBus = new EventBus({
  logger: log,
  defaultMaxQueue: config.events.maxQueue,
});

// --- re-export the frozen contract + building blocks ---
export { EventBus } from "./bus.js";
export type { EventBusDeps } from "./bus.js";
export {
  EVENT_CONTRACT_VERSION,
  defineEvent,
  type DropPolicy,
  type EventAttribution,
  type EventBusSurface,
  type EventHandler,
  type EventInput,
  type EventType,
  type IkbiEvent,
  type SubscribeOptions,
  type Subscription,
  type SubscriptionStats,
} from "./contract.js";

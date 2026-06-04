/**
 * ikbi self-observation — its OWN lifecycle events (namespaced `selfobs.*`).
 *
 * The observer mostly CONSUMES events; it emits only a couple of minimal lifecycle
 * events of its own (start / snapshot). Payloads carry counts only — never observed
 * event payloads or receipt contents. (The observer's broad subscription deliberately
 * excludes its own source to avoid a feedback loop.)
 */

import { defineEvent } from "../../core/events/index.js";

/** Payload for the observer's lifecycle events (counts only). */
export interface SelfObsEventPayload {
  /** How many distinct event types have been observed (snapshot). */
  readonly observedTypes?: number;
  /** How many recent events are buffered (snapshot). */
  readonly recentCount?: number;
}

/** Emitted when the observer starts subscribing. */
export const selfobsStarted = defineEvent<SelfObsEventPayload>("selfobs.started");
/** Emitted when a snapshot is generated. */
export const selfobsSnapshot = defineEvent<SelfObsEventPayload>("selfobs.snapshot");

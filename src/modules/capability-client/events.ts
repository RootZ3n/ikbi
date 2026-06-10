/**
 * ikbi capability-client — its events (namespaced `capability.*` per module plan ## 8).
 *
 * Published with `source: "capability-client"`. Payloads carry only counts / a reason
 * label — NEVER raw ledger payloads or evidence text.
 */

import { defineEvent } from "../../core/events/index.js";

/** Payload for the capability-client lifecycle events (fields populated as known). */
export interface CapabilityEventPayload {
  /** How many scores were loaded from the ledger (on a successful fetch). */
  readonly scoreCount?: number;
  /** Why the client served no fresh data (e.g. "disabled", "fetch_failed", "bad_response"). */
  readonly reason?: string;
}

/** Emitted on a successful ledger fetch (scores refreshed into the cache). */
export const capabilityFetched = defineEvent<CapabilityEventPayload>("capability.fetched");
/** Emitted when the ledger could not be consulted and the client fell back (graceful). */
export const capabilityUnavailable = defineEvent<CapabilityEventPayload>("capability.unavailable");

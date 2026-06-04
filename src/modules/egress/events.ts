/**
 * ikbi network-egress floor — its events (namespaced `egress.*` per module plan ## 8).
 *
 * `egress.blocked` is published whenever the guard refuses an outbound call, so
 * monitoring/the operator stream sees every SSRF/allowlist denial. The bus is
 * transient; this is a live signal, not the durable record.
 */

import { defineEvent } from "../../core/events/index.js";

/** Why the egress guard refused a call (stable tokens for dashboards/alerts). */
export type EgressBlockReason =
  | "invalid_url"
  | "scheme" // non-http(s) scheme
  | "not_allowlisted" // host not in the default-deny allowlist
  | "dns_failure" // resolution failed
  | "dns_empty" // resolution returned no addresses
  | "internal_ip"; // a resolved IP is in the internal/metadata blocklist

/** Payload for `egress.blocked`. */
export interface EgressBlockedPayload {
  readonly reason: EgressBlockReason;
  /** The target host (or raw input when it would not parse). */
  readonly host: string;
  /** Human/audit detail (e.g. "api.evil.test -> 169.254.169.254 (ipv4_cloud_metadata)"). */
  readonly detail: string;
}

/** The typed, namespaced egress-block event. */
export const egressBlocked = defineEvent<EgressBlockedPayload>("egress.blocked");

/**
 * ikbi network-egress floor — its events (namespaced `egress.*` per module plan ## 8).
 *
 * `egress.blocked` is published whenever the guard refuses an outbound call, so
 * monitoring/the operator stream sees every SSRF/allowlist denial. The bus is
 * transient; this is a live signal, not the durable record.
 *
 * `egress.local_allowed` is the POSITIVE counterpart: published whenever the guard
 * permits an internal/loopback destination because it EXACTLY matches an operator-opted
 * local endpoint (IKBI_EGRESS_ALLOW_LOCAL). It is an ALLOW, logged for audit — so the
 * operator sees every time the SSRF floor was bypassed for a named local endpoint. NOT a
 * block reason.
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

/** Payload for `egress.local_allowed` — a logged ALLOW of an exact-match local endpoint. */
export interface EgressLocalAllowedPayload {
  /** The local host that was allowed (e.g. "127.0.0.1"). */
  readonly host: string;
  /** The exact port the operator opted in. */
  readonly port: number;
  /** The internal-classification reason that WOULD have blocked it (e.g. "ipv4_loopback"). */
  readonly reason: string;
}

/** The typed, namespaced positive event — an exact-match local endpoint was permitted. */
export const egressLocalAllowed = defineEvent<EgressLocalAllowedPayload>("egress.local_allowed");

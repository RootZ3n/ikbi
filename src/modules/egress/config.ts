/**
 * ikbi network-egress floor — its OWN config slice (per-module config seam).
 *
 * Read ONLY through `moduleEnv("egress")` — never `configEnv` directly (module
 * plan ## 8: "No direct configEnv reads"). The reader auto-prefixes `IKBI_EGRESS_`,
 * so this module physically cannot read another module's or a core var.
 *
 *   IKBI_EGRESS_ALLOWLIST  comma-separated egress hosts (exact host match,
 *                          case-insensitive). DEFAULT-DENY: empty/unset = nothing
 *                          is allowed, so every outbound call is blocked until the
 *                          operator opts specific hosts in.
 *   IKBI_EGRESS_ALLOW_LOCAL  comma-separated `host:port` LOCAL endpoints (exact match,
 *                          case-insensitive), e.g. "127.0.0.1:11434" for a local Ollama.
 *                          DEFAULT EMPTY — no internal/loopback destination is reachable
 *                          unless the operator opts in EXACTLY this host:port. This is a
 *                          NARROW exception at the internal-IP rejection point; it does
 *                          NOT replace the host allowlist (Layer 1 STILL applies) and it
 *                          is exact-match only (no ranges, globs, or subnets).
 */

import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("egress");

export interface EgressConfig {
  /** Permitted egress hosts (lowercased, exact match). Empty = default-deny-all. */
  readonly allowlist: readonly string[];
  /**
   * Exact-match `host:port` local endpoints the operator has explicitly opted in
   * (lowercased). Empty = no local access. An ADDITIONAL gate at the internal-IP layer,
   * NOT a replacement for `allowlist` — a local endpoint must ALSO be host-allowlisted.
   */
  readonly localEndpoints: readonly string[];
}

/** Load the egress config slice from `IKBI_EGRESS_*`. */
export function loadEgressConfig(reader = env): EgressConfig {
  return Object.freeze({
    allowlist: reader.list("ALLOWLIST").map((h) => h.toLowerCase()),
    localEndpoints: reader.list("ALLOW_LOCAL").map((e) => e.toLowerCase()),
  });
}

/** The process-wide egress config. */
export const egressConfig: EgressConfig = loadEgressConfig();

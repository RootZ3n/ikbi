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
 */

import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("egress");

export interface EgressConfig {
  /** Permitted egress hosts (lowercased, exact match). Empty = default-deny-all. */
  readonly allowlist: readonly string[];
}

/** Load the egress config slice from `IKBI_EGRESS_*`. */
export function loadEgressConfig(reader = env): EgressConfig {
  return Object.freeze({
    allowlist: reader.list("ALLOWLIST").map((h) => h.toLowerCase()),
  });
}

/** The process-wide egress config. */
export const egressConfig: EgressConfig = loadEgressConfig();

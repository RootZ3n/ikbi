/**
 * ikbi network-egress floor — its OWN config slice (per-module config seam).
 *
 * Read ONLY through `moduleEnv("egress")` — never `configEnv` directly (module
 * plan ## 8: "No direct configEnv reads"). The reader auto-prefixes `IKBI_EGRESS_`,
 * so this module physically cannot read another module's or a core var.
 *
 *   IKBI_EGRESS_ALLOWLIST  comma-separated egress hosts (exact host match,
 *                          case-insensitive). When UNSET, a small DEFAULT allowlist
 *                          applies (`DEFAULT_EGRESS_HOSTS` below: the web-search host
 *                          + common doc hosts) so the web tools work out of the box.
 *                          When SET, the operator's list REPLACES the default entirely
 *                          — set it to restrict (or widen) egress to exactly those
 *                          hosts. The guard itself stays DEFAULT-DENY: any host not on
 *                          the resolved allowlist is blocked.
 *   IKBI_EGRESS_ALLOW_LOCAL  comma-separated `ip:port` LOCAL endpoints (exact match),
 *                          e.g. "127.0.0.1:11434" for a local Ollama. The host part MUST
 *                          be an IP LITERAL (IPv4, or bracketed IPv6 "[::1]:11434") — a
 *                          HOSTNAME is REJECTED at load, BY DESIGN: the exception matches
 *                          on the RESOLVED IP, and a name can resolve to ANY internal IP
 *                          (including cloud metadata), which would re-open the SSRF gap.
 *                          DEFAULT EMPTY — no internal/loopback destination is reachable
 *                          unless the operator opts in EXACTLY this ip:port. A NARROW
 *                          exception at the internal-IP rejection point; it does NOT
 *                          replace the host allowlist (Layer 1 STILL applies) and it is
 *                          exact-match only (no ranges, globs, or subnets).
 */

import { isIP } from "node:net";

import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("egress");

/**
 * The DEFAULT egress allowlist applied when `IKBI_EGRESS_ALLOWLIST` is UNSET — just
 * enough for the web tools to work out of the box: the no-key web-search host plus a
 * few common documentation hosts. Lowercased, exact host match. Setting the env var
 * REPLACES this list entirely (the operator can restrict or widen at will). The guard
 * stays default-deny — nothing outside the resolved allowlist is reachable.
 */
export const DEFAULT_EGRESS_HOSTS: readonly string[] = Object.freeze([
  "html.duckduckgo.com",
  "docs.python.org",
  "developer.mozilla.org",
  "stackoverflow.com",
]);

export interface EgressConfig {
  /** Permitted egress hosts (lowercased, exact match). Empty = default-deny-all. */
  readonly allowlist: readonly string[];
  /**
   * Exact-match `ip:port` local endpoints the operator has explicitly opted in (canonical,
   * lowercased; the host part is always an IP LITERAL). Empty = no local access. An
   * ADDITIONAL gate at the internal-IP layer matched against the RESOLVED IP, NOT a
   * replacement for `allowlist` — a local endpoint must ALSO be host-allowlisted.
   */
  readonly localEndpoints: readonly string[];
}

/**
 * Parse + validate one ALLOW_LOCAL entry into a canonical `ip:port` key. THROWS on a
 * non-IP-literal host: ALLOW_LOCAL takes IP-literals ONLY because the guard matches on the
 * resolved IP — a hostname could resolve to any internal IP and re-open the SSRF gap. A
 * misconfiguration here fails LOUD at load rather than silently widening the floor.
 */
export function parseLocalEndpoint(entry: string): string {
  const raw = entry.trim().toLowerCase();
  let host: string;
  let portStr: string;
  const bracketed = /^\[([0-9a-f:]+)\]:(\d{1,5})$/.exec(raw); // [::1]:11434
  if (bracketed !== null) {
    host = bracketed[1]!;
    portStr = bracketed[2]!;
  } else {
    const idx = raw.lastIndexOf(":");
    if (idx <= 0 || idx === raw.length - 1) {
      throw new Error(`IKBI_EGRESS_ALLOW_LOCAL entry "${entry}" is not "ip:port"`);
    }
    host = raw.slice(0, idx);
    portStr = raw.slice(idx + 1);
  }
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`IKBI_EGRESS_ALLOW_LOCAL entry "${entry}" has an invalid port "${portStr}"`);
  }
  if (isIP(host) === 0) {
    throw new Error(
      `IKBI_EGRESS_ALLOW_LOCAL entry "${entry}" host "${host}" is not an IP literal — ALLOW_LOCAL takes IP-literals only (a hostname can resolve to any internal IP, which would re-open the SSRF gap)`,
    );
  }
  return `${host}:${port}`;
}

/** Load the egress config slice from `IKBI_EGRESS_*`. */
export function loadEgressConfig(reader = env): EgressConfig {
  return Object.freeze({
    allowlist: reader.list("ALLOWLIST", DEFAULT_EGRESS_HOSTS).map((h) => h.toLowerCase()),
    localEndpoints: reader.list("ALLOW_LOCAL").map(parseLocalEndpoint),
  });
}

/** The process-wide egress config. */
export const egressConfig: EgressConfig = loadEgressConfig();

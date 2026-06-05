/**
 * ikbi network-egress floor — the guarded fetch (SSRF guard).
 *
 * This is the `FetchLike` the provider fetch-guard seam registers. BEFORE any
 * network call it: (1) parses the URL and rejects non-http(s) schemes; (2)
 * enforces a default-DENY host allowlist; (3) resolves the host and rejects if
 * ANY resolved IP is internal/loopback/link-local/ULA/metadata (defeats
 * DNS-rebinding-to-internal by validating EVERY address). Only if all checks pass
 * does it hand off to the real transport.
 *
 * On rejection it publishes a namespaced `egress.blocked` event AND throws a
 * `ProviderError` with kind "network" (so a block flows through the provider
 * fallback-chain classification), never a raw Error.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * KNOWN LIMITATION — DNS-rebinding TOCTOU (for the 3-eyes review to rule on):
 *   We resolve the hostname, validate ALL returned IPs, then hand the original
 *   URL *string* to the transport, which re-resolves DNS at connect time. An
 *   attacker who re-points the name to an internal IP in the window between our
 *   validation and the transport's connect could still reach internal space
 *   (classic resolve-then-connect TOCTOU). Closing it fully requires PINNING the
 *   connection to the validated IP (custom dispatcher/lookup), which the minimal
 *   `FetchLike` surface ({method,headers,body,signal} only — no dispatcher) does
 *   NOT expose, and rewriting the URL to an IP literal would break TLS SNI/cert
 *   validation. Validating every resolved IP defeats the *static* internal-IP and
 *   single-answer-rebind cases; the residual is the re-resolution race. Documented,
 *   not silently ignored — pinning is a follow-up once the transport surface allows it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { lookup } from "node:dns/promises";

import { ProviderError } from "../../core/provider/contract.js";
import type { FetchLike } from "../../core/provider/providers/openai-compatible.js";
import { events } from "../../core/events/index.js";
import { egressConfig } from "./config.js";
import { egressBlocked, egressLocalAllowed, type EgressBlockedPayload, type EgressBlockReason, type EgressLocalAllowedPayload } from "./events.js";
import { classifyIp } from "./ip.js";

/** Injectable dependencies (tests substitute DNS + transport + publish). */
export interface GuardedFetchDeps {
  /** Permitted egress hosts, lowercased + exact-match. Empty = default-deny-all. */
  readonly allowlist: readonly string[];
  /**
   * Exact-match `host:port` local endpoints the operator opted in (lowercased). A NARROW
   * exception at the internal-IP layer — an internal/loopback destination is permitted ONLY
   * if its `host:port` is in this set AND its host already passed the allowlist (Layer 1).
   * Empty = no local access (the floor is unchanged).
   */
  readonly localEndpoints: readonly string[];
  /** Resolve a host to its IP literals. Defaults to node DNS (`lookup`, all addresses). */
  readonly resolve?: (host: string) => Promise<string[]>;
  /** The underlying transport, invoked ONLY after all checks pass. Defaults to real fetch. */
  readonly transport?: FetchLike;
  /** Sink for `egress.blocked`. Defaults to the process event bus. */
  readonly publishBlocked?: (payload: EgressBlockedPayload) => void;
  /** Sink for the positive `egress.local_allowed`. Defaults to the process event bus. */
  readonly publishLocalAllowed?: (payload: EgressLocalAllowedPayload) => void;
}

/** The scheme default port (used to form the exact-match `host:port` key when absent). */
function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

/** Default DNS resolver: every A/AAAA address for the host (IP literals pass through). */
async function defaultResolve(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true });
  return records.map((r) => r.address);
}

/**
 * The real transport. This is the ONLY reference to `globalThis.fetch` in the
 * engine after the fetch-guard seam, and it is reached ONLY after validation —
 * so no code path performs un-guarded network I/O.
 */
const realTransport = globalThis.fetch as unknown as FetchLike;

/** Build a guarded fetch from explicit dependencies (the testable core). */
export function createGuardedFetch(deps: GuardedFetchDeps): FetchLike {
  const allowlist = new Set(deps.allowlist.map((h) => h.toLowerCase()));
  // Exact-match `host:port` local endpoints (default-deny: empty ⇒ no local access).
  const localAllowed = new Set(deps.localEndpoints.map((e) => e.toLowerCase()));
  const resolve = deps.resolve ?? defaultResolve;
  const transport = deps.transport ?? realTransport;
  const publishBlocked =
    deps.publishBlocked ??
    ((payload: EgressBlockedPayload): void => {
      events.publish(egressBlocked.create(payload, { source: "egress" }));
    });
  const publishLocalAllowed =
    deps.publishLocalAllowed ??
    ((payload: EgressLocalAllowedPayload): void => {
      events.publish(egressLocalAllowed.create(payload, { source: "egress" }));
    });

  /** Publish the block event, then throw a network-kind ProviderError. Never returns. */
  const block = (reason: EgressBlockReason, host: string, detail: string): never => {
    publishBlocked({ reason, host, detail });
    throw new ProviderError(`egress blocked (${reason}): ${detail}`, {
      // "network" so it flows through the provider fallback-chain classification.
      // retriable:false — an egress denial is a deterministic POLICY block, not a
      // provider-health blip: it must not trip the circuit breaker. The fallback
      // chain still advances to the next provider regardless of this flag.
      kind: "network",
      provider: "egress",
      retriable: false,
    });
  };

  return async (input, init) => {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return block("invalid_url", input, `not a valid URL: ${input}`);
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return block("scheme", url.hostname, `disallowed scheme "${url.protocol}" (only http/https)`);
    }

    const host = url.hostname.toLowerCase();
    // LAYER 1 — default-DENY host allowlist: an empty allowlist permits nothing. This
    // applies to local endpoints TOO (the local-endpoint exception below is ADDITIONAL,
    // not a replacement — a local host must still be allowlisted here).
    if (!allowlist.has(host)) {
      return block("not_allowlisted", host, `host "${host}" is not in IKBI_EGRESS_ALLOWLIST`);
    }

    // The port for the local-endpoint key (explicit, or the scheme default).
    const port = url.port || defaultPort(url.protocol);

    let ips: string[];
    try {
      ips = await resolve(host);
    } catch (cause) {
      return block("dns_failure", host, `DNS resolution failed for "${host}": ${String(cause)}`);
    }
    if (ips.length === 0) {
      return block("dns_empty", host, `DNS returned no addresses for "${host}"`);
    }

    // LAYER 2 — every resolved IP must be PUBLIC or the EXACT operator-opted internal
    // IP:port. The exception keys on the RESOLVED IP `classifyIp` actually saw, NEVER the
    // hostname (a name can resolve to any internal IP, including cloud metadata). Block on
    // the FIRST internal IP that is not the opted-in endpoint — so a multi-IP rebind where
    // ANY answer is an un-opted internal address (e.g. [127.0.0.1, 169.254.169.254])
    // blocks the WHOLE request; one allowed IP can never bless the others.
    let matchedLocal: { ip: string; reason: string } | undefined;
    for (const ip of ips) {
      const verdict = classifyIp(ip);
      if (!verdict.internal) continue;
      if (localAllowed.has(`${ip}:${port}`)) {
        matchedLocal = { ip, reason: verdict.reason };
        continue; // this internal IP is the opted-in endpoint — keep validating the rest
      }
      return block("internal_ip", host, `${host} -> ${ip} (${verdict.reason})`);
    }

    // No internal-and-not-opted-in IP among the answers. If an opted-in local endpoint was
    // matched, log the positive allow (carrying the resolved IP the decision keyed on).
    if (matchedLocal !== undefined) {
      publishLocalAllowed({ host, resolvedIp: matchedLocal.ip, port: Number(port), reason: matchedLocal.reason });
    }
    // All checks passed — hand off to the real transport. (See TOCTOU note above.)
    return transport(input, init);
  };
}

/**
 * The process-wide guarded fetch the egress floor registers via the provider
 * fetch-guard seam. Built from the module's own config slice + real DNS/transport.
 */
export const guardedFetch: FetchLike = createGuardedFetch({ allowlist: egressConfig.allowlist, localEndpoints: egressConfig.localEndpoints });

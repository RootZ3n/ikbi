/**
 * ikbi network-egress floor — internal-IP classification (the SSRF blocklist).
 *
 * Default-DENY against the internal/link-local/loopback/metadata address space.
 * A resolved IP that lands in ANY of these ranges is rejected — this is what
 * defeats DNS-rebinding-to-internal (resolve a public name, get an internal IP).
 *
 * Covered (both families):
 *   IPv4  0.0.0.0/8 (incl. 0.0.0.0), 10/8, 127/8 (loopback), 169.254/16
 *         (link-local, incl. the 169.254.169.254 cloud-metadata IP), 172.16/12,
 *         192.168/16.
 *   IPv6  :: (unspecified), ::1 (loopback), fe80::/10 (link-local), fc00::/7
 *         (ULA), and IPv4-mapped/compatible (::ffff:a.b.c.d / ::a.b.c.d) — the
 *         embedded IPv4 is extracted and classified, so a mapped internal v4
 *         cannot sneak through as a v6 literal.
 *
 * Pure + dependency-free so every range is unit-testable in isolation.
 */

/** Verdict for one IP. `internal: true` ⇒ MUST be rejected by the egress guard. */
export interface IpVerdict {
  readonly internal: boolean;
  /** Stable reason token for logging / the egress.blocked event (e.g. "ipv4_rfc1918"). */
  readonly reason: string;
}

const PUBLIC: IpVerdict = { internal: false, reason: "public" };

/** Parse a dotted IPv4 string to a 32-bit unsigned int, or undefined if not IPv4. */
function parseIpv4(s: string): number | undefined {
  const parts = s.split(".");
  if (parts.length !== 4) return undefined;
  let acc = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return undefined;
    const n = Number(p);
    if (n > 255) return undefined;
    acc = acc * 256 + n;
  }
  return acc >>> 0;
}

/** Classify a 32-bit IPv4. The explicit metadata IP is called out for clarity. */
function classifyIpv4Int(ip: number): IpVerdict {
  const a = (ip >>> 24) & 0xff;
  const b = (ip >>> 16) & 0xff;
  // 169.254.169.254 — the cloud metadata endpoint (covered by 169.254/16, named
  // explicitly because it is THE canonical SSRF target).
  if (ip === ((169 << 24) | (254 << 16) | (169 << 8) | 254) >>> 0) {
    return { internal: true, reason: "ipv4_cloud_metadata" };
  }
  if (a === 0) return { internal: true, reason: "ipv4_this_network" }; // 0.0.0.0/8 incl. 0.0.0.0
  if (a === 10) return { internal: true, reason: "ipv4_rfc1918" }; // 10/8
  if (a === 127) return { internal: true, reason: "ipv4_loopback" }; // 127/8
  if (a === 169 && b === 254) return { internal: true, reason: "ipv4_link_local" }; // 169.254/16
  if (a === 172 && b >= 16 && b <= 31) return { internal: true, reason: "ipv4_rfc1918" }; // 172.16/12
  if (a === 192 && b === 168) return { internal: true, reason: "ipv4_rfc1918" }; // 192.168/16
  return PUBLIC;
}

/**
 * Parse an IPv6 string to 16 bytes, handling `::` compression and a trailing
 * embedded IPv4 (`::ffff:1.2.3.4`). Returns undefined if not a valid IPv6 literal.
 */
function parseIpv6(s: string): Uint8Array | undefined {
  let str = s;
  // Strip a zone id (fe80::1%eth0) — the scope does not affect classification.
  const pct = str.indexOf("%");
  if (pct !== -1) str = str.slice(0, pct);
  if (!str.includes(":")) return undefined;

  // A trailing embedded IPv4 contributes the last 2 hextets (4 bytes).
  let tailV4: number | undefined;
  const lastColon = str.lastIndexOf(":");
  const tail = str.slice(lastColon + 1);
  if (tail.includes(".")) {
    tailV4 = parseIpv4(tail);
    if (tailV4 === undefined) return undefined;
    str = str.slice(0, lastColon + 1) + ipv4ToHextets(tailV4);
  }

  const halves = str.split("::");
  if (halves.length > 2) return undefined; // more than one "::" is invalid
  const h0 = halves[0] ?? "";
  const h1 = halves[1] ?? "";
  const headParts = h0 === "" ? [] : h0.split(":");
  const tailParts = halves.length === 2 ? (h1 === "" ? [] : h1.split(":")) : null;

  const toBytes = (parts: string[]): number[] | undefined => {
    const out: number[] = [];
    for (const p of parts) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return undefined;
      const n = Number.parseInt(p, 16);
      out.push((n >>> 8) & 0xff, n & 0xff);
    }
    return out;
  };

  const head = toBytes(headParts);
  if (head === undefined) return undefined;

  if (tailParts === null) {
    // No "::" — must be exactly 8 hextets (16 bytes).
    if (head.length !== 16) return undefined;
    return Uint8Array.from(head);
  }
  const tailBytes = toBytes(tailParts);
  if (tailBytes === undefined) return undefined;
  const fill = 16 - head.length - tailBytes.length;
  if (fill < 0) return undefined;
  return Uint8Array.from([...head, ...new Array(fill).fill(0), ...tailBytes]);
}

/** Render a 32-bit IPv4 as two colon-separated hextets (for embedding into IPv6). */
function ipv4ToHextets(ip: number): string {
  const hi = (ip >>> 16) & 0xffff;
  const lo = ip & 0xffff;
  return `${hi.toString(16)}:${lo.toString(16)}`;
}

function classifyIpv6Bytes(b: Uint8Array): IpVerdict {
  // Safe byte read (b is a validated 16-byte array; this satisfies the
  // noUncheckedIndexedAccess flag without per-access guards).
  const at = (i: number): number => b[i] ?? 0;
  const allZeroUpTo = (n: number): boolean => b.slice(0, n).every((x) => x === 0);
  const embeddedV4 = (): number => ((at(12) << 24) | (at(13) << 16) | (at(14) << 8) | at(15)) >>> 0;

  // IPv4-mapped ::ffff:a.b.c.d (bytes 0..9 zero, 10-11 == 0xff) — classify embedded v4.
  if (allZeroUpTo(10) && at(10) === 0xff && at(11) === 0xff) {
    const verdict = classifyIpv4Int(embeddedV4());
    return verdict.internal ? verdict : PUBLIC;
  }
  // IPv4-compatible ::a.b.c.d (deprecated): bytes 0..11 zero, embedded v4 nonzero.
  if (allZeroUpTo(12) && (at(12) | at(13) | at(14) | at(15)) !== 0) {
    // ::1 is loopback; any other embedded v4 → classify it.
    if (at(15) === 1 && at(12) === 0 && at(13) === 0 && at(14) === 0) {
      return { internal: true, reason: "ipv6_loopback" };
    }
    const verdict = classifyIpv4Int(embeddedV4());
    return verdict.internal ? verdict : PUBLIC;
  }
  // :: unspecified (all zero).
  if (b.every((x) => x === 0)) return { internal: true, reason: "ipv6_unspecified" };
  // fe80::/10 link-local: first 10 bits == 1111111010.
  if (at(0) === 0xfe && (at(1) & 0xc0) === 0x80) return { internal: true, reason: "ipv6_link_local" };
  // fc00::/7 ULA: top 7 bits == 1111110.
  if ((at(0) & 0xfe) === 0xfc) return { internal: true, reason: "ipv6_ula" };
  return PUBLIC;
}

/**
 * Classify an IP literal (as returned by DNS resolution). Unparseable input is
 * treated as INTERNAL (fail-closed) — the guard must never let an address it
 * cannot reason about reach the network.
 */
export function classifyIp(ip: string): IpVerdict {
  const trimmed = ip.trim();
  const v4 = parseIpv4(trimmed);
  if (v4 !== undefined) return classifyIpv4Int(v4);
  const v6 = parseIpv6(trimmed);
  if (v6 !== undefined) return classifyIpv6Bytes(v6);
  return { internal: true, reason: "unparseable" };
}

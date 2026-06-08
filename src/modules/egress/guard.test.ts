import assert from "node:assert/strict";
import { test } from "node:test";

import { ProviderError } from "../../core/provider/contract.js";
import type { FetchLike } from "../../core/provider/providers/openai-compatible.js";
import { events } from "../../core/events/index.js";
import { moduleEnv } from "../../core/module-config.js";
import { createGuardedFetch } from "./guard.js";
import { DEFAULT_EGRESS_HOSTS, loadEgressConfig, parseLocalEndpoint } from "./config.js";
import { egressBlocked, type EgressBlockedPayload, type EgressLocalAllowedPayload } from "./events.js";

const okResponse = {
  ok: true,
  status: 200,
  json: async () => ({ ok: true }),
  text: async () => "ok",
};

/** A transport that records whether it was reached, and the URL it saw. */
function recordingTransport(): { transport: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const transport: FetchLike = async (input) => {
    calls.push(input);
    return okResponse;
  };
  return { transport, calls };
}

/** Build a guard with captured block + local-allowed events + a fixed DNS answer. */
function harness(opts: {
  allowlist?: string[];
  localEndpoints?: string[];
  resolve?: (host: string) => Promise<string[]>;
}) {
  const blocked: EgressBlockedPayload[] = [];
  const localAllowed: EgressLocalAllowedPayload[] = [];
  const { transport, calls } = recordingTransport();
  const guard = createGuardedFetch({
    allowlist: opts.allowlist ?? ["api.example.com"],
    localEndpoints: opts.localEndpoints ?? [], // DEFAULT: no local access
    resolve: opts.resolve ?? (async () => ["93.184.216.34"]), // a public IP
    transport,
    publishBlocked: (p) => blocked.push(p),
    publishLocalAllowed: (p) => localAllowed.push(p),
  });
  return { guard, blocked, localAllowed, calls };
}

const init = { method: "GET", headers: {}, body: "", signal: new AbortController().signal };

test("a permitted host resolving to a public IP passes through to the transport", async () => {
  const { guard, blocked, calls } = harness({ allowlist: ["api.example.com"] });
  const res = await guard("https://api.example.com/v1/chat", init);
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["https://api.example.com/v1/chat"], "transport reached exactly once");
  assert.equal(blocked.length, 0);
});

test("non-http(s) schemes are rejected (network ProviderError + egress.blocked)", async () => {
  const { guard, blocked, calls } = harness({ allowlist: ["api.example.com"] });
  await assert.rejects(
    () => guard("ftp://api.example.com/x", init),
    (e: unknown) => e instanceof ProviderError && e.kind === "network" && e.retriable === false,
  );
  assert.equal(calls.length, 0, "transport never reached");
  assert.equal(blocked.at(-1)?.reason, "scheme");
});

test("an unparseable URL is rejected", async () => {
  const { guard, blocked } = harness({});
  await assert.rejects(() => guard("http://[bad", init), (e: unknown) => e instanceof ProviderError);
  assert.equal(blocked.at(-1)?.reason, "invalid_url");
});

test("default-deny: an empty allowlist blocks everything", async () => {
  const { guard, blocked, calls } = harness({ allowlist: [] });
  await assert.rejects(() => guard("https://api.example.com/x", init), (e: unknown) => e instanceof ProviderError);
  assert.equal(calls.length, 0);
  assert.equal(blocked.at(-1)?.reason, "not_allowlisted");
});

test("a host not on the allowlist is blocked (allowlist is exact-match)", async () => {
  const { guard, blocked } = harness({ allowlist: ["api.example.com"] });
  await assert.rejects(() => guard("https://evil.test/x", init), (e: unknown) => e instanceof ProviderError);
  assert.equal(blocked.at(-1)?.reason, "not_allowlisted");
});

test("allowlist match is case-insensitive", async () => {
  const { guard, calls } = harness({ allowlist: ["api.example.com"] });
  await guard("https://API.EXAMPLE.COM/x", init);
  assert.equal(calls.length, 1);
});

// Each internal range: an allowlisted host that RESOLVES to an internal IP is blocked.
for (const [label, ip] of [
  ["RFC1918 10/8", "10.1.2.3"],
  ["RFC1918 172.16/12", "172.16.5.5"],
  ["RFC1918 192.168/16", "192.168.0.10"],
  ["loopback 127/8", "127.0.0.1"],
  ["link-local 169.254/16", "169.254.10.10"],
  ["cloud metadata", "169.254.169.254"],
  ["this-network 0.0.0.0", "0.0.0.0"],
  ["IPv6 loopback ::1", "::1"],
  ["IPv6 link-local fe80::", "fe80::1"],
  ["IPv6 ULA fc00::", "fc00::1"],
  ["IPv4-mapped internal", "::ffff:10.0.0.1"],
] as const) {
  test(`internal IP rejected: ${label} (${ip})`, async () => {
    const { guard, blocked, calls } = harness({
      allowlist: ["api.example.com"],
      resolve: async () => [ip],
    });
    await assert.rejects(
      () => guard("https://api.example.com/x", init),
      (e: unknown) => e instanceof ProviderError && e.kind === "network",
    );
    assert.equal(calls.length, 0, "transport never reached for an internal IP");
    assert.equal(blocked.at(-1)?.reason, "internal_ip");
    assert.match(blocked.at(-1)?.detail ?? "", new RegExp(ip.replace(/[.[\]]/g, "\\$&")));
  });
}

test("DNS-rebinding defense: ANY internal IP among the answers blocks the call", async () => {
  const { guard, blocked, calls } = harness({
    allowlist: ["api.example.com"],
    resolve: async () => ["93.184.216.34", "10.0.0.5"], // one public, one internal
  });
  await assert.rejects(() => guard("https://api.example.com/x", init), (e: unknown) => e instanceof ProviderError);
  assert.equal(calls.length, 0);
  assert.equal(blocked.at(-1)?.reason, "internal_ip");
});

test("a DNS failure fails closed", async () => {
  const { guard, blocked } = harness({
    allowlist: ["api.example.com"],
    resolve: async () => {
      throw new Error("ENOTFOUND");
    },
  });
  await assert.rejects(() => guard("https://api.example.com/x", init), (e: unknown) => e instanceof ProviderError);
  assert.equal(blocked.at(-1)?.reason, "dns_failure");
});

test("an empty DNS answer fails closed", async () => {
  const { guard, blocked } = harness({ allowlist: ["api.example.com"], resolve: async () => [] });
  await assert.rejects(() => guard("https://api.example.com/x", init), (e: unknown) => e instanceof ProviderError);
  assert.equal(blocked.at(-1)?.reason, "dns_empty");
});

test("egress.blocked publishes a namespaced event on the real bus", async () => {
  const seen: EgressBlockedPayload[] = [];
  const sub = events.subscribe<EgressBlockedPayload>({ types: ["egress.blocked"] }, (e) => {
    seen.push(e.payload);
  });
  // Use the DEFAULT publish path (real bus), only overriding allowlist/resolve/transport.
  const guard = createGuardedFetch({
    allowlist: ["api.example.com"],
    localEndpoints: [],
    resolve: async () => ["169.254.169.254"],
    transport: async () => okResponse,
  });
  await assert.rejects(() => guard("https://api.example.com/x", init), (e: unknown) => e instanceof ProviderError);
  await events.flush();
  sub.unsubscribe();

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.reason, "internal_ip");
  assert.equal(seen[0]?.host, "api.example.com");
  assert.ok(egressBlocked.is({ type: "egress.blocked" } as never), "event type is namespaced egress.blocked");
});

// ── EXACT-MATCH LOCAL-ENDPOINT ALLOWLIST (3-eyes SSRF exception) ──────────────

const LOCAL = "127.0.0.1";

test("LOCAL ALLOWED (headline): an exact-match host:port internal endpoint is permitted + logged", async () => {
  const { guard, blocked, localAllowed, calls } = harness({
    allowlist: [LOCAL], // Layer 1: host allowlisted
    localEndpoints: ["127.0.0.1:11434"], // Layer 2 exception: exact host:port
    resolve: async () => [LOCAL], // resolves to a loopback IP (internal)
  });
  const res = await guard("http://127.0.0.1:11434/v1/chat/completions", init);
  assert.equal(res.status, 200, "the local Ollama endpoint was reached");
  assert.deepEqual(calls, ["http://127.0.0.1:11434/v1/chat/completions"], "transport reached exactly once");
  assert.equal(blocked.length, 0, "NOT blocked");
  // The positive audit event fired, carrying the RESOLVED IP the gate keyed on.
  assert.equal(localAllowed.length, 1, "egress.local_allowed published");
  assert.equal(localAllowed[0]?.host, "127.0.0.1");
  assert.equal(localAllowed[0]?.resolvedIp, "127.0.0.1", "the allow decision is on the resolved IP");
  assert.equal(localAllowed[0]?.port, 11434);
  assert.match(localAllowed[0]?.reason ?? "", /loopback/);
});

test("EXACT MATCH ONLY: a near-miss port or host is STILL blocked (the exception is not broad)", async () => {
  // Opted in: 127.0.0.1:11434 only.
  const mk = (host: string) => harness({ allowlist: [host], localEndpoints: ["127.0.0.1:11434"], resolve: async () => [host] });

  // Different PORT on the same host → blocked.
  const p = mk("127.0.0.1");
  await assert.rejects(() => p.guard("http://127.0.0.1:11435/x", init), (e: unknown) => e instanceof ProviderError);
  assert.equal(p.blocked.at(-1)?.reason, "internal_ip", "127.0.0.1:11435 is NOT the opted-in port");
  assert.equal(p.localAllowed.length, 0);
  assert.equal(p.calls.length, 0);

  // Different HOST (another loopback IP) on the same port → blocked.
  const h = mk("127.0.0.2");
  await assert.rejects(() => h.guard("http://127.0.0.2:11434/x", init), (e: unknown) => e instanceof ProviderError);
  assert.equal(h.blocked.at(-1)?.reason, "internal_ip", "127.0.0.2:11434 is NOT the opted-in host");
  assert.equal(h.localAllowed.length, 0);

  // Same host:port, ANY path → allowed (exact match is host:port, path-independent).
  const ok = mk("127.0.0.1");
  const res = await ok.guard("http://127.0.0.1:11434/v1/models", init);
  assert.equal(res.status, 200);
  assert.equal(ok.localAllowed.length, 1);
});

test("DEFAULT DENY: with NO local opt-in, a loopback endpoint is blocked exactly as today", async () => {
  const { guard, blocked, localAllowed, calls } = harness({
    allowlist: [LOCAL],
    localEndpoints: [], // default — no local access
    resolve: async () => [LOCAL],
  });
  await assert.rejects(() => guard("http://127.0.0.1:11434/x", init), (e: unknown) => e instanceof ProviderError);
  assert.equal(blocked.at(-1)?.reason, "internal_ip", "the floor is unchanged without an opt-in");
  assert.equal(localAllowed.length, 0, "no allowance without IKBI_EGRESS_ALLOW_LOCAL");
  assert.equal(calls.length, 0);
});

test("LAYER 1 STILL APPLIES: a local endpoint opted into ALLOW_LOCAL but NOT host-allowlisted is blocked at Layer 1", async () => {
  const { guard, blocked, localAllowed, calls } = harness({
    allowlist: [], // host NOT allowlisted
    localEndpoints: ["127.0.0.1:11434"], // opted into the local exception only
    resolve: async () => [LOCAL],
  });
  await assert.rejects(() => guard("http://127.0.0.1:11434/x", init), (e: unknown) => e instanceof ProviderError);
  assert.equal(blocked.at(-1)?.reason, "not_allowlisted", "Layer 1 blocks before the IP layer — both gates required");
  assert.equal(localAllowed.length, 0, "the local exception never reached (host gate failed first)");
  assert.equal(calls.length, 0);
});

// ── SSRF FLOOR INTACT FOR EVERYTHING ELSE (critical regression) ──────────────

test("SSRF floor intact: with a local opt-in active, OTHER internal destinations are STILL blocked", async () => {
  // Operator opted in 127.0.0.1:11434, but an allowlisted PUBLIC host rebinds to internal.
  const local = ["127.0.0.1:11434"];

  // Cloud metadata via a rebinding public host → STILL blocked (not the opted-in endpoint).
  const meta = harness({ allowlist: ["api.example.com"], localEndpoints: local, resolve: async () => ["169.254.169.254"] });
  await assert.rejects(() => meta.guard("https://api.example.com/x", init), (e: unknown) => e instanceof ProviderError);
  assert.equal(meta.blocked.at(-1)?.reason, "internal_ip", "cloud metadata is still blocked despite a local opt-in");
  assert.equal(meta.localAllowed.length, 0);
  assert.equal(meta.calls.length, 0);

  // An RFC1918 address (different host:port than the opt-in) → STILL blocked.
  const rfc = harness({ allowlist: ["api.example.com"], localEndpoints: local, resolve: async () => ["10.0.0.5"] });
  await assert.rejects(() => rfc.guard("https://api.example.com/x", init), (e: unknown) => e instanceof ProviderError);
  assert.equal(rfc.blocked.at(-1)?.reason, "internal_ip", "RFC1918 is still blocked");

  // DNS-rebind: even the opted-in host:port, if it resolves to a DIFFERENT internal IP, is
  // allowed ONLY because the operator named THIS host:port — but a public allowlisted host
  // resolving to the metadata IP is NOT the opted-in endpoint and stays blocked (above).
  // And the metadata IP itself, were it the host, is not opted in:
  const direct = harness({ allowlist: ["169.254.169.254"], localEndpoints: local, resolve: async () => ["169.254.169.254"] });
  await assert.rejects(() => direct.guard("http://169.254.169.254/latest/meta-data", init), (e: unknown) => e instanceof ProviderError);
  assert.equal(direct.blocked.at(-1)?.reason, "internal_ip", "the metadata host:port is NOT in ALLOW_LOCAL → still blocked");
  assert.equal(direct.localAllowed.length, 0);
});

// ── RESOLVED-IP MATCHING (Codex NO-SHIP fix — the hostname-resolution gap) ────

test("CODEX BYPASS now BLOCKED: an opted-in IP, but a HOST that resolves to cloud metadata → blocked", async () => {
  // The exact crafted bypass: ALLOW_LOCAL=127.0.0.1:11434, host "ollama.local" → metadata IP.
  const { guard, blocked, localAllowed, calls } = harness({
    allowlist: ["ollama.local"], // Layer 1 passes (host is allowlisted)
    localEndpoints: ["127.0.0.1:11434"], // opt-in is the loopback IP, NOT the name
    resolve: async () => ["169.254.169.254"], // the name resolves to cloud metadata
  });
  await assert.rejects(() => guard("http://ollama.local:11434/latest/meta-data", init), (e: unknown) => e instanceof ProviderError);
  assert.equal(blocked.at(-1)?.reason, "internal_ip", "the RESOLVED metadata IP is not the opted-in IP → blocked");
  assert.match(blocked.at(-1)?.detail ?? "", /169\.254\.169\.254/, "the block names the resolved IP, not the hostname");
  assert.equal(localAllowed.length, 0, "no allowance — the name does not bless the metadata IP");
  assert.equal(calls.length, 0, "transport never reached");
});

test("RESOLVED-IP MATCH (legit): an IP-literal host that resolves to itself is allowed, logged with the resolved IP", async () => {
  const { guard, localAllowed, calls } = harness({
    allowlist: ["127.0.0.1"],
    localEndpoints: ["127.0.0.1:11434"],
    resolve: async () => ["127.0.0.1"], // a literal IP resolves to itself
  });
  const res = await guard("http://127.0.0.1:11434/v1/models", init);
  assert.equal(res.status, 200, "the legit local Ollama path still works");
  assert.equal(calls.length, 1);
  assert.equal(localAllowed[0]?.resolvedIp, "127.0.0.1");
});

test("HOSTNAME resolving to a DIFFERENT internal IP → blocked (the resolved IP decides, not the name)", async () => {
  const { guard, blocked, localAllowed } = harness({
    allowlist: ["ollama.local"],
    localEndpoints: ["127.0.0.1:11434"], // opted in 127.0.0.1 only
    resolve: async () => ["10.0.0.5"], // resolves to an RFC1918 host, not the opt-in
  });
  await assert.rejects(() => guard("http://ollama.local:11434/x", init), (e: unknown) => e instanceof ProviderError);
  assert.equal(blocked.at(-1)?.reason, "internal_ip", "10.0.0.5:11434 ≠ 127.0.0.1:11434");
  assert.equal(localAllowed.length, 0);
});

test("MULTI-IP REBIND blocked: a host resolving to [opted-in IP, metadata IP] blocks the WHOLE request", async () => {
  const { guard, blocked, localAllowed, calls } = harness({
    allowlist: ["ollama.local"],
    localEndpoints: ["127.0.0.1:11434"],
    // One answer IS the opted-in IP, the other is cloud metadata — must NOT allow.
    resolve: async () => ["127.0.0.1", "169.254.169.254"],
  });
  await assert.rejects(() => guard("http://ollama.local:11434/x", init), (e: unknown) => e instanceof ProviderError);
  assert.equal(blocked.at(-1)?.reason, "internal_ip", "the un-opted metadata IP blocks even though 127.0.0.1 matched");
  assert.match(blocked.at(-1)?.detail ?? "", /169\.254\.169\.254/);
  assert.equal(localAllowed.length, 0, "one allowed IP never blesses the rebind");
  assert.equal(calls.length, 0);
});

// ── CONFIG: ALLOW_LOCAL takes IP-LITERALS only (a hostname is rejected at load) ──

test("ALLOW_LOCAL config REJECTS a hostname entry (it could resolve anywhere — the gap)", () => {
  // A hostname is invalid for ALLOW_LOCAL — reject LOUD at load.
  assert.throws(() => parseLocalEndpoint("ollama.local:11434"), /not an IP literal/);
  // An IP-literal is accepted and canonicalized to ip:port.
  assert.equal(parseLocalEndpoint("127.0.0.1:11434"), "127.0.0.1:11434");
  assert.equal(parseLocalEndpoint("[::1]:11434"), "::1:11434", "bracketed IPv6 is accepted");
  // Malformed entries (no port / bad port) are rejected too.
  assert.throws(() => parseLocalEndpoint("127.0.0.1"), /not "ip:port"/);
  assert.throws(() => parseLocalEndpoint("127.0.0.1:99999"), /invalid port/);

  // loadEgressConfig surfaces the rejection from a reader supplying a hostname entry.
  const reader = { list: (k: string) => (k === "ALLOW_LOCAL" ? ["ollama.local:11434"] : []) } as unknown as Parameters<typeof loadEgressConfig>[0];
  assert.throws(() => loadEgressConfig(reader), /not an IP literal/);

  // A reader supplying an IP-literal loads cleanly.
  const okReader = { list: (k: string) => (k === "ALLOW_LOCAL" ? ["127.0.0.1:11434"] : k === "ALLOWLIST" ? ["127.0.0.1"] : []) } as unknown as Parameters<typeof loadEgressConfig>[0];
  assert.deepEqual(loadEgressConfig(okReader).localEndpoints, ["127.0.0.1:11434"]);
});

test("ALLOWLIST default: unset ⇒ the default host set; set ⇒ the operator list replaces it", () => {
  // UNSET (empty env): the default allowlist applies so the web tools work out of the box.
  const def = loadEgressConfig(moduleEnv("egress", {}));
  assert.deepEqual(def.allowlist, [...DEFAULT_EGRESS_HOSTS], "unset ⇒ default hosts");
  assert.ok(def.allowlist.includes("html.duckduckgo.com"), "web-search host is default-allowed");
  assert.ok(def.allowlist.includes("stackoverflow.com"), "doc host is default-allowed");

  // SET: the operator's list REPLACES the default entirely (lowercased, exact match).
  const restricted = loadEgressConfig(moduleEnv("egress", { IKBI_EGRESS_ALLOWLIST: "Internal.Corp" }));
  assert.deepEqual(restricted.allowlist, ["internal.corp"], "set ⇒ operator list replaces default");
});

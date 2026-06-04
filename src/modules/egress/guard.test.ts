import assert from "node:assert/strict";
import { test } from "node:test";

import { ProviderError } from "../../core/provider/contract.js";
import type { FetchLike } from "../../core/provider/providers/openai-compatible.js";
import { events } from "../../core/events/index.js";
import { createGuardedFetch } from "./guard.js";
import { egressBlocked, type EgressBlockedPayload } from "./events.js";

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

/** Build a guard with captured block events + a fixed DNS answer. */
function harness(opts: {
  allowlist?: string[];
  resolve?: (host: string) => Promise<string[]>;
}) {
  const blocked: EgressBlockedPayload[] = [];
  const { transport, calls } = recordingTransport();
  const guard = createGuardedFetch({
    allowlist: opts.allowlist ?? ["api.example.com"],
    resolve: opts.resolve ?? (async () => ["93.184.216.34"]), // a public IP
    transport,
    publishBlocked: (p) => blocked.push(p),
  });
  return { guard, blocked, calls };
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

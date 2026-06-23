/**
 * ikbi MCP OAuth tests — device-code flow, polling/back-off, refresh, expiry, PKCE, token store.
 * No real network: a scripted FetchLike double drives the OAuth endpoints; sleep/now are injected.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FetchLike } from "../../../core/provider/providers/openai-compatible.js";
import {
  TokenStore,
  authorizationHeader,
  deviceCodeFlow,
  generatePkce,
  getValidAccessToken,
  isExpired,
  pollDeviceToken,
  refreshAccessToken,
  startDeviceAuthorization,
  type OAuthServerConfig,
  type StoredToken,
} from "./oauth.js";

const CFG: OAuthServerConfig = {
  name: "remote",
  clientId: "client-123",
  deviceAuthorizationEndpoint: "https://auth.example.com/device",
  tokenEndpoint: "https://auth.example.com/token",
  scopes: ["mcp.read", "mcp.write"],
};

/** Build a FetchLike that routes by URL; `handler` returns {ok,status,body}. Records calls. */
function mockFetch(handler: (url: string, params: Record<string, string>) => { ok: boolean; status: number; body: Record<string, unknown> }): { fetch: FetchLike; calls: Array<{ url: string; params: Record<string, string> }> } {
  const calls: Array<{ url: string; params: Record<string, string> }> = [];
  const fetch: FetchLike = async (url, init) => {
    const params = Object.fromEntries(new URLSearchParams(init.body));
    calls.push({ url, params });
    const { ok, status, body } = handler(url, params);
    return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls };
}

const noSleep = async (): Promise<void> => {};
function tmpStore(): TokenStore {
  return new TokenStore(mkdtempSync(join(tmpdir(), "ikbi-oauth-")));
}

test("generatePkce: S256 challenge derives from the verifier", () => {
  const a = generatePkce(() => Buffer.from("0123456789abcdef0123456789abcdef"));
  assert.equal(a.method, "S256");
  assert.ok(a.verifier.length > 0);
  // base64url: no +, /, or = padding
  assert.doesNotMatch(a.challenge, /[+/=]/);
  // deterministic for a fixed verifier input
  const b = generatePkce(() => Buffer.from("0123456789abcdef0123456789abcdef"));
  assert.equal(a.challenge, b.challenge);
});

test("startDeviceAuthorization: parses the device response", async () => {
  const { fetch, calls } = mockFetch(() => ({ ok: true, status: 200, body: { device_code: "dc", user_code: "WXYZ-1234", verification_uri: "https://x/v", expires_in: 600, interval: 5 } }));
  const auth = await startDeviceAuthorization(CFG, { fetch });
  assert.equal(auth.deviceCode, "dc");
  assert.equal(auth.userCode, "WXYZ-1234");
  assert.equal(auth.interval, 5);
  assert.equal(calls[0]?.params.client_id, "client-123");
  assert.equal(calls[0]?.params.scope, "mcp.read mcp.write");
});

test("pollDeviceToken: pending → success", async () => {
  let polls = 0;
  const { fetch } = mockFetch((url) => {
    if (url.endsWith("/token")) {
      polls += 1;
      if (polls < 3) return { ok: false, status: 400, body: { error: "authorization_pending" } };
      return { ok: true, status: 200, body: { access_token: "AT", refresh_token: "RT", token_type: "Bearer", expires_in: 3600 } };
    }
    return { ok: false, status: 404, body: {} };
  });
  const token = await pollDeviceToken(CFG, { deviceCode: "dc", userCode: "u", verificationUri: "v", expiresIn: 600, interval: 1 }, { fetch, sleep: noSleep, now: () => 1000 });
  assert.equal(token.accessToken, "AT");
  assert.equal(token.refreshToken, "RT");
  assert.equal(token.expiresAt, 1000 + 3600 * 1000);
  assert.equal(polls, 3);
});

test("pollDeviceToken: access_denied is terminal", async () => {
  const { fetch } = mockFetch(() => ({ ok: false, status: 400, body: { error: "access_denied" } }));
  await assert.rejects(
    () => pollDeviceToken(CFG, { deviceCode: "dc", userCode: "u", verificationUri: "v", expiresIn: 600, interval: 1 }, { fetch, sleep: noSleep, now: () => 1000 }),
    /access_denied/,
  );
});

test("pollDeviceToken: expires when the deadline passes", async () => {
  const { fetch } = mockFetch(() => ({ ok: false, status: 400, body: { error: "authorization_pending" } }));
  let t = 0;
  const now = () => { t += 1_000_000; return t; }; // each call jumps far past the deadline
  await assert.rejects(
    () => pollDeviceToken(CFG, { deviceCode: "dc", userCode: "u", verificationUri: "v", expiresIn: 1, interval: 1 }, { fetch, sleep: noSleep, now }),
    /expired/,
  );
});

test("deviceCodeFlow: stores the token + fires the prompt", async () => {
  const { fetch } = mockFetch((url) => {
    if (url.endsWith("/device")) return { ok: true, status: 200, body: { device_code: "dc", user_code: "CODE", verification_uri: "https://x/v", expires_in: 600, interval: 1 } };
    return { ok: true, status: 200, body: { access_token: "AT", refresh_token: "RT", token_type: "Bearer", expires_in: 3600 } };
  });
  const store = tmpStore();
  let prompted = "";
  const token = await deviceCodeFlow(CFG, (a) => { prompted = a.userCode; }, { fetch, sleep: noSleep, now: () => 1000, store });
  assert.equal(prompted, "CODE");
  assert.equal(token.accessToken, "AT");
  assert.equal(store.get("remote")?.accessToken, "AT");
});

test("refreshAccessToken: exchanges refresh_token, keeps old when server omits a new one", async () => {
  const { fetch, calls } = mockFetch(() => ({ ok: true, status: 200, body: { access_token: "AT2", token_type: "Bearer", expires_in: 100 } }));
  const stored: StoredToken = { accessToken: "AT1", refreshToken: "RT1", tokenType: "Bearer", expiresAt: 0, obtainedAt: 0 };
  const refreshed = await refreshAccessToken(CFG, stored, { fetch, now: () => 5000 });
  assert.equal(refreshed.accessToken, "AT2");
  assert.equal(refreshed.refreshToken, "RT1"); // preserved
  assert.equal(calls[0]?.params.grant_type, "refresh_token");
});

test("isExpired: respects the skew window", () => {
  const tok: StoredToken = { accessToken: "x", tokenType: "Bearer", expiresAt: 100_000, obtainedAt: 0 };
  assert.equal(isExpired(tok, 30_000), false);
  assert.equal(isExpired(tok, 50_000), true); // within 60s skew of 100s
  const noExp: StoredToken = { accessToken: "x", tokenType: "Bearer", obtainedAt: 0 };
  assert.equal(isExpired(noExp, 10 ** 12), false);
});

test("getValidAccessToken: returns a fresh token directly", async () => {
  const store = tmpStore();
  await store.put("remote", { accessToken: "AT", tokenType: "Bearer", expiresAt: 10 ** 12, obtainedAt: 0 });
  const tok = await getValidAccessToken(CFG, { store, now: () => 1000 });
  assert.equal(tok, "AT");
});

test("getValidAccessToken: auto-refreshes an expired token and persists it", async () => {
  const store = tmpStore();
  await store.put("remote", { accessToken: "OLD", refreshToken: "RT", tokenType: "Bearer", expiresAt: 2000, obtainedAt: 0 });
  const { fetch } = mockFetch(() => ({ ok: true, status: 200, body: { access_token: "NEW", refresh_token: "RT2", token_type: "Bearer", expires_in: 3600 } }));
  const tok = await getValidAccessToken(CFG, { store, fetch, now: () => 5000 });
  assert.equal(tok, "NEW");
  assert.equal(store.get("remote")?.accessToken, "NEW");
  assert.equal(store.get("remote")?.refreshToken, "RT2");
});

test("getValidAccessToken: expired + no refresh token → clears and returns undefined", async () => {
  const store = tmpStore();
  await store.put("remote", { accessToken: "OLD", tokenType: "Bearer", expiresAt: 2000, obtainedAt: 0 });
  const tok = await getValidAccessToken(CFG, { store, now: () => 5000 });
  assert.equal(tok, undefined);
  assert.equal(store.has("remote"), false);
});

test("getValidAccessToken: failed refresh clears the token (fail-closed)", async () => {
  const store = tmpStore();
  await store.put("remote", { accessToken: "OLD", refreshToken: "RT", tokenType: "Bearer", expiresAt: 2000, obtainedAt: 0 });
  const { fetch } = mockFetch(() => ({ ok: false, status: 400, body: { error: "invalid_grant" } }));
  const tok = await getValidAccessToken(CFG, { store, fetch, now: () => 5000 });
  assert.equal(tok, undefined);
  assert.equal(store.has("remote"), false);
});

test("authorizationHeader: builds a Bearer header (or empty when no token)", async () => {
  const store = tmpStore();
  assert.deepEqual(await authorizationHeader(CFG, { store, now: () => 1000 }), {});
  await store.put("remote", { accessToken: "AT", tokenType: "Bearer", expiresAt: 10 ** 12, obtainedAt: 0 });
  assert.deepEqual(await authorizationHeader(CFG, { store, now: () => 1000 }), { Authorization: "Bearer AT" });
});

test("TokenStore: round-trips and deletes", async () => {
  const store = tmpStore();
  assert.equal(store.has("remote"), false);
  await store.put("remote", { accessToken: "AT", tokenType: "Bearer", obtainedAt: 1 });
  assert.equal(store.get("remote")?.accessToken, "AT");
  store.delete("remote");
  assert.equal(store.get("remote"), undefined);
});

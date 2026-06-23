/**
 * ikbi `mcp auth` CLI tests — list / status / logout / authorize, with injected flow + store.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpOAuthConfig } from "../modules/mcp-model-loop/config.js";
import { TokenStore, type DeviceAuthorization, type OAuthServerConfig, type StoredToken } from "../modules/mcp-model-loop/transports/oauth.js";
import { createMcpAuthCli } from "./mcp-auth.js";

function capture() {
  let out = "";
  let err = "";
  let exit: number | undefined;
  return {
    stdout: (s: string) => void (out += s),
    stderr: (s: string) => void (err += s),
    setExit: (c: number) => void (exit = c),
    get out() { return out; },
    get err() { return err; },
    get exit() { return exit; },
  };
}

const CONFIGS: readonly McpOAuthConfig[] = [
  { name: "remote", clientId: "c1", deviceAuthorizationEndpoint: "https://a/d", tokenEndpoint: "https://a/t", scopes: ["mcp"] },
];

function tmpStore(): TokenStore {
  return new TokenStore(mkdtempSync(join(tmpdir(), "ikbi-mcpauth-")));
}

test("list: shows configured servers + authorization state", async () => {
  const cap = capture();
  const store = tmpStore();
  await createMcpAuthCli({ ...cap, configs: CONFIGS, store }).run(["list"]);
  assert.match(cap.out, /remote — not authorized/);
});

test("list: empty config prints guidance", async () => {
  const cap = capture();
  await createMcpAuthCli({ ...cap, configs: [], store: tmpStore() }).run(["list"]);
  assert.match(cap.out, /No OAuth MCP servers configured/);
});

test("authorize: runs the flow, prints the prompt, and reports success", async () => {
  const cap = capture();
  const store = tmpStore();
  let promptedCode = "";
  const fakeFlow = async (cfg: OAuthServerConfig, onPrompt: (a: DeviceAuthorization) => void): Promise<StoredToken> => {
    onPrompt({ deviceCode: "dc", userCode: "ABCD-1234", verificationUri: "https://a/verify", expiresIn: 600, interval: 5 });
    const token: StoredToken = { accessToken: "AT", refreshToken: "RT", tokenType: "Bearer", obtainedAt: 1 };
    await store.put(cfg.name, token);
    return token;
  };
  await createMcpAuthCli({ ...cap, configs: CONFIGS, store, deviceCodeFlow: fakeFlow }).run(["remote"]);
  void promptedCode;
  assert.match(cap.out, /ABCD-1234/);
  assert.match(cap.out, /Authorized "remote"/);
  assert.equal(store.get("remote")?.accessToken, "AT");
});

test("authorize: unknown server exits 1", async () => {
  const cap = capture();
  await createMcpAuthCli({ ...cap, configs: CONFIGS, store: tmpStore(), deviceCodeFlow: async () => { throw new Error("should not run"); } }).run(["ghost"]);
  assert.equal(cap.exit, 1);
  assert.match(cap.err, /no OAuth server "ghost"/);
});

test("authorize: a flow failure exits 1 with the reason", async () => {
  const cap = capture();
  await createMcpAuthCli({ ...cap, configs: CONFIGS, store: tmpStore(), deviceCodeFlow: async () => { throw new Error("device code expired"); } }).run(["remote"]);
  assert.equal(cap.exit, 1);
  assert.match(cap.err, /authorization failed: device code expired/);
});

test("status: reports stored token state", async () => {
  const cap = capture();
  const store = tmpStore();
  await store.put("remote", { accessToken: "AT", refreshToken: "RT", tokenType: "Bearer", expiresAt: 10 ** 12, obtainedAt: 0 });
  await createMcpAuthCli({ ...cap, configs: CONFIGS, store, now: () => 1000 }).run(["status", "remote"]);
  assert.match(cap.out, /remote: authorized \(Bearer, expires in .*refreshable\)/);
});

test("status: not authorized when no token", async () => {
  const cap = capture();
  await createMcpAuthCli({ ...cap, configs: CONFIGS, store: tmpStore() }).run(["status", "remote"]);
  assert.match(cap.out, /not authorized/);
});

test("logout: clears the stored token", async () => {
  const cap = capture();
  const store = tmpStore();
  await store.put("remote", { accessToken: "AT", tokenType: "Bearer", obtainedAt: 0 });
  await createMcpAuthCli({ ...cap, configs: CONFIGS, store }).run(["logout", "remote"]);
  assert.match(cap.out, /stored token cleared/);
  assert.equal(store.has("remote"), false);
});

test("no args prints usage", async () => {
  const cap = capture();
  await createMcpAuthCli({ ...cap, configs: CONFIGS, store: tmpStore() }).run([]);
  assert.match(cap.out, /Usage: ikbi mcp auth/);
});

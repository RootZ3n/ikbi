import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "./config.js";

const DEV_ENV = { IKBI_ALLOW_INSECURE_DEV_KEYS: "true" } as const;

test("defaults: loopback bind on default port", () => {
  const cfg = loadConfig(DEV_ENV);
  assert.equal(cfg.port, 18796);
  assert.equal(cfg.bindHost, "127.0.0.1");
  assert.equal(cfg.allowPublicBind, false);
  assert.ok(cfg.stateRoot.endsWith("state"));
});

test("mimo base URL defaults to the real direct-API endpoint (api.xiaomimimo.com), overridable", () => {
  assert.equal(loadConfig(DEV_ENV).provider.mimo.baseUrl, "https://api.xiaomimimo.com/v1");
  assert.equal(loadConfig({ ...DEV_ENV, IKBI_MIMO_BASE_URL: "https://custom/v1" }).provider.mimo.baseUrl, "https://custom/v1");
});

test("IKBI_PORT is parsed and validated", () => {
  assert.equal(loadConfig({ ...DEV_ENV, IKBI_PORT: "3000" }).port, 3000);
  assert.throws(() => loadConfig({ ...DEV_ENV, IKBI_PORT: "not-a-port" }));
  assert.throws(() => loadConfig({ ...DEV_ENV, IKBI_PORT: "99999" }));
});

test("refuses public bind without IKBI_ALLOW_PUBLIC_BIND", () => {
  assert.throws(() => loadConfig({ ...DEV_ENV, IKBI_BIND_HOST: "0.0.0.0" }));
});

test("allows public bind when explicitly opted in", () => {
  const cfg = loadConfig({ ...DEV_ENV, IKBI_BIND_HOST: "0.0.0.0", IKBI_ALLOW_PUBLIC_BIND: "true" });
  assert.equal(cfg.bindHost, "0.0.0.0");
  assert.equal(cfg.allowPublicBind, true);
});

test("explicit env does not fall back to ambient IKBI_ALLOW_INSECURE_DEV_KEYS", () => {
  const saved = process.env.IKBI_ALLOW_INSECURE_DEV_KEYS;
  process.env.IKBI_ALLOW_INSECURE_DEV_KEYS = "true";
  try {
    assert.throws(() => loadConfig({}), /Refusing to start with insecure default trust keys/);
  } finally {
    if (saved === undefined) delete process.env.IKBI_ALLOW_INSECURE_DEV_KEYS;
    else process.env.IKBI_ALLOW_INSECURE_DEV_KEYS = saved;
  }
});

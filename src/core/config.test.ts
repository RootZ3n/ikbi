import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applyDotEnv, loadConfig } from "./config.js";

const DEV_ENV = { IKBI_ALLOW_INSECURE_DEV_KEYS: "true" } as const;

test("defaults: loopback bind on default port", () => {
  const cfg = loadConfig(DEV_ENV);
  assert.equal(cfg.port, 18796);
  assert.equal(cfg.bindHost, "127.0.0.1");
  assert.equal(cfg.allowPublicBind, false);
  assert.equal(cfg.stateRoot, join(homedir(), ".ikbi", "state"));
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

test(".env value flows into config.provider.defaultModels.critic via applyDotEnv", () => {
  const env: NodeJS.ProcessEnv = { IKBI_ALLOW_INSECURE_DEV_KEYS: "true" };
  applyDotEnv("# a comment\n\nIKBI_MODEL_CRITIC=test-value\n", env);
  assert.equal(env.IKBI_MODEL_CRITIC, "test-value");
  assert.equal(loadConfig(env).provider.defaultModels.critic, "test-value");
});

test("applyDotEnv lets shell env take precedence over the .env file", () => {
  const env: NodeJS.ProcessEnv = { IKBI_MODEL_CRITIC: "from-shell" };
  applyDotEnv("IKBI_MODEL_CRITIC=from-file\n", env);
  assert.equal(env.IKBI_MODEL_CRITIC, "from-shell");
});

test("applyDotEnv skips comments, blanks, malformed lines, and strips quotes", () => {
  const env: NodeJS.ProcessEnv = {};
  applyDotEnv(['# comment', '', '  ', 'no-equals-sign', '=novalue', 'A=1', 'B="quoted"', "C='q2'"].join("\n"), env);
  assert.equal(env.A, "1");
  assert.equal(env.B, "quoted");
  assert.equal(env.C, "q2");
  assert.equal(env["no-equals-sign"], undefined);
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

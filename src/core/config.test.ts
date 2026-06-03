import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "./config.js";

test("defaults: loopback bind on default port", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.port, 18796);
  assert.equal(cfg.bindHost, "127.0.0.1");
  assert.equal(cfg.allowPublicBind, false);
  assert.ok(cfg.stateRoot.endsWith("state"));
});

test("IKBI_PORT is parsed and validated", () => {
  assert.equal(loadConfig({ IKBI_PORT: "3000" }).port, 3000);
  assert.throws(() => loadConfig({ IKBI_PORT: "not-a-port" }));
  assert.throws(() => loadConfig({ IKBI_PORT: "99999" }));
});

test("refuses public bind without IKBI_ALLOW_PUBLIC_BIND", () => {
  assert.throws(() => loadConfig({ IKBI_BIND_HOST: "0.0.0.0" }));
});

test("allows public bind when explicitly opted in", () => {
  const cfg = loadConfig({ IKBI_BIND_HOST: "0.0.0.0", IKBI_ALLOW_PUBLIC_BIND: "true" });
  assert.equal(cfg.bindHost, "0.0.0.0");
  assert.equal(cfg.allowPublicBind, true);
});

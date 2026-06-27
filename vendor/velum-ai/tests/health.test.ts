import { test } from "node:test";
import assert from "node:assert/strict";

import { velumHealthCheck } from "../src/health.js";

test("velumHealthCheck returns status ok", () => {
  const result = velumHealthCheck();
  assert.equal(result.status, "ok");
});

test("velumHealthCheck returns service velum", () => {
  const result = velumHealthCheck();
  assert.equal(result.service, "velum");
});

test("velumHealthCheck returns stable shape with version", () => {
  const result = velumHealthCheck();
  assert.equal(result.status, "ok");
  assert.equal(result.service, "velum");
  assert.equal(typeof result.version, "string");
  assert.ok(result.version.length > 0, "version should not be empty");
});

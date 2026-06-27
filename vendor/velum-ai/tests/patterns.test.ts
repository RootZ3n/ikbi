import { test } from "node:test";
import assert from "node:assert/strict";

import { createRegistry, registry, DEFAULT_NEVER_REDACT } from "../src/core/patterns.js";
import { classify } from "../src/core/classify.js";

test("default registry exposes the four pattern buckets", () => {
  assert.ok(registry.credentialPatterns.length > 0);
  assert.ok(registry.injectionPatterns.length > 0);
  assert.ok(registry.piiPatterns.length > 0);
  assert.ok(registry.policyPatterns.length > 0);
});

test("neverRedact includes Pehverse tool names", () => {
  for (const term of ["peh", "velum", "ptah", "luna", "nusika", "kokuli"]) {
    assert.ok(registry.neverRedact.has(term), `expected neverRedact to include ${term}`);
  }
  assert.ok(DEFAULT_NEVER_REDACT.includes("velum"));
});

test("getPattern finds a built-in by name", () => {
  const p = registry.getPattern("openai_key");
  assert.ok(p);
  assert.equal(p!.category, "credential");
});

test("getPattern returns undefined for unknown names", () => {
  assert.equal(registry.getPattern("does_not_exist"), undefined);
});

test("addPattern registers a custom pattern in the right bucket", () => {
  const reg = createRegistry();
  reg.addPattern({
    name: "acme_token",
    pattern: /ACME-[A-Z0-9]{10,}/g,
    category: "credential",
    severity: "block",
    description: "Acme API token",
  });
  assert.ok(reg.getPattern("acme_token"));
  assert.ok(reg.credentialPatterns.some((p) => p.name === "acme_token"));
});

test("removePattern removes a pattern", () => {
  const reg = createRegistry();
  assert.ok(reg.getPattern("openai_key"));
  reg.removePattern("openai_key");
  assert.equal(reg.getPattern("openai_key"), undefined);
});

test("custom patterns participate in classification", () => {
  const reg = createRegistry();
  reg.addPattern({
    name: "acme_token",
    pattern: /ACME-[A-Z0-9]{10,}/g,
    category: "credential",
    severity: "block",
    description: "Acme API token",
  });
  const r = classify("here is ACME-ABC1234567 for you", undefined, { registry: reg, storeInBuffer: false });
  assert.equal(r.classification, "CREDENTIAL");
  assert.ok(r.patternsMatched.includes("acme_token"));
});

test("custom registries are isolated from the default registry", () => {
  const reg = createRegistry();
  reg.removePattern("openai_key");
  // Default registry is unaffected.
  assert.ok(registry.getPattern("openai_key"));
});

test("addPattern replaces an existing pattern of the same name", () => {
  const reg = createRegistry();
  reg.addPattern({
    name: "openai_key",
    pattern: /CUSTOM-OPENAI/g,
    category: "credential",
    severity: "warn",
    description: "overridden",
  });
  const count = reg.credentialPatterns.filter((p) => p.name === "openai_key").length;
  assert.equal(count, 1);
  assert.equal(reg.getPattern("openai_key")!.severity, "warn");
});

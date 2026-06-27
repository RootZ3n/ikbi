import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  storeCredential,
  getCredential,
  consumeCredential,
  getAvailableCredentials,
  clearExpiredCredentials,
  clearAllCredentials,
  setCredentialTtl,
  DEFAULT_TTL_MS,
} from "../src/core/credential-buffer.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeEach(() => {
  clearAllCredentials();
  setCredentialTtl(DEFAULT_TTL_MS);
});
afterEach(() => setCredentialTtl(DEFAULT_TTL_MS));

test("store / get returns the live entry", () => {
  const id = storeCredential("openai_key", "sk-secret-value", "api_key=[VALUE]");
  const entry = getCredential(id);
  assert.ok(entry);
  assert.equal(entry!.value, "sk-secret-value");
  assert.equal(entry!.pattern, "openai_key");
  assert.equal(entry!.consumed, false);
});

test("consume returns the value exactly once", () => {
  const id = storeCredential("aws_access_key", "AKIA-value", "ctx");
  assert.equal(consumeCredential(id), "AKIA-value");
  assert.equal(consumeCredential(id), null);
  assert.equal(getCredential(id), null);
});

test("metadata never exposes the raw value", () => {
  storeCredential("openai_key", "sk-super-secret", "context");
  const meta = getAvailableCredentials();
  assert.equal(meta.length, 1);
  assert.ok(!JSON.stringify(meta).includes("sk-super-secret"));
  assert.equal(meta[0]!.pattern, "openai_key");
  assert.equal(meta[0]!.expired, false);
});

test("getAvailableCredentials filters by pattern", () => {
  storeCredential("openai_key", "v1", "c");
  storeCredential("aws_access_key", "v2", "c");
  assert.equal(getAvailableCredentials("openai_key").length, 1);
  assert.equal(getAvailableCredentials().length, 2);
});

test("context is truncated to 50 chars", () => {
  const id = storeCredential("p", "v", "x".repeat(200));
  assert.equal(getCredential(id)!.context.length, 50);
});

test("entries expire after their TTL", async () => {
  setCredentialTtl(30);
  const id = storeCredential("p", "v", "c");
  assert.ok(getCredential(id));
  await sleep(60);
  assert.equal(getCredential(id), null);
  assert.equal(getAvailableCredentials().length, 0);
});

test("clearExpiredCredentials evicts expired entries", async () => {
  setCredentialTtl(30);
  storeCredential("p", "v", "c");
  await sleep(60);
  clearExpiredCredentials();
  assert.equal(getAvailableCredentials().length, 0);
});

test("clearExpiredCredentials keeps live entries", () => {
  const id = storeCredential("p", "v", "c");
  clearExpiredCredentials();
  assert.ok(getCredential(id));
});

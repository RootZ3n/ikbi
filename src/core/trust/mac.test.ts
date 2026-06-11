/**
 * L5: coverage for the durable-state integrity MAC (trust/mac.ts). The MAC is what stops a
 * hand-edited or forged trust doc (e.g. `tier: "trusted"`) from being accepted at load — so
 * its round-trip and rejection behavior are security-critical and must be exercised.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { TrustState } from "./contract.js";
import { canonicalize, computeMac, verifyUnwrap, wrap, type PersistedTrustState } from "./mac.js";

const KEY = "test-mac-key";
const STATE = { agentId: "worker-1", tier: "trusted", grantedAt: 1000 } as unknown as TrustState;

test("wrap → verifyUnwrap round-trips and returns the original state", () => {
  const persisted = wrap(KEY, STATE);
  assert.ok(typeof persisted.mac === "string" && persisted.mac.length > 0, "a MAC is attached");
  const unwrapped = verifyUnwrap(KEY, persisted);
  assert.deepEqual(unwrapped, STATE, "the verified state equals the original (mac stripped)");
});

test("canonicalize is key-order independent (so the MAC does not depend on JSON property order)", () => {
  const a = canonicalize({ b: 1, a: 2, c: { y: 1, x: 2 } });
  const b = canonicalize({ a: 2, c: { x: 2, y: 1 }, b: 1 });
  assert.equal(a, b, "reordered keys canonicalize identically");
  // undefined values are dropped from the canonical form.
  assert.equal(canonicalize({ a: 1, b: undefined }), canonicalize({ a: 1 }));
});

test("a TAMPERED doc (content changed, MAC stale) is REJECTED — fail closed", () => {
  const persisted = wrap(KEY, STATE);
  // Forge a tier escalation while keeping the original MAC.
  const forged = { ...persisted, tier: "operator" } as unknown as PersistedTrustState;
  assert.equal(verifyUnwrap(KEY, forged), undefined, "the stale MAC no longer matches — rejected");
});

test("a doc verified under the WRONG key is rejected", () => {
  const persisted = wrap(KEY, STATE);
  assert.equal(verifyUnwrap("a-different-key", persisted), undefined);
});

test("a missing / empty / non-string MAC is rejected (no unsigned doc is trusted)", () => {
  assert.equal(verifyUnwrap(KEY, undefined), undefined);
  assert.equal(verifyUnwrap(KEY, { ...STATE } as unknown as PersistedTrustState), undefined, "no mac field");
  assert.equal(verifyUnwrap(KEY, { ...STATE, mac: "" } as unknown as PersistedTrustState), undefined, "empty mac");
  assert.equal(verifyUnwrap(KEY, { ...STATE, mac: 123 } as unknown as PersistedTrustState), undefined, "non-string mac");
});

test("computeMac is deterministic and key-sensitive", () => {
  assert.equal(computeMac(KEY, STATE), computeMac(KEY, STATE), "same key + state ⇒ same MAC");
  assert.notEqual(computeMac(KEY, STATE), computeMac("other-key", STATE), "a different key ⇒ a different MAC");
});

test("a malformed (non-hex) MAC does not throw — it is rejected safely", () => {
  const persisted = wrap(KEY, STATE);
  const bad = { ...persisted, mac: "zzzz-not-hex" } as unknown as PersistedTrustState;
  assert.doesNotThrow(() => verifyUnwrap(KEY, bad));
  assert.equal(verifyUnwrap(KEY, bad), undefined);
});

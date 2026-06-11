/**
 * L5: coverage for the secret-scrub used before durable cross-agent memory writes
 * (lab-context-memory/redaction.ts). A secret persisted verbatim would outlive receipts and
 * sit exposed at rest, so the scrub patterns and the recursive walk must be exercised.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { redactSecrets, REDACTION_MARKER, scrubSecrets, valueByteSize } from "./redaction.js";

test("redactSecrets scrubs distinctly-shaped credentials", () => {
  const cases = [
    "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX",
    "AKIAABCDEFGHIJKLMNOP",
    "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456",
    "xoxb-1234567890-abcdefghij",
    "Bearer abcdefghijklmnop.qrstuvwx",
  ];
  for (const secret of cases) {
    const out = redactSecrets(`prefix ${secret} suffix`);
    assert.equal(out.includes(secret), false, `the secret was redacted: ${secret}`);
    assert.match(out, new RegExp(REDACTION_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("redactSecrets scrubs a PEM private-key block", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOwIBAAJBAK...\n-----END RSA PRIVATE KEY-----";
  const out = redactSecrets(`key:\n${pem}\ndone`);
  assert.equal(out.includes("PRIVATE KEY"), false);
  assert.ok(out.includes(REDACTION_MARKER));
});

test("redactSecrets scrubs labeled inline assignments (api_key=, password:, token=)", () => {
  assert.equal(redactSecrets('api_key="supersecretvalue123"').includes("supersecretvalue123"), false);
  assert.equal(redactSecrets("password: hunter2hunter2").includes("hunter2hunter2"), false);
  assert.equal(redactSecrets("auth_token=abcdef0123456789").includes("abcdef0123456789"), false);
});

test("redactSecrets is HIGH-PRECISION: legitimate freeform notes round-trip clean", () => {
  // A 40-char commit SHA and prose must NOT be mangled (precision over recall).
  const note = "ikbi fixed the parser at commit 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
  assert.equal(redactSecrets(note), note, "no false-positive redaction of ordinary content");
});

test("scrubSecrets walks nested structures, redacting only string VALUES (keys preserved)", () => {
  const input = {
    note: "token=abcdef0123456789",
    nested: { items: ["clean text", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"] },
    count: 42,
    ok: true,
    nothing: null,
  };
  const out = scrubSecrets(input);
  const serialized = JSON.stringify(out);
  assert.equal(serialized.includes("abcdef0123456789"), false, "labeled secret scrubbed");
  assert.equal(serialized.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"), false, "token in array scrubbed");
  assert.equal(out.count, 42, "numbers pass through unchanged");
  assert.equal(out.ok, true, "booleans pass through unchanged");
  assert.equal(out.nothing, null, "null passes through unchanged");
  assert.equal(out.nested.items[0], "clean text", "clean strings are untouched");
  assert.ok("note" in out && "nested" in out, "object keys are preserved verbatim");
  // The input is not mutated (a new structure is returned).
  assert.equal(input.note, "token=abcdef0123456789", "input left intact");
});

test("valueByteSize measures serialized UTF-8 size and rejects the unserializable", () => {
  assert.equal(valueByteSize("abc"), Buffer.byteLength(JSON.stringify("abc"), "utf8"));
  assert.equal(valueByteSize({ a: 1 }), Buffer.byteLength(JSON.stringify({ a: 1 }), "utf8"));
  // A circular structure cannot be serialized ⇒ Infinity (the size-cap rejects it).
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(valueByteSize(circular), Number.POSITIVE_INFINITY);
});

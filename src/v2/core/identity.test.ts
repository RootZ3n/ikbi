/**
 * v2 identity vocabulary: ids are opaque, kind-checked, and mintable only through
 * the factory seam. These are the guardrails that stop a later slice from
 * correlating a candidate with a verification by accident.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  V2IdentityError,
  V2_ID_PREFIXES,
  contentDigest,
  createIdFactory,
  createSequentialIdFactory,
  isV2Id,
  parseV2Id,
} from "./identity.js";

test("identity: every kind mints an id carrying its own prefix", () => {
  const ids = createSequentialIdFactory("t");
  for (const kind of Object.keys(V2_ID_PREFIXES) as (keyof typeof V2_ID_PREFIXES)[]) {
    const id = ids.mint(kind);
    assert.ok(id.startsWith(`${V2_ID_PREFIXES[kind]}_`), `${kind} id "${id}" carries its prefix`);
    assert.ok(isV2Id(kind, id), `${kind} id round-trips its own guard`);
  }
});

test("identity: an id of one kind is NOT accepted as another kind", () => {
  const ids = createSequentialIdFactory("t");
  const candidate = ids.mint("candidate");
  assert.ok(isV2Id("candidate", candidate));
  assert.equal(isV2Id("verification", candidate), false, "a candidate id is not a verification id");
  assert.throws(() => parseV2Id("verification", candidate), V2IdentityError);
});

test("identity: parse rejects malformed outside-world strings (fail-closed)", () => {
  for (const bad of ["", "run", "run_", "run_short", "run_ab", "task_../escape", "task_has space"]) {
    assert.throws(() => parseV2Id("run", bad), V2IdentityError, `rejects ${JSON.stringify(bad)}`);
  }
});

test("identity: parse accepts a well-formed id and returns it branded", () => {
  const raw = "inv_0123456789abcdef";
  assert.equal(parseV2Id("invocation", raw), raw);
});

test("identity: the factory refuses to mint from a token that would be malformed", () => {
  const broken = createIdFactory(() => "no");
  assert.throws(() => broken.mint("task"), V2IdentityError, "a bad token source fails closed, never yields a junk id");
});

test("identity: minted ids are unique per call", () => {
  const ids = createIdFactory();
  const seen = new Set<string>();
  for (let i = 0; i < 64; i += 1) seen.add(ids.mint("run"));
  assert.equal(seen.size, 64);
});

// ── V2-020/Phase 16: domain separation by kind ───────────────────────────────

test("digest: the SAME value under DIFFERENT kinds yields DIFFERENT ids", () => {
  // `kind` used to be ignored, so the type parameter that was supposed to keep a candidate id and
  // a verification id apart existed only in the type system — at runtime they collided.
  const value = { a: 1, b: ["x", "y"] };
  const a = contentDigest("candidate", value);
  const b = contentDigest("verification", value);
  assert.notEqual(a, b, "the kind must be committed to, not merely declared");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.match(b, /^[0-9a-f]{64}$/);
});

test("digest: kind/value framing is UNAMBIGUOUS — no boundary-shift collision", () => {
  // Without a separator, kind "ab" + value X and kind "a" + value "b"+X would hash the same bytes.
  assert.notEqual(contentDigest("ab", "c"), contentDigest("a", "bc"));
  assert.notEqual(contentDigest("run", "xy"), contentDigest("runx", "y"));
});

test("digest: it stays deterministic and canonical within one kind", () => {
  // Key order and undefined members must not change the identity.
  assert.equal(
    contentDigest("candidate", { b: 2, a: 1, c: undefined }),
    contentDigest("candidate", { a: 1, b: 2 }),
    "canonicalization is unchanged by domain separation",
  );
  assert.equal(contentDigest("candidate", { a: 1 }), contentDigest("candidate", { a: 1 }));
});

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

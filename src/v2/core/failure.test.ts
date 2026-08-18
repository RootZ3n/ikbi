/**
 * The failure taxonomy: a stable set of top-level categories, structured data
 * instead of thrown strings, and an honest `not_implemented` category so a skeleton
 * never has to disguise itself as an internal error or a success.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RUN_FAILURE_CATEGORIES,
  V2_001_FAILURE_CODES,
  formatRunFailure,
  isRunFailureCategory,
  runFailure,
  stageNotImplemented,
} from "./failure.js";

test("failure: the top-level category set is the stable interface", () => {
  assert.deepEqual([...RUN_FAILURE_CATEGORIES], [
    "task",
    "preflight",
    "provider",
    "workspace",
    "mutation",
    "context",
    "build",
    "verification",
    "recovery",
    "resolution",
    "policy",
    "promotion",
    "internal",
    "not_implemented",
  ]);
  assert.ok(isRunFailureCategory("promotion"));
  assert.equal(isRunFailureCategory("oops"), false);
});

test("failure: a failure is DATA — category, code, message, retryability", () => {
  const f = runFailure({ category: "provider", code: "provider.timeout", message: "the model did not answer", retryable: true });
  assert.equal(f.category, "provider");
  assert.equal(f.retryable, true);
  assert.equal(f.stage, undefined, "an absent stage is absent, not null or empty");
  assert.equal(f.detail, undefined);
  assert.equal(formatRunFailure(f), "[provider] the model did not answer");
});

test("failure: retryable defaults to FALSE — fail-closed, no optimistic retrying", () => {
  assert.equal(runFailure({ category: "policy", code: "policy.denied", message: "no" }).retryable, false);
});

test("failure: not_implemented is its own category, never disguised as internal", () => {
  const f = stageNotImplemented("context", "preflight");
  assert.equal(f.category, "not_implemented");
  assert.equal(f.code, V2_001_FAILURE_CODES.stageNotImplemented);
  assert.equal(f.stage, "preflight", "the stage it actually reached");
  assert.equal(f.detail?.missingStage, "context", "the stage it could not perform");
  assert.equal(f.retryable, false);
  assert.match(f.message, /without building, verifying, or promoting anything/);
});

test("failure: every slice-001 code is namespaced by its category", () => {
  for (const code of Object.values(V2_001_FAILURE_CODES)) {
    const [prefix] = code.split(".");
    assert.ok(prefix !== undefined && isRunFailureCategory(prefix), `"${code}" is namespaced by a real category`);
  }
});

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  EgressGuardMissingError,
  resetFetchGuardForTests,
  resolveFetchGuard,
} from "../../core/provider/fetch-guard.js";
// Importing the module self-registers on load; we reset before each test so the
// fail-closed assertion is meaningful, then re-register explicitly.
import { guardedFetch, register } from "./index.js";

beforeEach(resetFetchGuardForTests);

test("with the guard cleared, the provider seam fails closed", () => {
  assert.throws(() => resolveFetchGuard(), EgressGuardMissingError);
});

test("register() wires the egress guardedFetch into the provider fetch-guard seam", () => {
  register();
  assert.equal(resolveFetchGuard(), guardedFetch, "the registered guard IS the egress guarded fetch");
});

test("register() is idempotent (re-registering keeps the egress guard)", () => {
  register();
  register();
  assert.equal(resolveFetchGuard(), guardedFetch);
});

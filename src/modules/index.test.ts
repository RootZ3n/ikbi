import assert from "node:assert/strict";
import { test } from "node:test";

import { hasFetchGuard, resolveFetchGuard } from "../core/provider/fetch-guard.js";

// Importing the barrel is the ACTIVATION SEAM. This side-effect import loads every
// module (and fires egress's register()) at file load — before any test runs.
import "./index.js";

test("importing the modules barrel does not throw and activates the modules", () => {
  // (Reaching this line at all means the barrel imported without throwing — every
  // module's import-time init, incl. assertContractCompatible pins, succeeded.)
  assert.ok(true);
});

test("the egress fetch guard is registered after the barrel import (egress-first ordering)", () => {
  assert.equal(hasFetchGuard(), true, "egress register() fired on barrel import");
  // ...and resolving it does NOT throw EgressGuardMissingError.
  assert.doesNotThrow(() => resolveFetchGuard(), "resolveFetchGuard() works once the barrel is loaded");
});

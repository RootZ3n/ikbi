import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// fetch-guard does NOT construct the provider singleton — safe to static-import here.
import { hasFetchGuard, resolveFetchGuard } from "../core/provider/fetch-guard.js";

// ── source-order invariant (regression guard) ────────────────────────────────

test("CLI entry imports the modules barrel BEFORE the provider singleton", () => {
  const src = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
  const barrelIdx = src.indexOf('"../modules/index.js"');
  const providerIdx = src.indexOf('"../core/provider/index.js"');
  assert.ok(barrelIdx >= 0, "barrel import present");
  assert.ok(providerIdx >= 0, "provider import present");
  assert.ok(
    barrelIdx < providerIdx,
    "the modules barrel (egress fetch-guard registration) must precede the provider import, or the provider singleton throws EgressGuardMissingError at startup",
  );
});

// ── behavioral: the entry's import sequence no longer throws ──────────────────

test("loading the barrel first lets the provider singleton construct without EgressGuardMissingError", async () => {
  // Mirror the (fixed) CLI entry order: barrel first, then the provider.
  await import("../modules/index.js"); // egress register() fires here
  assert.equal(hasFetchGuard(), true, "egress fetch guard registered by the barrel");

  // The provider singleton calls resolveFetchGuard() in its constructor at module
  // load — with the guard now present, importing it must NOT throw.
  await assert.doesNotReject(() => import("../core/provider/index.js"), "provider singleton constructs with the guard present");
  assert.doesNotThrow(() => resolveFetchGuard(), "resolveFetchGuard works after the barrel-first sequence");
});

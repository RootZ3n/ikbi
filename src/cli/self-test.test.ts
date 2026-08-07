import assert from "node:assert/strict";
import { test } from "node:test";

import "../modules/egress/index.js";

import { executeSelfTest, runSelfTest } from "./self-test.js";

test("deterministic self-test exercises authoritative local layers with zero provider calls", { timeout: 60_000 }, async () => {
  const result = await executeSelfTest();
  assert.equal(result.status, "passed");
  assert.equal(result.code, "SELF_TEST_PASSED");
  assert.equal(result.providerCalls, 0);
  assert.equal(result.mutation.applied, true);
  assert.equal(result.mutation.staleMutationRefused, true);
  assert.equal(result.verification.status, "passed");
  assert.equal(result.mutation.receiptCreated, true);
  assert.equal(result.cleanup.noOrphanProcess, true);
  assert.equal(result.cleanup.noOrphanLock, true);
  assert.equal(result.workspace.cleaned, true);
});

test("self-test JSON adapter emits one document and never starts a provider smoke call", async () => {
  let stdout = "";
  let exit = -1;
  const result = await runSelfTest(["--provider-smoke", "--json"], {
    out: (text) => { stdout += text; },
    err: () => undefined,
    setExit: (code) => { exit = code; },
  });
  assert.equal(result?.code, "SELF_TEST_PROVIDER_SMOKE_NOT_RUN");
  assert.equal(result?.providerCalls, 0);
  assert.equal(exit, 10);
  assert.doesNotThrow(() => JSON.parse(stdout));
});

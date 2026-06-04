import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import { IDENTITY_CONTRACT_VERSION } from "./contract.js";
import { AgentRegistry, hashToken } from "./registry.js";
import { beginOperation, IdentityResolver, type OperationContext } from "./resolver.js";

function validatedAgent() {
  const registry = new AgentRegistry({
    agents: [
      { agentId: "builder-3", kind: "agent", functionalRole: "builder", defaultTrustTier: "probation", tokenHashes: [hashToken("builder-secret")] },
    ],
  });
  const resolver = new IdentityResolver({ registry, logger: pino({ level: "silent" }), now: () => 1000 });
  return resolver.resolve({ token: "builder-secret" });
}

test("dryRun threads through OperationContext, immutably (additive seam)", () => {
  const v = validatedAgent();

  const dry = beginOperation(v, { requestId: "r1", dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(Object.isFrozen(dry), true);
  assert.throws(() => {
    (dry as { dryRun?: boolean }).dryRun = false;
  }, "cannot be flipped mid-flight");

  // The convention a side-effecting module follows.
  const wouldWrite = (ctx: OperationContext): "planned" | "executed" => (ctx.dryRun ? "planned" : "executed");
  assert.equal(wouldWrite(dry), "planned");
});

test("dryRun defaults to undefined (a normal executing operation)", () => {
  const v = validatedAgent();
  const normal = beginOperation(v, { requestId: "r2" });
  assert.equal(normal.dryRun, undefined);
  assert.equal("dryRun" in normal, false, "absent, not a false value — keeps the carry minimal");
});

test("the additive field rode a MINOR contract bump (1.1.0)", () => {
  assert.equal(IDENTITY_CONTRACT_VERSION, "1.1.0");
  const v = validatedAgent();
  assert.equal(beginOperation(v).contractVersion, "1.1.0");
});

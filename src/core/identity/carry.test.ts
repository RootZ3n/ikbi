import assert from "node:assert/strict";
import { test } from "node:test";

import { pino, type Logger } from "pino";

import { beginOperation } from "./resolver.js";
import { AgentRegistry, hashToken } from "./registry.js";
import { IdentityResolver } from "./resolver.js";

function silentLogger(): Logger {
  return pino({ level: "silent" });
}

function resolveBuilder() {
  const registry = new AgentRegistry({
    agents: [
      { agentId: "builder-3", kind: "agent", functionalRole: "builder", defaultTrustTier: "probation", tokenHashes: [hashToken("builder-secret")] },
    ],
  });
  const resolver = new IdentityResolver({ registry, logger: silentLogger(), now: () => 1000 });
  return resolver.resolve({ token: "builder-secret" });
}

test("a validated identity is frozen (immutable)", () => {
  const v = resolveBuilder();
  assert.equal(Object.isFrozen(v), true);
  assert.equal(Object.isFrozen(v.identity), true);
});

test("attempts to mutate or escalate a validated identity throw (no escalation)", () => {
  const v = resolveBuilder();
  // Escalate the kind.
  assert.throws(() => {
    (v as { kind: string }).kind = "operator";
  });
  // Escalate the trust tier on the carried AgentIdentity.
  assert.throws(() => {
    (v.identity as { trustTier?: string }).trustTier = "operator";
  });
  // Swap the agent id.
  assert.throws(() => {
    (v.identity as { agentId: string }).agentId = "someone-else";
  });
  // Values are unchanged after the failed attempts.
  assert.equal(v.kind, "agent");
  assert.equal(v.identity.trustTier, "probation");
  assert.equal(v.identity.agentId, "builder-3");
});

test("downstream (e.g. untrusted content handling) cannot alter the calling identity", () => {
  const v = resolveBuilder();
  // Simulate handing the AgentIdentity to a subsystem (like the injection
  // chokepoint's UntrustedContext.identity) that tries to tamper with it.
  const handedOff = v.identity;
  assert.throws(() => {
    (handedOff as { trustTier?: string }).trustTier = "trusted";
  });
  assert.equal(v.identity.trustTier, "probation", "the operation's identity is unchanged");
});

test("the operation carry envelope is frozen and immutable", () => {
  const v = resolveBuilder();
  const ctx = beginOperation(v, { requestId: "r1", now: 2000 });
  assert.equal(Object.isFrozen(ctx), true);
  assert.equal(ctx.identity, v, "carries the same validated identity");
  assert.equal(ctx.requestId, "r1");
  assert.equal(ctx.startedAt, 2000);
  assert.throws(() => {
    (ctx as { identity: unknown }).identity = {};
  });
});

test("each resolution yields an independent frozen identity", () => {
  const a = resolveBuilder();
  const b = resolveBuilder();
  assert.notEqual(a, b);
  assert.equal(a.identity.agentId, b.identity.agentId);
  assert.equal(Object.isFrozen(a), true);
  assert.equal(Object.isFrozen(b), true);
});

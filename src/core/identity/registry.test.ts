import assert from "node:assert/strict";
import { test } from "node:test";

import { IdentityError } from "./contract.js";
import { type AgentRecord, AgentRegistry, hashToken } from "./registry.js";

const agent: AgentRecord = {
  agentId: "builder-3",
  kind: "agent",
  functionalRole: "builder",
  defaultTrustTier: "probation",
  tokenHashes: [hashToken("builder-secret")],
};

test("hashToken is stable sha-256 hex and not the plaintext", () => {
  const h = hashToken("builder-secret");
  assert.match(h, /^[a-f0-9]{64}$/);
  assert.notEqual(h, "builder-secret");
  assert.equal(h, hashToken("builder-secret"));
});

test("init + read path: get / list / token lookup", () => {
  const reg = new AgentRegistry({ agents: [agent] });
  assert.equal(reg.listAgents().length, 1);
  assert.equal(reg.getAgent("builder-3")?.functionalRole, "builder");
  assert.equal(reg.findByTokenHash(hashToken("builder-secret"))?.agentId, "builder-3");
  assert.equal(reg.findByTokenHash(hashToken("wrong")), undefined);
});

test("update path: upsert / remove re-index credentials", () => {
  const reg = new AgentRegistry();
  reg.upsertAgent(agent);
  assert.ok(reg.findByTokenHash(hashToken("builder-secret")));
  reg.removeAgent("builder-3");
  assert.equal(reg.findByTokenHash(hashToken("builder-secret")), undefined, "token gone after removal");
  assert.equal(reg.removeAgent("builder-3"), false);
});

test("tailscale lookup by login (case-insensitive), nodeId, addr", () => {
  const reg = new AgentRegistry({
    agents: [
      {
        agentId: "scout",
        kind: "agent",
        defaultTrustTier: "verified",
        tailscale: { logins: ["Alice@Example.com"], nodeIds: ["node-abc"], addrs: ["100.64.0.5"] },
      },
    ],
  });
  assert.equal(reg.findByTailscale({ login: "alice@example.com" })?.agentId, "scout");
  assert.equal(reg.findByTailscale({ nodeId: "node-abc" })?.agentId, "scout");
  assert.equal(reg.findByTailscale({ addr: "100.64.0.5" })?.agentId, "scout");
  assert.equal(reg.findByTailscale({ login: "mallory@evil.com" }), undefined);
});

test("disabled agents are still indexed (resolver makes the fail-closed call)", () => {
  const reg = new AgentRegistry({
    agents: [{ ...agent, disabled: true }],
  });
  const found = reg.findByTokenHash(hashToken("builder-secret"));
  assert.equal(found?.agentId, "builder-3");
  assert.equal(found?.disabled, true);
});

test("applyRegistry parses valid documents", () => {
  const reg = new AgentRegistry();
  const applied = reg.applyRegistry({
    agents: [
      { agentId: "peh", kind: "agent", functionalRole: "guide", defaultTrustTier: "trusted", tokenHashes: [hashToken("peh-tok")] },
      { agentId: "op", kind: "operator", defaultTrustTier: "operator", tokenHashes: [hashToken("op-tok")] },
    ],
  });
  assert.deepEqual(applied, { agents: 2 });
  assert.equal(reg.getAgent("op")?.kind, "operator");
});

test("applyRegistry rejects malformed documents (fail loud)", () => {
  assert.throws(() => new AgentRegistry().applyRegistry(7), IdentityError);
  assert.throws(() => new AgentRegistry().applyRegistry({ agents: "no" }), IdentityError);
  assert.throws(
    () => new AgentRegistry().applyRegistry({ agents: [{ agentId: "x", kind: "root", defaultTrustTier: "t" }] }),
    IdentityError,
  ); // bad kind
  assert.throws(
    () => new AgentRegistry().applyRegistry({ agents: [{ agentId: "x", kind: "agent" }] }),
    IdentityError,
  ); // missing defaultTrustTier
  assert.throws(
    () => new AgentRegistry().applyRegistry({ agents: [{ agentId: "x", kind: "agent", defaultTrustTier: "t", tokenHashes: ["not-a-hash"] }] }),
    IdentityError,
  ); // malformed token hash
});

test("loadRegistryFile is a no-op when the file is absent", () => {
  const reg = new AgentRegistry();
  assert.deepEqual(reg.loadRegistryFile("/nonexistent/ikbi-agents-does-not-exist.json"), { agents: 0 });
});

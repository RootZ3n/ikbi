import assert from "node:assert/strict";
import { test } from "node:test";

import { pino, type Logger } from "pino";

import { IdentityError, type TrustTierResolver } from "./contract.js";
import { AgentRegistry, hashToken } from "./registry.js";
import { IdentityResolver, isOperator } from "./resolver.js";

function captureLogger(): { logger: Logger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const logger = pino(
    { level: "trace" },
    { write: (s: string) => void lines.push(JSON.parse(s) as Record<string, unknown>) },
  );
  return { logger, lines };
}

function fixtureRegistry(): AgentRegistry {
  return new AgentRegistry({
    agents: [
      { agentId: "builder-3", kind: "agent", functionalRole: "builder", defaultTrustTier: "probation", tokenHashes: [hashToken("builder-secret")] },
      { agentId: "operator", kind: "operator", functionalRole: "operator", defaultTrustTier: "operator", tokenHashes: [hashToken("op-secret")] },
      { agentId: "scout", kind: "agent", defaultTrustTier: "verified", tailscale: { logins: ["alice@example.com"] } },
      { agentId: "revoked", kind: "agent", defaultTrustTier: "probation", tokenHashes: [hashToken("revoked-secret")], disabled: true },
    ],
  });
}

function makeResolver(trustResolver?: TrustTierResolver) {
  const { logger, lines } = captureLogger();
  const resolver = new IdentityResolver({
    registry: fixtureRegistry(),
    logger,
    now: () => 1000,
    ...(trustResolver ? { trustResolver } : {}),
  });
  return { resolver, lines };
}

test("a registered agent's token resolves to a validated identity", () => {
  const { resolver, lines } = makeResolver();
  const v = resolver.resolve({ token: "builder-secret", remoteAddr: "100.64.0.9" }, { requestId: "r1" });
  assert.equal(v.kind, "agent");
  assert.equal(v.identity.agentId, "builder-3");
  assert.equal(v.identity.functionalRole, "builder");
  assert.equal(v.identity.trustTier, "probation"); // from registry default
  assert.equal(v.authMethod, "agent_token");
  assert.equal(v.resolvedAt, 1000);
  // logged with attribution.
  const ok = lines.find((l) => l.event === "identity_resolved");
  assert.equal(ok?.agentId, "builder-3");
  assert.equal(ok?.authMethod, "agent_token");
});

test("the operator is distinguished from agents (highest tier, operator_token)", () => {
  const { resolver } = makeResolver();
  const v = resolver.resolve({ token: "op-secret" });
  assert.equal(v.kind, "operator");
  assert.equal(isOperator(v), true);
  assert.equal(v.identity.trustTier, "operator");
  assert.equal(v.authMethod, "operator_token");
});

test("isOperator REQUIRES PROVENANCE — a forged {kind:'operator'} object is not an operator", () => {
  const { resolver } = makeResolver();
  // A genuinely-minted operator identity passes (provenance + kind).
  const genuine = resolver.resolve({ token: "op-secret" });
  assert.equal(isOperator(genuine), true, "a real resolved operator identity is operator");
  // A structural look-alike that was NEVER minted fails the unforgeable brand+WeakSet check.
  const forged = { kind: "operator", identity: { agentId: "forged-op", trustTier: "operator" }, authMethod: "operator_token", resolvedAt: 1 } as never;
  assert.equal(isOperator(forged), false, "a forged structural object is NOT operator without genuine minting");
});

test("tailscale peer resolves ONLY from a boundary-verified source", () => {
  const { resolver } = makeResolver();
  const v = resolver.resolve({}, { verifiedPeer: { tailscale: { login: "alice@example.com" } } });
  assert.equal(v.identity.agentId, "scout");
  assert.equal(v.authMethod, "tailscale_peer");
  assert.equal(v.identity.trustTier, "verified");
});

test("FAIL-CLOSED: no credential -> unauthenticated, no default identity", () => {
  const { resolver, lines } = makeResolver();
  assert.throws(
    () => resolver.resolve({ remoteAddr: "100.64.0.9" }),
    (e: unknown) => e instanceof IdentityError && e.kind === "unauthenticated",
  );
  assert.ok(lines.some((l) => l.event === "identity_rejected" && l.reason === "unauthenticated"));
});

test("FAIL-CLOSED: wrong token -> invalid_credential", () => {
  const { resolver } = makeResolver();
  assert.throws(
    () => resolver.resolve({ token: "not-a-real-token" }),
    (e: unknown) => e instanceof IdentityError && e.kind === "invalid_credential",
  );
});

test("FAIL-CLOSED: unknown verified tailscale peer -> unknown_agent", () => {
  const { resolver } = makeResolver();
  assert.throws(
    () => resolver.resolve({}, { verifiedPeer: { tailscale: { login: "mallory@evil.com" } } }),
    (e: unknown) => e instanceof IdentityError && e.kind === "unknown_agent",
  );
});

test("FAIL-CLOSED: disabled (revoked) agent -> disabled_agent", () => {
  const { resolver } = makeResolver();
  assert.throws(
    () => resolver.resolve({ token: "revoked-secret" }),
    (e: unknown) => e instanceof IdentityError && e.kind === "disabled_agent",
  );
});

test("claimedAgentId is advisory and CANNOT escalate identity", () => {
  const { resolver } = makeResolver();
  // Present a builder token but claim to be the operator.
  const v = resolver.resolve({ token: "builder-secret", claimedAgentId: "operator" });
  assert.equal(v.identity.agentId, "builder-3", "credential decides identity, not the claim");
  assert.equal(v.kind, "agent");
  assert.notEqual(v.identity.trustTier, "operator");
});

test("trustTier comes through the seam (pluggable resolver) and is set once", () => {
  // A custom trust resolver (stand-in for the later dynamic trust phase).
  const trustResolver: TrustTierResolver = {
    resolve: (i) => (i.agentId === "builder-3" ? "trusted" : i.defaultTrustTier),
  };
  const { resolver } = makeResolver(trustResolver);
  const v = resolver.resolve({ token: "builder-secret" });
  assert.equal(v.identity.trustTier, "trusted", "seam overrode the registry default");
});

test("the session id from the claim is carried onto the identity", () => {
  const { resolver } = makeResolver();
  const v = resolver.resolve({ token: "builder-secret", sessionId: "sess-42" });
  assert.equal(v.identity.sessionId, "sess-42");
});

test("rejections never log the token, only whether one was present", () => {
  const { resolver, lines } = makeResolver();
  try {
    resolver.resolve({ token: "super-secret-value" });
  } catch {
    /* expected */
  }
  const rej = lines.find((l) => l.event === "identity_rejected");
  assert.equal(rej?.hadToken, true);
  assert.ok(!JSON.stringify(lines).includes("super-secret-value"), "token never appears in logs");
});

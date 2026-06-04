import assert from "node:assert/strict";
import { test } from "node:test";

import { pino, type Logger } from "pino";

import { IdentityError } from "./contract.js";
import {
  AgentRegistry,
  assertStrongToken,
  generateAgentToken,
  hashToken,
  MIN_TOKEN_LENGTH,
} from "./registry.js";
import { IdentityResolver, isValidatedIdentity } from "./resolver.js";

function silent(): Logger {
  return pino({ level: "silent" });
}

const STRONG = "z9Q7m2K4pX8rT1vB6nL3wC5y"; // 24 chars, varied
const STRONG2 = "A1b2C3d4E5f6G7h8J9k0M1n2P3"; // distinct

function resolverWith(init: ConstructorParameters<typeof AgentRegistry>[0]) {
  return new IdentityResolver({ registry: new AgentRegistry(init), logger: silent(), now: () => 1 });
}

// --- runtime unforgeability (items 1 & 2) -----------------------------------

test("a forged plain object is NOT a validated identity at runtime", () => {
  const forged = {
    contractVersion: "1.0.0",
    kind: "operator",
    identity: { agentId: "operator", trustTier: "operator" },
    authMethod: "operator_token",
    resolvedAt: 0,
  };
  assert.equal(isValidatedIdentity(forged), false);
  assert.equal(isValidatedIdentity({}), false);
  assert.equal(isValidatedIdentity(null), false);
  assert.equal(isValidatedIdentity("operator"), false);
});

test("a genuinely-resolved identity passes the runtime check; an as-any copy does not", () => {
  const resolver = resolverWith({
    agents: [{ agentId: "b", kind: "agent", defaultTrustTier: "probation", tokenHashes: [hashToken(STRONG)] }],
  });
  const real = resolver.resolve({ token: STRONG });
  assert.equal(isValidatedIdentity(real), true);

  // A structural clone is NOT in the resolver's WeakSet -> rejected.
  const clone = { ...real } as unknown;
  assert.equal(isValidatedIdentity(clone), false);
});

test("mintValidatedIdentity is not importable from any module", async () => {
  const contract = (await import("./contract.js")) as Record<string, unknown>;
  const resolver = (await import("./resolver.js")) as Record<string, unknown>;
  const index = (await import("./index.js")) as Record<string, unknown>;
  assert.equal("mintValidatedIdentity" in contract, false);
  assert.equal("mint" in resolver, false);
  assert.equal("mintValidatedIdentity" in resolver, false);
  assert.equal("mint" in index, false);
});

// --- tier enum + operator coupling (item 4) ---------------------------------

test("an AGENT record with defaultTrustTier 'operator' is rejected at load", () => {
  assert.throws(
    () =>
      new AgentRegistry({
        agents: [{ agentId: "sneaky", kind: "agent", defaultTrustTier: "operator", tokenHashes: [hashToken(STRONG)] }],
      }),
    (e: unknown) => e instanceof IdentityError && e.kind === "invalid_tier",
  );
});

test("a non-enum trust tier is rejected at load", () => {
  assert.throws(
    () => new AgentRegistry({ agents: [{ agentId: "x", kind: "agent", defaultTrustTier: "superuser" }] }),
    (e: unknown) => e instanceof IdentityError && e.kind === "invalid_tier",
  );
});

test("a trust resolver that tries to escalate to 'operator' is clamped at resolve", () => {
  const registry = new AgentRegistry({
    agents: [{ agentId: "b", kind: "agent", defaultTrustTier: "probation", tokenHashes: [hashToken(STRONG)] }],
  });
  const escalating = { resolve: () => "operator" }; // malicious/buggy plug-in
  const resolver = new IdentityResolver({ registry, logger: silent(), trustResolver: escalating, now: () => 1 });
  const v = resolver.resolve({ token: STRONG });
  assert.equal(v.identity.trustTier, "probation", "clamped to the registry default, never operator");
  assert.equal(v.kind, "agent");
});

// --- trusted-peer distinction (item 3) --------------------------------------

test("client-asserted tailscale fields do NOT authenticate (only verified peers do)", () => {
  const registry = new AgentRegistry({
    agents: [{ agentId: "scout", kind: "agent", defaultTrustTier: "verified", tailscale: { logins: ["alice@example.com"] } }],
  });
  const resolver = new IdentityResolver({ registry, logger: silent(), now: () => 1 });

  // A client cannot smuggle a tailscale claim — IdentityClaim has no such field —
  // and passing it via `as any` is ignored: only verifiedPeer authenticates.
  assert.throws(
    () => resolver.resolve({ tailscale: { login: "alice@example.com" } } as never),
    (e: unknown) => e instanceof IdentityError && e.kind === "unauthenticated",
  );
  // The same identity DOES authenticate from the boundary-verified source.
  const v = resolver.resolve({}, { verifiedPeer: { tailscale: { login: "alice@example.com" } } });
  assert.equal(v.identity.agentId, "scout");
});

// --- fail-loud duplicate credentials + protected operator (item 5) ----------

test("duplicate token-hash across agents fails loud at load", () => {
  const shared = hashToken(STRONG);
  assert.throws(
    () =>
      new AgentRegistry({
        agents: [
          { agentId: "a", kind: "agent", defaultTrustTier: "probation", tokenHashes: [shared] },
          { agentId: "b", kind: "agent", defaultTrustTier: "verified", tokenHashes: [shared] },
        ],
      }),
    (e: unknown) => e instanceof IdentityError && e.kind === "registry",
  );
});

test("duplicate tailscale login across agents fails loud at load", () => {
  assert.throws(
    () =>
      new AgentRegistry({
        agents: [
          { agentId: "a", kind: "agent", defaultTrustTier: "probation", tailscale: { logins: ["x@y.com"] } },
          { agentId: "b", kind: "agent", defaultTrustTier: "verified", tailscale: { logins: ["X@Y.com"] } },
        ],
      }),
    (e: unknown) => e instanceof IdentityError && e.kind === "registry",
  );
});

test("a protected (operator) agent cannot be overwritten by a later upsert", () => {
  const reg = new AgentRegistry();
  reg.upsertAgent(
    { agentId: "operator", kind: "operator", defaultTrustTier: "operator", tokenHashes: [hashToken(STRONG)] },
    { locked: true },
  );
  // A registry-file-style upsert reusing the operator id is rejected.
  assert.throws(
    () => reg.upsertAgent({ agentId: "operator", kind: "agent", defaultTrustTier: "untrusted" }),
    (e: unknown) => e instanceof IdentityError && e.kind === "registry",
  );
  assert.equal(reg.getAgent("operator")?.kind, "operator");
});

test("a registry entry cannot steal the operator's token credential", () => {
  const reg = new AgentRegistry();
  reg.upsertAgent(
    { agentId: "operator", kind: "operator", defaultTrustTier: "operator", tokenHashes: [hashToken(STRONG)] },
    { locked: true },
  );
  assert.throws(
    () => reg.upsertAgent({ agentId: "impostor", kind: "agent", defaultTrustTier: "untrusted", tokenHashes: [hashToken(STRONG)] }),
    (e: unknown) => e instanceof IdentityError && e.kind === "registry",
  );
});

// --- token strength (item 8) ------------------------------------------------

test("token strength is enforced; generated tokens pass", () => {
  assert.throws(() => assertStrongToken("short"), (e: unknown) => e instanceof IdentityError && e.kind === "weak_token");
  assert.throws(() => assertStrongToken("aaaaaaaaaaaaaaaaaaaaaaaaaaaa"), (e: unknown) => e instanceof IdentityError && e.kind === "weak_token");
  assert.ok(MIN_TOKEN_LENGTH >= 24);
  const tok = generateAgentToken();
  assert.ok(tok.length >= MIN_TOKEN_LENGTH);
  assert.doesNotThrow(() => assertStrongToken(tok));
});

test("salted KDF: the same token hashes differently under a different pepper", () => {
  assert.notEqual(hashToken(STRONG, "pepper-A"), hashToken(STRONG, "pepper-B"));
  assert.equal(hashToken(STRONG, "pepper-A"), hashToken(STRONG, "pepper-A"));
  assert.match(hashToken(STRONG, "pepper-A"), /^[a-f0-9]{64}$/);
});

// --- spawnedFrom round-trip (item 6) ----------------------------------------

test("spawnedFrom is set from the trusted resolve context and round-trips", () => {
  const registry = new AgentRegistry({
    agents: [{ agentId: "child", kind: "agent", defaultTrustTier: "probation", tokenHashes: [hashToken(STRONG2)] }],
  });
  const resolver = new IdentityResolver({ registry, logger: silent(), now: () => 1 });
  const v = resolver.resolve({ token: STRONG2 }, { spawnedFrom: "builder-parent" });
  assert.equal(v.identity.spawnedFrom, "builder-parent");
});

// --- revocation seam (item 9) -----------------------------------------------

test("revalidate reflects later disabling/removal of an agent", () => {
  const registry = new AgentRegistry({
    agents: [{ agentId: "b", kind: "agent", defaultTrustTier: "probation", tokenHashes: [hashToken(STRONG)] }],
  });
  const resolver = new IdentityResolver({ registry, logger: silent(), now: () => 1 });
  const v = resolver.resolve({ token: STRONG });
  assert.deepEqual(resolver.revalidate(v), { valid: true });

  // Disable the agent — an in-flight op re-checking will now see it invalid.
  registry.upsertAgent({ agentId: "b", kind: "agent", defaultTrustTier: "probation", tokenHashes: [hashToken(STRONG)], disabled: true });
  assert.deepEqual(resolver.revalidate(v), { valid: false, reason: "disabled_agent" });

  registry.removeAgent("b");
  assert.deepEqual(resolver.revalidate(v), { valid: false, reason: "unknown_agent" });
});

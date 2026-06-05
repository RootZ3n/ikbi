import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import { config } from "../config.js";
import { buildDefaultRegistry } from "./index.js";
import { hashToken } from "./registry.js";
import { IdentityResolver } from "./resolver.js";
import { IdentityError } from "./contract.js";

const silent = () => pino({ level: "silent" });

// Strong tokens: ≥32 chars, ≥8 distinct chars (assertStrongToken bar).
const WORKER_TOKEN = "worker-secret-token-thirty-two-plus-xyz";
const OPERATOR_TOKEN = "operator-secret-token-thirty-two-plus-q";
const OTHER_TOKEN = "another-agent-secret-token-thirty-two-z";
const WEAK_TOKEN = "short"; // < 32 chars

/** A full IdentityConfig for buildDefaultRegistry, overridable per test. registryFile
 *  points at a nonexistent path (loadRegistryFile returns {agents:0} — no-op). */
function ic(over: Partial<typeof config.identity> = {}): typeof config.identity {
  return {
    registryFile: "/nonexistent/ikbi-test/agents.json",
    operatorToken: undefined,
    operatorAgentId: "operator",
    workerToken: undefined,
    workerAgentId: "worker",
    workerTrustTier: "trusted",
    tokenSalt: config.identity.tokenSalt, // hashToken uses the global salt at both ends
    tokenSaltIsDefault: false,
    ...over,
  };
}

function resolverOver(registry: ReturnType<typeof buildDefaultRegistry>) {
  return new IdentityResolver({ registry, logger: silent() }); // default static trust resolver
}

// ── worker token SET → claimable worker agent ────────────────────────────────

test("IKBI_WORKER_TOKEN set ⇒ a claimable worker agent is registered and resolves", () => {
  const registry = buildDefaultRegistry(ic({ workerToken: WORKER_TOKEN, workerTrustTier: "trusted" }));
  const who = resolverOver(registry).resolve({ token: WORKER_TOKEN });

  assert.equal(who.kind, "agent");
  assert.equal(who.identity.agentId, "worker");
  assert.equal(who.identity.functionalRole, "worker");
  assert.equal(who.identity.trustTier, "trusted", "tier from IKBI_WORKER_TRUST_TIER");
});

test("worker agent id + tier honor IKBI_WORKER_AGENT_ID / IKBI_WORKER_TRUST_TIER", () => {
  const registry = buildDefaultRegistry(ic({ workerToken: WORKER_TOKEN, workerAgentId: "builder-pool", workerTrustTier: "verified" }));
  const who = resolverOver(registry).resolve({ token: WORKER_TOKEN });
  assert.equal(who.identity.agentId, "builder-pool");
  assert.equal(who.identity.trustTier, "verified");
});

// ── worker token UNSET → fail-closed (no claimable worker) ───────────────────

test("IKBI_WORKER_TOKEN unset ⇒ NO worker agent ⇒ resolving the worker token fails closed", () => {
  const registry = buildDefaultRegistry(ic({ workerToken: undefined }));
  assert.equal(registry.listAgents().length, 0, "no worker agent registered");
  assert.throws(
    () => resolverOver(registry).resolve({ token: WORKER_TOKEN }),
    (e: unknown) => e instanceof IdentityError,
    "no claimable worker — resolution is fail-closed",
  );
});

// ── weak worker token → fail loud at bootstrap ───────────────────────────────

test("a weak IKBI_WORKER_TOKEN (<32 chars) throws at bootstrap (same bar as operator)", () => {
  assert.throws(
    () => buildDefaultRegistry(ic({ workerToken: WEAK_TOKEN })),
    (e: unknown) => e instanceof IdentityError && e.kind === "weak_token",
  );
});

// ── operator bootstrap UNCHANGED (regression guard) ──────────────────────────

test("operator bootstrap is unchanged: registered, operator-tier, and LOCKED (protected)", () => {
  const registry = buildDefaultRegistry(ic({ operatorToken: OPERATOR_TOKEN }));
  const op = registry.getAgent("operator");
  assert.ok(op, "operator registered");
  assert.equal(op?.kind, "operator");
  assert.equal(op?.defaultTrustTier, "operator");
  // LOCKED: a later upsert of the same id without locked:true is rejected.
  assert.throws(
    () => registry.upsertAgent({ agentId: "operator", kind: "agent", defaultTrustTier: "verified", tokenHashes: [hashToken(OTHER_TOKEN)] }),
    /protected/,
    "operator is still locked",
  );
});

// ── worker agent is UNLOCKED (coexists with later agents) ────────────────────

test("the worker agent is NOT locked: per-role agents can be added alongside it", () => {
  const registry = buildDefaultRegistry(ic({ workerToken: WORKER_TOKEN }));
  // A DIFFERENT agent (e.g. from agents.json) coexists.
  registry.upsertAgent({ agentId: "scout-pool", kind: "agent", functionalRole: "scout", defaultTrustTier: "verified", tokenHashes: [hashToken(OTHER_TOKEN)] });
  const ids = registry.listAgents().map((a) => a.agentId).sort();
  assert.deepEqual(ids, ["scout-pool", "worker"], "worker + a per-role agent coexist");
  // And the worker id itself is overwritable (unlocked, unlike the operator).
  assert.doesNotThrow(() => registry.upsertAgent({ agentId: "worker", kind: "agent", defaultTrustTier: "probation", tokenHashes: [hashToken("worker-refined-token-thirty-two-plus-x")] }));
});

// ── operator + worker coexist ────────────────────────────────────────────────

test("operator and worker bootstrap coexist when both tokens are set", () => {
  const registry = buildDefaultRegistry(ic({ operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN }));
  const resolver = resolverOver(registry);
  assert.equal(resolver.resolve({ token: OPERATOR_TOKEN }).identity.agentId, "operator");
  assert.equal(resolver.resolve({ token: WORKER_TOKEN }).identity.agentId, "worker");
});

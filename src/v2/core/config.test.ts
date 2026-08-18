/**
 * THE CONFIGURATION TRUTH BOUNDARY — pure unit coverage.
 *
 * Provider availability, operator strategy, and the single normalized policy that
 * comes out. The load-bearing assertions are about what this layer REFUSES: to guess a
 * readiness it cannot observe, to substitute a working profile for a broken one, to
 * let a profile invent a route, and to carry anything credential-shaped.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OPERATOR_TIER_ROLES,
  REDACTED,
  V2_CONFIG_FAILURE_CODES,
  V2_MODEL_ROLES,
  V2_REQUIRED_ROLES,
  buildProviderInventory,
  buildRuntimeModelPolicy,
  readinessOf,
  redactParameters,
  redactUrlUserinfo,
  type ActiveProfileInput,
  type ConfigurationInputs,
  type ProviderFactsInput,
  type ProviderInventoryInput,
} from "./config.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const provider = (id: string, over: Partial<ProviderFactsInput> = {}): ProviderFactsInput => ({
  id,
  introspectable: true,
  kind: "openai-compatible",
  baseUrl: `https://${id}.example/v1`,
  credentialRequired: true,
  credentialPresent: true,
  ...over,
});

const INVENTORY: ProviderInventoryInput = {
  providers: [provider("alpha"), provider("beta"), provider("dry", { credentialPresent: false })],
  models: [
    { id: "alpha-1", role: "builder", routes: [{ providerId: "alpha", providerModelId: "a1" }] },
    { id: "beta-1", role: "critic", routes: [{ providerId: "beta", providerModelId: "b1" }] },
    { id: "dry-1", routes: [{ providerId: "dry", providerModelId: "d1" }] },
    { id: "ghost-1", routes: [{ providerId: "nowhere", providerModelId: "g1" }] },
  ],
};

function profileInput(over: Partial<Parameters<typeof resolvedProfile>[0]> = {}): ActiveProfileInput {
  return resolvedProfile({
    name: "alpha-profile",
    roles: { builder: { provider: "alpha", model: "alpha-1" }, critic: { provider: "beta", model: "beta-1" } },
    ...over,
  });
}

function resolvedProfile(input: {
  name: string;
  roles: Record<string, { provider: string; model: string }>;
  parameters?: Record<string, unknown>;
  maxRunCostUsd?: number;
  inheritanceChain?: string[];
}): ActiveProfileInput {
  return {
    kind: "resolved",
    profile: {
      name: input.name,
      inheritanceChain: input.inheritanceChain ?? [input.name],
      roles: input.roles,
      ...(input.parameters !== undefined ? { parameters: input.parameters } : {}),
      ...(input.maxRunCostUsd !== undefined ? { maxRunCostUsd: input.maxRunCostUsd } : {}),
      source: "active_pointer",
    },
  };
}

const inputs = (over: Partial<ConfigurationInputs> = {}): ConfigurationInputs => ({
  inventory: INVENTORY,
  activeProfile: { kind: "none" },
  operatorDefaults: { models: [] },
  ...over,
});

function policyOf(over: Partial<ConfigurationInputs> = {}) {
  const built = buildRuntimeModelPolicy(inputs(over));
  assert.ok(built.ok, `expected a policy, got ${built.ok ? "" : built.failure.code}`);
  return built.policy;
}

function failureOf(over: Partial<ConfigurationInputs>) {
  const built = buildRuntimeModelPolicy(inputs(over));
  assert.equal(built.ok, false, "expected a configuration failure");
  assert.ok(!built.ok);
  return built.failure;
}

// ── provider inventory ──────────────────────────────────────────────────────

test("inventory: readiness is CONFIGURED / KEYLESS / NOT_CONFIGURED — never 'reachable'", () => {
  assert.equal(readinessOf(provider("a")), "configured");
  assert.equal(readinessOf(provider("a", { credentialRequired: false })), "keyless");
  assert.equal(readinessOf(provider("a", { credentialPresent: false })), "not_configured");
});

test("inventory: a provider that cannot describe itself is UNKNOWN, not optimistically ready", () => {
  assert.equal(readinessOf(provider("a", { introspectable: false })), "unknown");
});

test("inventory: a model is routable only if a route names a REGISTERED provider", () => {
  const inv = buildProviderInventory(INVENTORY);
  const ghost = inv.models.find((m) => m.id === "ghost-1")!;
  assert.equal(ghost.routable, false, "no provider named 'nowhere' is registered");
  assert.equal(ghost.invocable, false);
  assert.equal(ghost.routes[0]?.providerReadiness, "unknown");
});

test("inventory: a registered-but-unkeyed provider makes a model routable, NOT invocable", () => {
  const inv = buildProviderInventory(INVENTORY);
  const dry = inv.models.find((m) => m.id === "dry-1")!;
  assert.equal(dry.routable, true);
  assert.equal(dry.invocable, false, "a key is missing — key presence is the only thing checked");
  assert.equal(inv.modelsInvocable, 2, "alpha-1 and beta-1");
  assert.equal(inv.providersConfigured, 2);
});

test("inventory: providers and models are sorted, but a model's fallback chain is NOT", () => {
  const inv = buildProviderInventory({
    providers: [provider("zeta"), provider("alpha")],
    models: [
      { id: "zz", routes: [{ providerId: "zeta", providerModelId: "z" }, { providerId: "alpha", providerModelId: "a" }] },
      { id: "aa", routes: [{ providerId: "alpha", providerModelId: "a" }] },
    ],
  });
  assert.deepEqual(inv.providers.map((p) => p.id), ["alpha", "zeta"]);
  assert.deepEqual(inv.models.map((m) => m.id), ["aa", "zz"]);
  assert.deepEqual(inv.models[1]?.routes.map((r) => r.providerId), ["zeta", "alpha"], "the fallback order is semantic");
});

test("inventory: the digest is stable under irrelevant reordering and moves on real change", () => {
  const forward = buildProviderInventory(INVENTORY).digest;
  const reversed = buildProviderInventory({
    providers: [...INVENTORY.providers].reverse(),
    models: [...INVENTORY.models].reverse(),
  }).digest;
  assert.equal(forward, reversed, "collection order carries no meaning");

  const rekeyed = buildProviderInventory({
    ...INVENTORY,
    providers: INVENTORY.providers.map((p) => (p.id === "dry" ? { ...p, credentialPresent: true } : p)),
  }).digest;
  assert.notEqual(forward, rekeyed, "a newly configured credential changes what this machine can invoke");
});

test("inventory: the digest ignores filesystem paths — moving a state root is not a capability change", () => {
  const a = buildProviderInventory({
    ...INVENTORY,
    providers: INVENTORY.providers.map((p) => ({ ...p, configurationSource: "/home/one/providers.json" })),
  }).digest;
  const b = buildProviderInventory({
    ...INVENTORY,
    providers: INVENTORY.providers.map((p) => ({ ...p, configurationSource: "/home/two/providers.json" })),
  }).digest;
  assert.equal(a, b);
});

// ── profile validation ──────────────────────────────────────────────────────

test("profile: NO active profile is a normal state, not a failure", () => {
  const policy = policyOf();
  assert.equal(policy.profile, undefined);
  assert.equal(policy.profileSource, "none");
  assert.deepEqual([...policy.rolePreferences], []);
});

test("profile: an UNRESOLVABLE explicit selection FAILS — it is never silently replaced", () => {
  const failure = failureOf({
    activeProfile: { kind: "unresolvable", name: "gone", source: "active_pointer", code: "profile_not_found", detail: "no such file" },
  });
  assert.equal(failure.category, "preflight");
  assert.equal(failure.code, V2_CONFIG_FAILURE_CODES.profileUnresolvable);
  assert.match(failure.message, /"gone"/);
  assert.equal(failure.retryable, false);
});

test("profile: a missing REQUIRED role fails", () => {
  const failure = failureOf({
    activeProfile: resolvedProfile({ name: "half", roles: { builder: { provider: "alpha", model: "alpha-1" } } }),
  });
  assert.equal(failure.code, V2_CONFIG_FAILURE_CODES.profileMissingRequiredRole);
  assert.equal(failure.detail?.role, "critic");
});

test("profile: a profile may NOT invent a model route this machine does not have", () => {
  const failure = failureOf({
    activeProfile: profileInput({ roles: { builder: { provider: "alpha", model: "imaginary" }, critic: { provider: "beta", model: "beta-1" } } }),
  });
  assert.equal(failure.code, V2_CONFIG_FAILURE_CODES.profileModelNotInInventory);
  assert.equal(failure.detail?.model, "imaginary");
});

test("profile: a profile may NOT name an unregistered provider", () => {
  const failure = failureOf({
    activeProfile: profileInput({ roles: { builder: { provider: "nowhere", model: "alpha-1" }, critic: { provider: "beta", model: "beta-1" } } }),
  });
  assert.equal(failure.code, V2_CONFIG_FAILURE_CODES.profileProviderNotRegistered);
});

test("profile: an unknown role name fails rather than being ignored", () => {
  const failure = failureOf({
    activeProfile: profileInput({
      roles: {
        builder: { provider: "alpha", model: "alpha-1" },
        critic: { provider: "beta", model: "beta-1" },
        astrologer: { provider: "alpha", model: "alpha-1" },
      },
    }),
  });
  assert.equal(failure.code, V2_CONFIG_FAILURE_CODES.profileUnknownRole);
});

test("profile: a missing CREDENTIAL is truth, not a configuration failure", () => {
  // Deliberate line: structural incoherence fails; an unkeyed provider is recorded as
  // unsatisfiable so a later slice can act on it without this layer claiming a verdict.
  const policy = policyOf({
    activeProfile: profileInput({ roles: { builder: { provider: "dry", model: "dry-1" }, critic: { provider: "beta", model: "beta-1" } } }),
  });
  const builder = policy.rolePreferences.find((p) => p.role === "builder")!;
  assert.equal(builder.modelInInventory, true);
  assert.equal(builder.providerRegistered, true);
  assert.equal(builder.providerReadiness, "not_configured");
  assert.equal(builder.satisfiable, false);
  assert.deepEqual([...policy.unsatisfiableRequiredRoles], ["builder"]);
});

// ── precedence ──────────────────────────────────────────────────────────────

test("precedence: a profile role BEATS an operator default for the same role", () => {
  const policy = policyOf({
    activeProfile: profileInput(),
    operatorDefaults: { models: [{ tier: "builder", modelId: "beta-1", explicit: true }] },
  });
  const builder = policy.rolePreferences.find((p) => p.role === "builder")!;
  assert.equal(builder.modelId, "alpha-1");
  assert.equal(builder.source, "active_profile");
});

test("precedence: operator defaults fill only the roles no profile claimed", () => {
  const policy = policyOf({
    activeProfile: profileInput(),
    operatorDefaults: { models: [{ tier: "driver", modelId: "beta-1", explicit: true }] },
  });
  for (const role of OPERATOR_TIER_ROLES.driver) {
    const filled = policy.rolePreferences.find((p) => p.role === role)!;
    assert.equal(filled.modelId, "beta-1", `${role} came from the operator layer`);
    assert.equal(filled.source, "operator_env");
    assert.equal(filled.providerId, undefined, "the roster's own fallback chain picks the provider");
  }
});

test("precedence: an env-set tier is operator_env; an unset one is builtin_default", () => {
  const policy = policyOf({
    operatorDefaults: {
      models: [
        { tier: "builder", modelId: "alpha-1", explicit: true },
        { tier: "critic", modelId: "beta-1", explicit: false },
      ],
    },
  });
  assert.equal(policy.rolePreferences.find((p) => p.role === "builder")?.source, "operator_env");
  assert.equal(policy.rolePreferences.find((p) => p.role === "critic")?.source, "builtin_default");
});

test("precedence: a RUN OVERRIDE is recorded as its own, highest layer", () => {
  const override: ActiveProfileInput = {
    kind: "resolved",
    profile: {
      name: "one-off",
      inheritanceChain: ["one-off"],
      roles: { builder: { provider: "alpha", model: "alpha-1" }, critic: { provider: "beta", model: "beta-1" } },
      source: "run_override",
    },
  };
  const policy = policyOf({ activeProfile: override });
  assert.equal(policy.profileSource, "run_override");
  assert.ok(policy.rolePreferences.every((p) => p.source === "run_override"));
});

test("precedence: every resolved preference names the layer it came from", () => {
  const policy = policyOf({
    activeProfile: profileInput(),
    operatorDefaults: { models: [{ tier: "driver", modelId: "beta-1", explicit: false }] },
  });
  const sources = new Set(policy.rolePreferences.map((p) => p.source));
  assert.deepEqual([...sources].sort(), ["active_profile", "builtin_default"]);
});

// ── policy identity ─────────────────────────────────────────────────────────

test("policy: identical configuration yields an identical policy id", () => {
  assert.equal(policyOf({ activeProfile: profileInput() }).policyId, policyOf({ activeProfile: profileInput() }).policyId);
});

test("policy: switching profiles CHANGES the policy id", () => {
  const a = policyOf({ activeProfile: profileInput() });
  const b = policyOf({
    activeProfile: resolvedProfile({
      name: "beta-profile",
      roles: { builder: { provider: "beta", model: "beta-1" }, critic: { provider: "beta", model: "beta-1" } },
    }),
  });
  assert.notEqual(a.policyId, b.policyId);
  assert.notEqual(a.profile?.digest, b.profile?.digest);
});

test("policy: a constraint change moves the id even when roles are identical", () => {
  const cheap = policyOf({ activeProfile: profileInput({ maxRunCostUsd: 0.5 }) });
  const rich = policyOf({ activeProfile: profileInput({ maxRunCostUsd: 5 }) });
  assert.equal(cheap.constraints.maxRunCostUsd, 0.5);
  assert.notEqual(cheap.policyId, rich.policyId);
});

test("policy: the result is DEEPLY frozen — nothing may mutate it after the fact", () => {
  const policy = policyOf({ activeProfile: profileInput() });
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.inventory));
  assert.ok(Object.isFrozen(policy.rolePreferences));
  assert.ok(Object.isFrozen(policy.rolePreferences[0]));
  assert.throws(() => {
    (policy as { policyId: string }).policyId = "tampered";
  }, TypeError);
});

// ── secrets ─────────────────────────────────────────────────────────────────

test("secrets: credential-ish parameter keys are redacted, never partially revealed", () => {
  const redacted = redactParameters({
    temperature: 0.2,
    api_key: "sk-live-SUPERSECRET",
    nested: { authToken: "bearer-SUPERSECRET", keep: "fine" },
    list: [{ password: "SUPERSECRET" }],
  });
  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes("SUPERSECRET"), false, `a secret survived: ${serialized}`);
  assert.equal(redacted.api_key, REDACTED);
  assert.equal((redacted.nested as Record<string, unknown>).keep, "fine", "non-secret values are preserved");
});

test("secrets: a policy built from a profile carrying a key never serializes it", () => {
  const policy = policyOf({
    activeProfile: profileInput({ parameters: { OPENAI_API_KEY: "sk-live-SUPERSECRET", temperature: 0.1 } }),
  });
  assert.equal(JSON.stringify(policy).includes("SUPERSECRET"), false);
  assert.equal(policy.profile?.parameters.OPENAI_API_KEY, REDACTED);
});

test("secrets: URL userinfo is stripped from an endpoint before it is published", () => {
  assert.equal(redactUrlUserinfo("https://user:SUPERSECRET@api.example/v1"), "https://api.example/v1");
  assert.equal(redactUrlUserinfo("https://api.example/v1"), "https://api.example/v1");
  const policy = policyOf({
    activeProfile: profileInput(),
    inventory: { ...INVENTORY, providers: [provider("alpha", { baseUrl: "https://u:SUPERSECRET@alpha.example/v1" }), provider("beta")] },
  });
  assert.equal(JSON.stringify(policy).includes("SUPERSECRET"), false);
});

// ── role vocabulary ─────────────────────────────────────────────────────────

test("roles: builder and critic are required; the tier map only covers known roles", () => {
  assert.deepEqual([...V2_REQUIRED_ROLES], ["builder", "critic"]);
  for (const roles of Object.values(OPERATOR_TIER_ROLES)) {
    for (const role of roles) assert.ok((V2_MODEL_ROLES as readonly string[]).includes(role), `${role} is a known role`);
  }
});

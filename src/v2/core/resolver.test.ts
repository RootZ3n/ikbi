/**
 * THE SINGLE MODEL RESOLUTION AUTHORITY — unit coverage.
 *
 * The load-bearing assertions are refusals: an explicitly pinned provider is never
 * swapped, an unreadable provider is never optimistically selected, a failed preference
 * never falls through to a lower-precedence layer, and a capability question is never
 * answered from a guess.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildRuntimeModelPolicy,
  type ActiveProfileInput,
  type ConfigurationInputs,
  type ModelCapabilityFacts,
  type ModelFactsInput,
  type ProviderFactsInput,
  type RuntimeModelPolicy,
} from "./config.js";
import { createSequentialIdFactory } from "./identity.js";
import { V2_RESOLUTION_FAILURE_CODES, resolveModelRoute, type ModelRequirements } from "./resolver.js";

const ids = createSequentialIdFactory("res");
const RUN = ids.mint("run");

const provider = (id: string, over: Partial<ProviderFactsInput> = {}): ProviderFactsInput => ({
  id,
  introspectable: true,
  kind: "openai-compatible",
  baseUrl: `https://${id}.test/v1`,
  credentialRequired: true,
  credentialPresent: true,
  ...over,
});

const KNOWN_CAPS: ModelCapabilityFacts = {
  contextWindow: 100_000,
  supportsTools: true,
  supportsThinking: false,
  reasoningLevel: "medium",
  speedClass: "medium",
  provenance: "declared",
};

/** Providers: alpha (configured), beta (configured), dry (no key), murky (unintrospectable). */
const PROVIDERS: readonly ProviderFactsInput[] = [
  provider("alpha"),
  provider("beta"),
  provider("dry", { credentialPresent: false }),
  provider("murky", { introspectable: false }),
];

const MODELS: readonly ModelFactsInput[] = [
  { id: "alpha-1", routes: [{ providerId: "alpha", providerModelId: "a1" }], capabilities: KNOWN_CAPS },
  { id: "beta-1", routes: [{ providerId: "beta", providerModelId: "b1" }], capabilities: KNOWN_CAPS },
  // A chain: the FIRST route is unusable, so the second must win — deterministically.
  { id: "chained", routes: [
      { providerId: "dry", providerModelId: "c-dry" },
      { providerId: "alpha", providerModelId: "c-alpha" },
      { providerId: "beta", providerModelId: "c-beta" },
    ], capabilities: KNOWN_CAPS },
  { id: "dry-only", routes: [{ providerId: "dry", providerModelId: "d1" }], capabilities: KNOWN_CAPS },
  { id: "murky-only", routes: [{ providerId: "murky", providerModelId: "m1" }], capabilities: KNOWN_CAPS },
  { id: "unclassified", routes: [{ providerId: "alpha", providerModelId: "u1" }] },
  { id: "no-tools", routes: [{ providerId: "alpha", providerModelId: "nt" }], capabilities: { ...KNOWN_CAPS, supportsTools: false } },
  { id: "small", routes: [{ providerId: "alpha", providerModelId: "sm" }], capabilities: { ...KNOWN_CAPS, contextWindow: 8_192 } },
  { id: "ghost-route", routes: [{ providerId: "nowhere", providerModelId: "g1" }], capabilities: KNOWN_CAPS },
];

function profile(roles: Record<string, { provider: string; model: string }>): ActiveProfileInput {
  return {
    kind: "resolved",
    profile: { name: "p", inheritanceChain: ["p"], roles, source: "active_pointer" },
  };
}

function policyOf(over: Partial<ConfigurationInputs> = {}): RuntimeModelPolicy {
  const built = buildRuntimeModelPolicy({
    inventory: { providers: PROVIDERS, models: MODELS },
    activeProfile: { kind: "none" },
    operatorDefaults: { models: [] },
    ...over,
  });
  assert.ok(built.ok, `expected a policy, got ${built.ok ? "" : built.failure.code}`);
  return built.policy;
}

/** Resolve `builder` against a policy built from these inputs. */
function resolve(over: Partial<ConfigurationInputs> = {}, requirements?: ModelRequirements) {
  const policy = policyOf(over);
  return {
    policy,
    result: resolveModelRoute(policy, {
      runId: RUN,
      policyId: policy.policyId,
      role: "builder",
      ...(requirements !== undefined ? { requirements } : {}),
    }),
  };
}

function decisionOf(over: Partial<ConfigurationInputs> = {}, requirements?: ModelRequirements) {
  const { result } = resolve(over, requirements);
  assert.ok(result.ok, `expected a decision, got ${result.ok ? "" : result.failure.code}`);
  return result.decision;
}

function failureOf(over: Partial<ConfigurationInputs> = {}, requirements?: ModelRequirements) {
  const { result } = resolve(over, requirements);
  assert.equal(result.ok, false, "expected a resolution failure");
  assert.ok(!result.ok);
  return result.failure;
}

const bothRoles = (p: string, m: string) => profile({ builder: { provider: p, model: m }, critic: { provider: "alpha", model: "alpha-1" } });

// ── the happy path ──────────────────────────────────────────────────────────

test("resolver: an explicit provider/model preference authorizes exactly that route", () => {
  const d = decisionOf({ activeProfile: bothRoles("alpha", "alpha-1") });
  assert.equal(d.role, "builder");
  assert.equal(d.modelId, "alpha-1");
  assert.equal(d.providerId, "alpha");
  assert.equal(d.providerModelId, "a1", "the wire id, not the logical id");
  assert.equal(d.providerConstraint, "explicit");
  assert.equal(d.basis, "explicit_provider_constraint");
  assert.equal(d.preferenceSource, "active_profile");
  assert.equal(d.providerReadiness, "configured");
  assert.equal(d.baseUrl, "https://alpha.test/v1", "the invocation layer selects nothing");
  assert.equal(d.providerKind, "openai-compatible");
});

test("resolver: the decision is frozen — an authorization cannot be edited after the fact", () => {
  const d = decisionOf({ activeProfile: bothRoles("alpha", "alpha-1") });
  assert.ok(Object.isFrozen(d));
  assert.throws(() => {
    (d as { modelId: string }).modelId = "beta-1";
  }, TypeError);
});

test("resolver: a keyless provider is selectable", () => {
  const keyless = { providers: [provider("k", { credentialRequired: false, credentialPresent: false })], models: [{ id: "k-1", routes: [{ providerId: "k", providerModelId: "kk" }] }] };
  const d = decisionOf({
    inventory: keyless,
    activeProfile: profile({ builder: { provider: "k", model: "k-1" }, critic: { provider: "k", model: "k-1" } }),
  });
  assert.equal(d.providerReadiness, "keyless");
});

// ── explicit provider is a constraint ───────────────────────────────────────

test("resolver: an explicitly pinned provider is NEVER swapped for a working one", () => {
  // `chained` has a perfectly good alpha route — pinning `dry` must still fail.
  const failure = failureOf({ activeProfile: bothRoles("dry", "chained") });
  assert.equal(failure.code, V2_RESOLUTION_FAILURE_CODES.providerNotSelectable);
  assert.equal(failure.detail?.provider, "dry");
  assert.equal(failure.message.includes("alpha"), false, "the failure does not even suggest a substitute");
});

test("resolver: an unregistered pinned provider fails as provider_not_registered", () => {
  // DEFENCE IN DEPTH. The configuration boundary already refuses to BUILD a policy whose
  // profile names an unregistered provider, so this path is unreachable through the
  // normal constructor — which is why the policy here is hand-assembled. The resolver
  // still checks: it is an authority, not a consumer of someone else's validation.
  const policy = policyOf({ activeProfile: bothRoles("alpha", "alpha-1") });
  const tampered = {
    ...policy,
    rolePreferences: [{ ...policy.rolePreferences.find((p) => p.role === "builder")!, providerId: "nowhere", modelId: "ghost-route" }],
  } as RuntimeModelPolicy;
  const result = resolveModelRoute(tampered, { runId: RUN, policyId: tampered.policyId, role: "builder" });
  assert.ok(!result.ok);
  assert.equal(result.failure.code, V2_RESOLUTION_FAILURE_CODES.providerNotRegistered);
});

test("resolver: a registered provider that serves no route for the model fails", () => {
  const failure = failureOf({ activeProfile: bothRoles("beta", "alpha-1") });
  assert.equal(failure.code, V2_RESOLUTION_FAILURE_CODES.noSelectableRoute);
  assert.match(failure.message, /serves no route/);
});

// ── readiness gate ──────────────────────────────────────────────────────────

test("resolver: a not_configured route is never selected", () => {
  const failure = failureOf({ operatorDefaults: { models: [{ tier: "builder", modelId: "dry-only", explicit: true }] } });
  assert.equal(failure.code, V2_RESOLUTION_FAILURE_CODES.noSelectableRoute);
  assert.match(failure.message, /dry=not_configured/);
});

test("resolver: an UNKNOWN-readiness route is never optimistically selected", () => {
  const failure = failureOf({ operatorDefaults: { models: [{ tier: "builder", modelId: "murky-only", explicit: true }] } });
  assert.equal(failure.code, V2_RESOLUTION_FAILURE_CODES.noSelectableRoute);
  assert.match(failure.message, /murky=unknown/, "an unintrospectable provider is not authorized");
});

test("resolver: a route to an unregistered provider is never selected", () => {
  const failure = failureOf({ operatorDefaults: { models: [{ tier: "builder", modelId: "ghost-route", explicit: true }] } });
  assert.equal(failure.code, V2_RESOLUTION_FAILURE_CODES.noSelectableRoute);
  assert.match(failure.message, /nowhere=not_registered/);
});

// ── model-only preference: deterministic route ordering ─────────────────────

test("resolver: with no pinned provider, the FIRST selectable route in the declared chain wins", () => {
  const d = decisionOf({ operatorDefaults: { models: [{ tier: "builder", modelId: "chained", explicit: true }] } });
  assert.equal(d.providerConstraint, "unconstrained");
  assert.equal(d.basis, "first_selectable_route");
  assert.equal(d.providerId, "alpha", "dry is skipped (no key); alpha is next in the declared order");
  assert.equal(d.providerModelId, "c-alpha");
  assert.equal(d.routeOrdinal, 1, "the ordinal records WHY, not just what");
  assert.equal(d.routeCount, 3);
});

test("resolver: route ordering is deterministic across repeated resolutions", () => {
  const inputs: Partial<ConfigurationInputs> = {
    operatorDefaults: { models: [{ tier: "builder", modelId: "chained", explicit: true }] },
  };
  assert.equal(decisionOf(inputs).decisionId, decisionOf(inputs).decisionId);
  assert.equal(decisionOf(inputs).providerId, "alpha");
});

// ── no silent substitution across precedence layers ─────────────────────────

test("resolver: a failing PROFILE preference does not fall through to the operator default", () => {
  const failure = failureOf({
    activeProfile: bothRoles("dry", "dry-only"),
    // A perfectly usable lower-precedence default exists. It must NOT rescue the run.
    operatorDefaults: { models: [{ tier: "builder", modelId: "alpha-1", explicit: true }] },
  });
  assert.equal(failure.code, V2_RESOLUTION_FAILURE_CODES.providerNotSelectable);
  assert.equal(failure.message.includes("alpha-1"), false, "the lower layer was never consulted");
});

test("resolver: a role no layer configured fails rather than defaulting to something", () => {
  const failure = failureOf();
  assert.equal(failure.code, V2_RESOLUTION_FAILURE_CODES.roleNotConfigured);
});

test("resolver: a preferred model absent from the inventory fails", () => {
  const failure = failureOf({ operatorDefaults: { models: [{ tier: "builder", modelId: "imaginary", explicit: true }] } });
  assert.equal(failure.code, V2_RESOLUTION_FAILURE_CODES.modelNotInInventory);
  assert.equal(failure.detail?.model, "imaginary");
});

// ── capability requirements ─────────────────────────────────────────────────

test("resolver: requirements are checked against DECLARED/KNOWN facts and can pass", () => {
  const d = decisionOf({ activeProfile: bothRoles("alpha", "alpha-1") }, { requiresTools: true, minContextWindow: 32_000 });
  assert.equal(d.requirements.requiresTools, true);
  assert.equal(d.requirements.minContextWindow, 32_000);
  assert.equal(d.capabilities?.contextWindow, 100_000, "static facts ride along for the invocation layer");
});

test("resolver: an unmet capability fails — it is not downgraded to a warning", () => {
  const noTools = failureOf({ activeProfile: bothRoles("alpha", "no-tools") }, { requiresTools: true });
  assert.equal(noTools.code, V2_RESOLUTION_FAILURE_CODES.capabilityUnsatisfied);
  assert.match(noTools.message, /native tool calling/);

  const tooSmall = failureOf({ activeProfile: bothRoles("alpha", "small") }, { minContextWindow: 32_000 });
  assert.equal(tooSmall.code, V2_RESOLUTION_FAILURE_CODES.capabilityUnsatisfied);
  assert.match(tooSmall.message, /8192-token window|window is 8192/);
});

test("resolver: an UNCLASSIFIED model cannot satisfy a requirement from a guess", () => {
  // v1 would hand back a conservative 8k/no-tools fallback here. v2 has no facts, so it
  // refuses rather than answering from a default dressed up as knowledge.
  const failure = failureOf({ activeProfile: bothRoles("alpha", "unclassified") }, { requiresTools: true });
  assert.equal(failure.code, V2_RESOLUTION_FAILURE_CODES.capabilityUnsatisfied);
  assert.match(failure.message, /no capability facts are known/);
});

test("resolver: an unclassified model resolves fine when NOTHING is required of it", () => {
  const d = decisionOf({ activeProfile: bothRoles("alpha", "unclassified") });
  assert.equal(d.modelId, "unclassified");
  assert.equal(d.capabilities, undefined, "no facts are invented to fill the gap");
});

test("resolver: an unrecognized requirement key is REFUSED, not silently dropped", () => {
  const policy = policyOf({ activeProfile: bothRoles("alpha", "alpha-1") });
  const result = resolveModelRoute(policy, {
    runId: RUN,
    policyId: policy.policyId,
    role: "builder",
    requirements: { mustBeCheap: true } as unknown as ModelRequirements,
  });
  assert.ok(!result.ok);
  assert.equal(result.failure.code, V2_RESOLUTION_FAILURE_CODES.unsupportedRequirement);
});

// ── request integrity ───────────────────────────────────────────────────────

test("resolver: a request naming a DIFFERENT policy is refused", () => {
  const policy = policyOf({ activeProfile: bothRoles("alpha", "alpha-1") });
  const other = policyOf({ activeProfile: bothRoles("beta", "beta-1") });
  const result = resolveModelRoute(policy, { runId: RUN, policyId: other.policyId, role: "builder" });
  assert.ok(!result.ok);
  assert.equal(result.failure.code, V2_RESOLUTION_FAILURE_CODES.policyIdentityMismatch);
});

test("resolver: an unknown role string is refused", () => {
  const policy = policyOf({ activeProfile: bothRoles("alpha", "alpha-1") });
  const result = resolveModelRoute(policy, { runId: RUN, policyId: policy.policyId, role: "astrologer" as never });
  assert.ok(!result.ok);
  assert.equal(result.failure.code, V2_RESOLUTION_FAILURE_CODES.roleUnknown);
});

test("resolver: every failure is a structured resolution failure, never null or a throw", () => {
  for (const failure of [
    failureOf(),
    failureOf({ activeProfile: bothRoles("dry", "dry-only") }),
    failureOf({ operatorDefaults: { models: [{ tier: "builder", modelId: "imaginary", explicit: true }] } }),
  ]) {
    assert.equal(failure.category, "resolution");
    assert.equal(failure.stage, "model_resolution");
    assert.equal(failure.retryable, false);
    assert.ok(failure.code.startsWith("resolution."));
  }
});

// ── decision identity ───────────────────────────────────────────────────────

test("identity: the same semantic selection yields the same decision id", () => {
  const inputs = { activeProfile: bothRoles("alpha", "alpha-1") };
  assert.equal(decisionOf(inputs).decisionId, decisionOf(inputs).decisionId);
});

test("identity: a different selected route yields a different decision id", () => {
  const a = decisionOf({ activeProfile: bothRoles("alpha", "alpha-1") });
  const b = decisionOf({ activeProfile: bothRoles("beta", "beta-1") });
  assert.notEqual(a.decisionId, b.decisionId);
  assert.notEqual(a.policyId, b.policyId, "the policy moved too — configuration is bound in");
});

test("identity: changing a requirement changes the decision id", () => {
  const bare = decisionOf({ activeProfile: bothRoles("alpha", "alpha-1") });
  const strict = decisionOf({ activeProfile: bothRoles("alpha", "alpha-1") }, { requiresTools: true });
  assert.equal(bare.providerId, strict.providerId, "the same route was chosen");
  assert.notEqual(bare.decisionId, strict.decisionId, "but under different constraints");
});

test("identity: the decision id binds the POLICY it was computed under", () => {
  const policy = policyOf({ activeProfile: bothRoles("alpha", "alpha-1") });
  const d = decisionOf({ activeProfile: bothRoles("alpha", "alpha-1") });
  assert.equal(d.policyId, policy.policyId);
});

test("identity: no credential material can reach a decision or its digest", () => {
  const d = decisionOf({
    activeProfile: bothRoles("alpha", "alpha-1"),
    inventory: {
      providers: [
        provider("alpha", { baseUrl: "https://u:SUPERSECRET@alpha.test/v1", credentialSource: "environment" }),
        ...PROVIDERS.slice(1),
      ],
      models: MODELS,
    },
  });
  assert.equal(JSON.stringify(d).includes("SUPERSECRET"), false, "userinfo was stripped upstream and never reached here");
  assert.equal(Object.keys(d).some((k) => /key|secret|token|credential/i.test(k)), false, "no credential-shaped field exists");
});

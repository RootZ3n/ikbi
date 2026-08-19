/**
 * V2-016 — LIVE ROUTE TRUTH.
 *
 * Reproduces the cutover routing debts against the SHIPPED canonical catalog, and proves the
 * operator's real daily-driver config resolves to exact real routes. INVENTORY IS FACT: preference
 * never invents a route, so a model with no declared route on a given box is truthfully unselectable
 * rather than papered over with a fallback.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCanonicalCatalog } from "./model-catalog.js";
import { capabilityFacts } from "./provider-inventory.js";
import { buildRuntimeModelPolicy } from "../core/config.js";
import { resolveModelRoute } from "../core/resolver.js";
import type { ModelFactsInput, ProviderFactsInput } from "../core/config.js";

/** A provider facts row; `ready` toggles whether its credential is present. */
function provider(id: string, ready: boolean): ProviderFactsInput {
  return { id, introspectable: true, kind: "openai-compatible", baseUrl: `https://${id}`, credentialRequired: true, credentialPresent: ready };
}

function policyFor(providers: readonly ProviderFactsInput[], roles: { driver: string; critic: string; explicit: boolean }) {
  const inventory = buildCanonicalCatalog({ providers, rosterModels: [], capabilitiesFor: (id) => capabilityFacts(id) });
  const built = buildRuntimeModelPolicy({
    inventory,
    activeProfile: { kind: "none" },
    operatorDefaults: {
      models: [
        { tier: "driver", modelId: roles.driver, explicit: roles.explicit },
        { tier: "builder", modelId: roles.driver, explicit: roles.explicit },
        { tier: "critic", modelId: roles.critic, explicit: roles.explicit },
      ],
    },
  });
  if (!built.ok) throw new Error(`policy build failed: ${built.failure.code}`);
  return built.policy;
}

const resolve = (policy: ReturnType<typeof policyFor>, role: string) =>
  resolveModelRoute(policy, { runId: "run_seed-00000001" as never, policyId: policy.policyId, role: role as never });

// ── the reproduced debt ───────────────────────────────────────────────────────

test("route truth (reproduced debt): the shipped mimo defaults are UNSELECTABLE on a deepseek-only box", () => {
  // The default builder is mimo-v2.5, which routes only to [mimo, openrouter]. With only DeepSeek
  // credentialed, that is genuinely unavailable — a TRUTHFUL no_selectable_route, not a bug to mask.
  const policy = policyFor([provider("deepseek", true), provider("mimo", false), provider("openrouter", false)], { driver: "mimo-v2.5", critic: "mimo-v2.5-pro", explicit: false });
  const builder = resolve(policy, "builder");
  assert.equal(builder.ok, false);
  if (!builder.ok) assert.equal(builder.failure.code, "resolution.no_selectable_route");
});

// ── the remediation: the real intended daily-driver config resolves EXACTLY ─────

test("route truth: the DeepSeek daily-driver config resolves builder + critic to exact real routes", () => {
  // deepseek-chat (builder) and deepseek-reasoner (critic) are real DeepSeek models with native
  // tools; on a credentialed DeepSeek box both resolve to their exact wire ids, one decision each.
  const policy = policyFor([provider("deepseek", true)], { driver: "deepseek-chat", critic: "deepseek-reasoner", explicit: true });

  const builder = resolve(policy, "builder");
  assert.ok(builder.ok, "builder resolves");
  assert.equal(builder.decision.providerId, "deepseek");
  assert.equal(builder.decision.providerModelId, "deepseek-chat", "the WIRE id is exactly the DeepSeek model — no served-route fiction");
  assert.equal(builder.decision.modelId, "deepseek-chat");

  const critic = resolve(policy, "critic");
  assert.ok(critic.ok, "critic resolves");
  assert.equal(critic.decision.providerId, "deepseek");
  assert.equal(critic.decision.providerModelId, "deepseek-reasoner");
  // Exactly one decision per role — no fallback chain walked to a second route.
  assert.equal(builder.decision.routeOrdinal, 0);
  assert.equal(critic.decision.routeOrdinal, 0);
});

// ── PROVIDER IDENTITY: provider == vendor/endpoint, model == model ─────────────
//
// The live defect this section pins. The operator's active profile pinned canonical
// provider identity (`provider: mimo / model: mimo-v2.5-pro`), while providers.json
// re-declared the SAME logical model behind a model-specific provider id
// (`mimo-v2.5-pro` — a byte-identical duplicate of the `mimo` endpoint + credential).
// Because a roster model DECLARATION REPLACES the built-in entry wholesale, the
// built-in route through `mimo` vanished from the final inventory and the pinned
// provider served no route at all. Every layer behaved correctly; the CONFIGURATION
// was impossible. These tests keep the normalized identity honest.

/** A keyless provider (credential not required), as direct MiMo is really configured. */
function keylessProvider(id: string): ProviderFactsInput {
  return { id, introspectable: true, kind: "openai-compatible", baseUrl: `https://${id}`, credentialRequired: false, credentialPresent: false };
}

/** Build a policy whose roles come from an ACTIVE PROFILE (which always pins a provider). */
function profilePolicy(
  providers: readonly ProviderFactsInput[],
  rosterModels: readonly ModelFactsInput[],
  roles: Readonly<Record<string, { readonly provider: string; readonly model: string }>>,
) {
  const inventory = buildCanonicalCatalog({ providers, rosterModels, capabilitiesFor: (id) => capabilityFacts(id) });
  const built = buildRuntimeModelPolicy({
    inventory,
    activeProfile: {
      kind: "resolved",
      profile: { name: "mimo", inheritanceChain: ["mimo"], roles, source: "active_pointer" },
    },
    operatorDefaults: { models: [] },
  });
  if (!built.ok) throw new Error(`policy build failed: ${built.failure.code}`);
  return built.policy;
}

/** The pre-repair roster: one model-specific provider per model — the shape that broke. */
const DRIFTED_ROSTER: readonly ModelFactsInput[] = [
  { id: "mimo-v2.5", role: "driver", routes: [{ providerId: "mimo-v2.5", providerModelId: "mimo-v2.5" }] },
  { id: "mimo-v2.5-pro", role: "critic", routes: [{ providerId: "mimo-v2.5-pro", providerModelId: "mimo-v2.5-pro" }] },
];

/** The repaired roster: canonical vendor identity, real wire ids preserved. */
const NORMALIZED_ROSTER: readonly ModelFactsInput[] = [
  { id: "mimo-v2.5", role: "driver", routes: [{ providerId: "mimo", providerModelId: "mimo-v2.5" }] },
  { id: "mimo-v2.5-pro", role: "critic", routes: [{ providerId: "mimo", providerModelId: "mimo-v2.5-pro" }] },
  { id: "deepseek-v4-flash", role: "driver", routes: [{ providerId: "deepseek", providerModelId: "deepseek-v4-flash" }] },
  { id: "deepseek-v4-pro", role: "critic", routes: [{ providerId: "deepseek", providerModelId: "deepseek-v4-pro" }] },
];

// A. The MECHANISM, made visible: a roster model declaration REPLACES the built-in entry.

test("provider identity (mechanism): a roster model declaration REPLACES the built-in route chain", () => {
  // The built-in mimo-v2.5-pro declares [mimo, deepseek]. A roster entry for the same logical
  // id does not MERGE with it — it replaces it — so re-declaring the model behind a different
  // provider id silently removes the built-in route through `mimo`. That is the whole defect.
  const builtinOnly = buildCanonicalCatalog({ providers: [keylessProvider("mimo")], rosterModels: [], capabilitiesFor: () => undefined });
  const builtin = builtinOnly.models.find((m) => m.id === "mimo-v2.5-pro");
  assert.deepEqual(builtin?.routes.map((r) => r.providerId), ["mimo", "deepseek"], "the shipped built-in routes through canonical `mimo`");

  const drifted = buildCanonicalCatalog({ providers: [keylessProvider("mimo")], rosterModels: DRIFTED_ROSTER, capabilitiesFor: () => undefined });
  const replaced = drifted.models.find((m) => m.id === "mimo-v2.5-pro");
  assert.deepEqual(replaced?.routes.map((r) => r.providerId), ["mimo-v2.5-pro"], "the roster REPLACED the chain — `mimo` is gone");
  assert.ok(!(replaced?.routes ?? []).some((r) => r.providerId === "mimo"), "no built-in route survives the upsert to be fallen back on");
});

// F. The resolver must keep failing closed when the mismatch reaches it.

test("provider identity (fail closed): a profile pinning `mimo` against a model routed via `mimo-v2.5-pro` is REFUSED", () => {
  const policy = profilePolicy(
    [keylessProvider("mimo"), keylessProvider("mimo-v2.5-pro")], // BOTH registered — the duplicate exists
    DRIFTED_ROSTER,
    { builder: { provider: "mimo", model: "mimo-v2.5-pro" }, critic: { provider: "mimo", model: "mimo-v2.5-pro" } },
  );

  for (const role of ["builder", "critic"] as const) {
    const r = resolve(policy, role);
    assert.equal(r.ok, false, `${role} must refuse an impossible provider/model pairing`);
    if (!r.ok) {
      assert.equal(r.failure.code, "resolution.no_selectable_route");
      // The pinned provider IS registered — it just serves no route for this model. The resolver
      // must never quietly serve the model through the duplicate `mimo-v2.5-pro` provider.
      assert.match(r.failure.message, /provider "mimo" is registered but serves no route for model "mimo-v2\.5-pro"/);
    }
  }
});

// D. The policy layer reports the same truth BEFORE a run (what doctor reads).

test("provider identity (pre-flight): a profile-pinned provider absent from the model's routes is UNSATISFIABLE", () => {
  const policy = profilePolicy(
    [keylessProvider("mimo"), keylessProvider("mimo-v2.5-pro")],
    DRIFTED_ROSTER,
    { builder: { provider: "mimo", model: "mimo-v2.5-pro" }, critic: { provider: "mimo", model: "mimo-v2.5-pro" } },
  );
  const builder = policy.rolePreferences.find((p) => p.role === "builder");
  assert.equal(builder?.modelInInventory, true, "the model exists — this is NOT a missing-model failure");
  assert.equal(builder?.providerRegistered, true, "the pinned provider exists — NOT a missing-provider failure");
  assert.equal(builder?.satisfiable, false, "yet the pairing is impossible, and doctor must say so before a build");
  assert.ok(policy.unsatisfiableRequiredRoles.includes("builder"));
});

// B. The repaired roster: both MiMo models route through canonical `mimo`.

test("provider identity (repaired): mimo-v2.5 and mimo-v2.5-pro both resolve through canonical provider `mimo`", () => {
  const policy = profilePolicy(
    [keylessProvider("mimo")], // the duplicate providers are RETIRED — only the vendor id remains
    NORMALIZED_ROSTER,
    { builder: { provider: "mimo", model: "mimo-v2.5-pro" }, critic: { provider: "mimo", model: "mimo-v2.5-pro" } },
  );

  const builder = resolve(policy, "builder");
  assert.ok(builder.ok, "builder resolves through canonical provider identity");
  assert.equal(builder.decision.providerId, "mimo");
  assert.equal(builder.decision.providerModelId, "mimo-v2.5-pro", "the WIRE id stays the real MiMo model id");
  assert.equal(builder.decision.basis, "explicit_provider_constraint", "the profile's provider pin is honored, not inferred");

  const critic = resolve(policy, "critic");
  assert.ok(critic.ok, "critic resolves through the same canonical route");
  assert.equal(critic.decision.providerId, "mimo");
  assert.equal(critic.decision.providerModelId, "mimo-v2.5-pro");

  // NO HIDDEN FALLBACK: each model declares exactly one route, so a served identity of
  // `mimo` cannot have been reached by walking past a failed first choice.
  assert.equal(builder.decision.routeCount, 1);
  assert.equal(builder.decision.routeOrdinal, 0);
  assert.equal(critic.decision.routeCount, 1);
});

// C. The same normalization for DeepSeek.

test("provider identity (repaired): deepseek-v4-flash/pro resolve through canonical provider `deepseek`", () => {
  const policy = profilePolicy(
    [provider("deepseek", true)],
    NORMALIZED_ROSTER,
    { builder: { provider: "deepseek", model: "deepseek-v4-pro" }, critic: { provider: "deepseek", model: "deepseek-v4-flash" } },
  );

  const builder = resolve(policy, "builder");
  assert.ok(builder.ok);
  assert.equal(builder.decision.providerId, "deepseek");
  assert.equal(builder.decision.providerModelId, "deepseek-v4-pro");

  const critic = resolve(policy, "critic");
  assert.ok(critic.ok);
  assert.equal(critic.decision.providerId, "deepseek");
  assert.equal(critic.decision.providerModelId, "deepseek-v4-flash");
});

// The general invariant, stated once: a pinned provider must appear among the model's routes.

test("provider identity (invariant): every profile-pinned provider appears in its model's final route chain", () => {
  const inventory = buildCanonicalCatalog({
    providers: [keylessProvider("mimo"), provider("deepseek", true)],
    rosterModels: NORMALIZED_ROSTER,
    capabilitiesFor: (id) => capabilityFacts(id),
  });
  const roles = {
    builder: { provider: "mimo", model: "mimo-v2.5-pro" },
    critic: { provider: "mimo", model: "mimo-v2.5-pro" },
    scout: { provider: "deepseek", model: "deepseek-v4-flash" },
  };
  for (const [role, pin] of Object.entries(roles)) {
    const model = inventory.models.find((m) => m.id === pin.model);
    assert.ok(model !== undefined, `${role}: model ${pin.model} is in the inventory`);
    assert.ok(
      model.routes.some((r) => r.providerId === pin.provider),
      `${role}: pinned provider '${pin.provider}' must serve a route for '${pin.model}' — otherwise the pairing is impossible`,
    );
  }
});

/**
 * The provider adapter — restating v1's registry as credential-free v2 facts.
 *
 * The two things that matter: it must not invent readiness for a provider that cannot
 * describe itself, and it must have no way to carry a key even when one is sitting
 * right there on the provider object.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModelProvider, ProviderPreflightInfo } from "../../core/provider/contract.js";
import { ModelRegistry } from "../../core/provider/registry.js";
import { buildProviderInventory } from "../core/config.js";
import { modelFacts, providerFacts, readProviderInventory } from "./provider-inventory.js";

/** A provider that behaves like a real one, including holding a secret it must not leak. */
function fakeProvider(id: string, info?: Partial<ProviderPreflightInfo>): ModelProvider {
  const secretKey = "sk-live-SUPERSECRET";
  return {
    id,
    // A real credential lives on the object — exactly as it does in production.
    apiKey: secretKey,
    ready: () => true,
    ...(info === undefined
      ? {}
      : {
          preflightInfo: (): ProviderPreflightInfo => ({
            kind: "openai-compatible",
            baseUrl: `https://${id}.example/v1`,
            credentialRequired: true,
            credentialPresent: true,
            ...info,
          }),
        }),
    invoke: () => Promise.reject(new Error("this test never invokes a model")),
  } as unknown as ModelProvider;
}

test("provider adapter: preflight metadata becomes credential-free facts", () => {
  const facts = providerFacts(fakeProvider("alpha", { credentialSource: "environment" }));
  assert.equal(facts.id, "alpha");
  assert.equal(facts.introspectable, true);
  assert.equal(facts.credentialPresent, true);
  assert.equal(facts.credentialSource, "environment");
  assert.equal(JSON.stringify(facts).includes("SUPERSECRET"), false, "the key is not carried");
});

test("provider adapter: a provider with no preflight metadata is UNKNOWN, not assumed ready", () => {
  const facts = providerFacts(fakeProvider("legacy"));
  assert.equal(facts.introspectable, false);
  assert.equal(buildProviderInventory({ providers: [facts], models: [] }).providers[0]?.readiness, "unknown");
  assert.equal(
    buildProviderInventory({ providers: [facts], models: [] }).providersConfigured,
    0,
    "`ready() === true` alone does not make a provider count as configured",
  );
});

test("provider adapter: a model's ordered fallback chain survives intact", () => {
  const facts = modelFacts({
    id: "m1",
    role: "builder",
    cost: { promptPerMTok: 1, completionPerMTok: 1 },
    providers: [
      { provider: "primary", providerModelId: "p-m1" },
      { provider: "backup", providerModelId: "b-m1" },
    ],
  });
  assert.deepEqual(facts.routes, [
    { providerId: "primary", providerModelId: "p-m1" },
    { providerId: "backup", providerModelId: "b-m1" },
  ]);
  assert.equal(facts.role, "builder");
});

test("provider adapter: reading a REAL ModelRegistry produces a usable inventory", () => {
  const registry = new ModelRegistry({
    providers: [fakeProvider("alpha", {}), fakeProvider("dry", { credentialPresent: false })],
    models: [
      {
        id: "alpha-1",
        cost: { promptPerMTok: 1, completionPerMTok: 2 },
        providers: [{ provider: "alpha", providerModelId: "a1" }],
      },
      {
        id: "dry-1",
        cost: { promptPerMTok: 1, completionPerMTok: 2 },
        providers: [{ provider: "dry", providerModelId: "d1" }],
      },
    ],
  });
  const inventory = buildProviderInventory(readProviderInventory(registry));
  assert.deepEqual(inventory.providers.map((p) => p.id), ["alpha", "dry"]);
  assert.equal(inventory.providers.find((p) => p.id === "alpha")?.readiness, "configured");
  assert.equal(inventory.providers.find((p) => p.id === "dry")?.readiness, "not_configured");
  assert.equal(inventory.modelsInvocable, 1);
  assert.equal(JSON.stringify(inventory).includes("SUPERSECRET"), false, "no credential reaches the inventory");
});

test("provider adapter: cost rates are NOT carried into the configuration boundary", () => {
  // Cost belongs to accounting, not to "what can this machine invoke". Keeping it out
  // stops the policy digest from moving when a price changes.
  const facts = modelFacts({
    id: "m1",
    cost: { promptPerMTok: 99, completionPerMTok: 99 },
    providers: [{ provider: "p", providerModelId: "x" }],
  });
  assert.equal(JSON.stringify(facts).includes("99"), false);
});

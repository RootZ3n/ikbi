/**
 * THE CANONICAL CATALOG — inventory as fact.
 *
 * Two defects are pinned here. Preference must not suppress a genuinely available
 * model, and preference must not reroute a real one. Both are impossible by
 * construction now — `buildCanonicalCatalog` has no parameter a preference fits into —
 * so these tests assert the composition rules that replace the old filtering.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildProviderInventory, type ModelFactsInput, type ProviderFactsInput } from "../core/config.js";
import {
  V2_AUTO_DISCOVERY_FACTS,
  V2_BUILTIN_CATALOG,
  buildCanonicalCatalog,
  discoveredModels,
} from "./model-catalog.js";

const provider = (id: string, over: Partial<ProviderFactsInput> = {}): ProviderFactsInput => ({
  id,
  introspectable: true,
  kind: "openai-compatible",
  baseUrl: `https://${id}.test/v1`,
  credentialRequired: true,
  credentialPresent: true,
  ...over,
});

const BASE_PROVIDERS = [provider("mimo"), provider("openrouter"), provider("deepseek")];
const idsOf = (models: readonly ModelFactsInput[]) => models.map((m) => m.id);

// ── built-in catalog ────────────────────────────────────────────────────────

test("catalog: every shipped built-in is present, with its true routes", () => {
  const catalog = buildCanonicalCatalog({ providers: BASE_PROVIDERS, rosterModels: [] });
  const byId = new Map(catalog.models.map((m) => [m.id, m]));
  for (const builtin of V2_BUILTIN_CATALOG) {
    const found = byId.get(builtin.id);
    assert.ok(found !== undefined, `built-in ${builtin.id} is in the catalog`);
    assert.deepEqual(found.routes.map((r) => `${r.providerId}/${r.providerModelId}`), builtin.routes.map((r) => `${r.providerId}/${r.providerModelId}`));
  }
});

test("catalog: the built-ins cover the DeepSeek family and the escalation stub, not just MiMo", () => {
  // The V2-003 catalog knew only about MiMo; a preference colliding with any other
  // built-in could make it vanish. All six shipped entries are now first-class.
  assert.deepEqual(idsOf(V2_BUILTIN_CATALOG), [
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "deepseek-chat",
    "deepseek-reasoner",
    "deepseek-v4-flash",
    "opus-4.8",
  ]);
});

test("catalog: the escalation stub is present but honestly unroutable", () => {
  const inventory = buildProviderInventory(buildCanonicalCatalog({ providers: BASE_PROVIDERS, rosterModels: [] }));
  const opus = inventory.models.find((m) => m.id === "opus-4.8")!;
  assert.equal(opus.routes[0]?.providerId, "stub");
  assert.equal(opus.routable, false, "the stub provider is deliberately unregistered");
  assert.equal(opus.invocable, false);
});

// ── auto-discovery ──────────────────────────────────────────────────────────

test("catalog: a credentialed provider contributes its model", () => {
  const discovered = discoveredModels([...BASE_PROVIDERS, provider("openai")]);
  const gpt = discovered.find((m) => m.id === "gpt-4o");
  assert.ok(gpt !== undefined, "an OpenAI credential makes gpt-4o available");
  assert.equal(gpt.routes[0]?.providerId, "openai");
  assert.equal(gpt.routes[0]?.providerModelId, "gpt-4o");
});

test("catalog: an UNCREDENTIALED provider contributes nothing", () => {
  assert.deepEqual(idsOf(discoveredModels([provider("openai", { credentialPresent: false })])), []);
});

test("catalog: an UNINTROSPECTABLE provider contributes nothing — unknown is not usable", () => {
  assert.deepEqual(idsOf(discoveredModels([provider("openai", { introspectable: false })])), []);
});

test("catalog: an unregistered provider contributes nothing", () => {
  assert.deepEqual(idsOf(discoveredModels(BASE_PROVIDERS)), [], "no minimax/openai/anthropic/google/groq registered");
});

test("catalog: a keyless provider still contributes", () => {
  const discovered = discoveredModels([provider("groq", { credentialRequired: false, credentialPresent: false })]);
  assert.deepEqual(idsOf(discovered), ["llama-3.3-70b"]);
});

test("catalog: every auto-discovery fact names a distinct provider and model", () => {
  const providers = V2_AUTO_DISCOVERY_FACTS.map((f) => f.providerId);
  const models = V2_AUTO_DISCOVERY_FACTS.map((f) => f.modelId);
  assert.equal(new Set(providers).size, providers.length, "one contribution per provider");
  assert.equal(new Set(models).size, models.length, "no duplicate semantic entries");
  const builtinIds = new Set(idsOf(V2_BUILTIN_CATALOG));
  for (const id of models) assert.equal(builtinIds.has(id), false, `${id} is not also a built-in`);
});

// ── precedence ──────────────────────────────────────────────────────────────

test("catalog: the ROSTER overrides a built-in of the same id", () => {
  const roster: ModelFactsInput = { id: "mimo-v2.5", routes: [{ providerId: "deepseek", providerModelId: "operator-choice" }] };
  const catalog = buildCanonicalCatalog({ providers: BASE_PROVIDERS, rosterModels: [roster] });
  assert.equal(catalog.models.find((m) => m.id === "mimo-v2.5")?.routes[0]?.providerModelId, "operator-choice");
});

test("catalog: the ROSTER overrides an auto-discovered model of the same id", () => {
  const roster: ModelFactsInput = { id: "gpt-4o", routes: [{ providerId: "openrouter", providerModelId: "openai/gpt-4o" }] };
  const catalog = buildCanonicalCatalog({ providers: [...BASE_PROVIDERS, provider("openai")], rosterModels: [roster] });
  assert.equal(catalog.models.find((m) => m.id === "gpt-4o")?.routes[0]?.providerId, "openrouter");
});

test("catalog: auto-discovery FILLS GAPS only — it never displaces a built-in", () => {
  // Mirrors v1's own rule (`autoDiscoverProviders` skips a model already present).
  const withEverything = buildCanonicalCatalog({ providers: [...BASE_PROVIDERS, provider("openai")], rosterModels: [] });
  assert.equal(withEverything.models.find((m) => m.id === "mimo-v2.5")?.routes[0]?.providerId, "mimo");
});

test("catalog: membership is deterministically ordered", () => {
  const a = buildCanonicalCatalog({ providers: [...BASE_PROVIDERS, provider("openai")], rosterModels: [] });
  const b = buildCanonicalCatalog({ providers: [provider("openai"), ...[...BASE_PROVIDERS].reverse()], rosterModels: [] });
  assert.deepEqual(idsOf(a.models), idsOf(b.models));
  assert.deepEqual(idsOf(a.models), [...idsOf(a.models)].sort());
});

// ── capability facts ────────────────────────────────────────────────────────

test("catalog: capability facts fill only entries that have none", () => {
  const roster: ModelFactsInput = {
    id: "declared",
    routes: [{ providerId: "mimo", providerModelId: "d" }],
    capabilities: { contextWindow: 1, supportsTools: false, reasoningLevel: "low", speedClass: "fast", provenance: "declared" },
  };
  const catalog = buildCanonicalCatalog({
    providers: BASE_PROVIDERS,
    rosterModels: [roster],
    capabilitiesFor: () => ({ contextWindow: 999, supportsTools: true, reasoningLevel: "high", speedClass: "slow", provenance: "known" }),
  });
  assert.equal(catalog.models.find((m) => m.id === "declared")?.capabilities?.contextWindow, 1, "declared facts survive");
  assert.equal(catalog.models.find((m) => m.id === "mimo-v2.5")?.capabilities?.contextWindow, 999, "built-ins get theirs");
});

// ── digest semantics ────────────────────────────────────────────────────────

test("digest: a REAL capability change moves the digest", () => {
  const base = buildProviderInventory(buildCanonicalCatalog({ providers: BASE_PROVIDERS, rosterModels: [] }));
  const withKey = buildProviderInventory(buildCanonicalCatalog({ providers: [...BASE_PROVIDERS, provider("openai")], rosterModels: [] }));
  assert.notEqual(base.digest, withKey.digest, "a newly reachable provider IS a capability change");
});

test("digest: losing a credential moves the digest — the model really is gone", () => {
  const withKey = buildProviderInventory(buildCanonicalCatalog({ providers: [...BASE_PROVIDERS, provider("openai")], rosterModels: [] }));
  const without = buildProviderInventory(
    buildCanonicalCatalog({ providers: [...BASE_PROVIDERS, provider("openai", { credentialPresent: false })], rosterModels: [] }),
  );
  assert.notEqual(withKey.digest, without.digest);
  assert.equal(without.models.some((m) => m.id === "gpt-4o"), false);
});

test("digest: a roster addition moves the digest", () => {
  const base = buildProviderInventory(buildCanonicalCatalog({ providers: BASE_PROVIDERS, rosterModels: [] }));
  const more = buildProviderInventory(
    buildCanonicalCatalog({ providers: BASE_PROVIDERS, rosterModels: [{ id: "new", routes: [{ providerId: "mimo", providerModelId: "n" }] }] }),
  );
  assert.notEqual(base.digest, more.digest);
});

test("digest: a route change on an existing model moves the digest", () => {
  const base = buildProviderInventory(buildCanonicalCatalog({ providers: BASE_PROVIDERS, rosterModels: [] }));
  const rerouted = buildProviderInventory(
    buildCanonicalCatalog({
      providers: BASE_PROVIDERS,
      rosterModels: [{ id: "mimo-v2.5", routes: [{ providerId: "openrouter", providerModelId: "mimo-v2.5" }] }],
    }),
  );
  assert.notEqual(base.digest, rerouted.digest);
});

test("digest: identical facts assembled in a different order give an identical digest", () => {
  const a = buildProviderInventory(buildCanonicalCatalog({ providers: [...BASE_PROVIDERS, provider("openai")], rosterModels: [] }));
  const b = buildProviderInventory(buildCanonicalCatalog({ providers: [provider("openai"), ...BASE_PROVIDERS], rosterModels: [] }));
  assert.equal(a.digest, b.digest);
});

// ── the structural guarantee ────────────────────────────────────────────────

test("catalog: the builder's inputs cannot express a preference at all", () => {
  // The real guarantee is a type, not a runtime check: `CanonicalCatalogSources` has
  // fields for providers, roster models and a capability lookup — and nothing else.
  // This test documents the invariant the signature enforces.
  const sources = { providers: BASE_PROVIDERS, rosterModels: [] };
  assert.deepEqual(Object.keys(sources).sort(), ["providers", "rosterModels"]);
  const withPreference = buildCanonicalCatalog({ ...sources, ...({ preferredModel: "anything" } as object) });
  assert.deepEqual(idsOf(withPreference.models), idsOf(buildCanonicalCatalog(sources).models), "an extra field changes nothing");
});

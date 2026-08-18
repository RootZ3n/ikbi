/**
 * INVENTORY INDEPENDENCE — the remediation for v1's preference/availability conflation.
 *
 * The requirement, stated as tests: expressing a PREFERENCE must not add, rename, or
 * delete anything from the set of models this machine can reach. Only a change to the
 * actual roster or provider set may do that.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildProviderInventory, type ModelFactsInput, type ProviderFactsInput, type ProviderInventoryInput } from "../core/config.js";
import { STABLE_BUILTIN_MODEL_IDS, V2_BUILTIN_CATALOG, isPreferenceArtifact, stabilizeInventory } from "./model-catalog.js";

const provider = (id: string): ProviderFactsInput => ({
  id,
  introspectable: true,
  kind: "openai-compatible",
  baseUrl: `https://${id}.test/v1`,
  credentialRequired: false,
  credentialPresent: false,
});

const PROVIDERS = [provider("mimo"), provider("openrouter"), provider("deepseek")];

/**
 * What v1's registry looks like for a given configured tier pair — the built-in driver
 * and critic entries are NAMED AFTER the preference, exactly as `buildDefaultRegistry`
 * does at `src/core/provider/index.ts:128-146`.
 */
function v1Observed(driver: string, critic: string, extra: readonly ModelFactsInput[] = []): ProviderInventoryInput {
  return {
    providers: PROVIDERS,
    models: [
      { id: driver, role: "driver", routes: [{ providerId: "mimo", providerModelId: driver }, { providerId: "openrouter", providerModelId: driver }] },
      { id: critic, role: "critic", routes: [{ providerId: "mimo", providerModelId: critic }, { providerId: "deepseek", providerModelId: critic }] },
      { id: "deepseek-chat", role: "driver", routes: [{ providerId: "deepseek", providerModelId: "deepseek-chat" }] },
      ...extra,
    ],
  };
}

const stabilize = (observed: ProviderInventoryInput, driver: string, critic: string, rosterIds: readonly string[] = []) =>
  stabilizeInventory(observed, { preferenceDerivedIds: [driver, critic], rosterDeclaredIds: rosterIds });

const idsOf = (inv: ProviderInventoryInput) => inv.models.map((m) => m.id).sort();

// ── the defect, restated ────────────────────────────────────────────────────

test("catalog: v1's observed inventory really does change with a mere preference", () => {
  // Not a v2 assertion — a statement of the problem, so the fix has something to fix.
  assert.notDeepEqual(idsOf(v1Observed("mimo-v2.5", "mimo-v2.5-pro")), idsOf(v1Observed("totally-made-up", "mimo-v2.5-pro")));
});

// ── the fix ─────────────────────────────────────────────────────────────────

test("catalog: a preference for a model that exists NOWHERE cannot invent it", () => {
  const stabilized = stabilize(v1Observed("totally-made-up", "mimo-v2.5-pro"), "totally-made-up", "mimo-v2.5-pro");
  assert.equal(stabilized.models.some((m) => m.id === "totally-made-up"), false, "the fabricated entry is gone");
  assert.ok(stabilized.models.some((m) => m.id === "mimo-v2.5"), "the real built-in is restored");
});

test("catalog: changing IKBI_MODEL_* alone does NOT change inventory membership", () => {
  const asShipped = stabilize(v1Observed("mimo-v2.5", "mimo-v2.5-pro"), "mimo-v2.5", "mimo-v2.5-pro");
  const preferred = stabilize(v1Observed("totally-made-up", "another-invention"), "totally-made-up", "another-invention");
  assert.deepEqual(idsOf(asShipped), idsOf(preferred));
});

test("catalog: changing IKBI_MODEL_* alone does NOT change the inventory DIGEST", () => {
  const a = buildProviderInventory(stabilize(v1Observed("mimo-v2.5", "mimo-v2.5-pro"), "mimo-v2.5", "mimo-v2.5-pro"));
  const b = buildProviderInventory(stabilize(v1Observed("totally-made-up", "another-invention"), "totally-made-up", "another-invention"));
  assert.equal(a.digest, b.digest, "preference is not capability");
});

test("catalog: preferring a STABLE BUILT-IN does not delete it", () => {
  // v1 renames the driver slot to `deepseek-v4-flash`; that id is a real shipped entry,
  // so it must survive rather than being mistaken for an artifact.
  const observed = v1Observed("deepseek-v4-flash", "mimo-v2.5-pro");
  const stabilized = stabilize(observed, "deepseek-v4-flash", "mimo-v2.5-pro");
  assert.ok(stabilized.models.some((m) => m.id === "deepseek-v4-flash"));
  assert.ok(stabilized.models.some((m) => m.id === "mimo-v2.5"), "and the built-in driver is back");
});

test("catalog: a ROSTER-DECLARED model is always real, whatever the preference says", () => {
  const observed = v1Observed("custom-local", "mimo-v2.5-pro", [
    { id: "custom-local", routes: [{ providerId: "mimo", providerModelId: "custom-local" }] },
  ]);
  const stabilized = stabilize(observed, "custom-local", "mimo-v2.5-pro", ["custom-local"]);
  assert.ok(stabilized.models.some((m) => m.id === "custom-local"), "the operator declared it — it exists");
});

test("catalog: a roster declaration WINS over the seeded built-in of the same id", () => {
  const observed: ProviderInventoryInput = {
    providers: PROVIDERS,
    models: [{ id: "mimo-v2.5", routes: [{ providerId: "deepseek", providerModelId: "operator-override" }] }],
  };
  const stabilized = stabilize(observed, "mimo-v2.5", "mimo-v2.5-pro", ["mimo-v2.5"]);
  const entry = stabilized.models.find((m) => m.id === "mimo-v2.5")!;
  assert.equal(entry.routes[0]?.providerModelId, "operator-override", "v2 restores a default, it does not override the operator");
});

test("catalog: a REAL roster change DOES move the inventory digest", () => {
  const base = buildProviderInventory(stabilize(v1Observed("mimo-v2.5", "mimo-v2.5-pro"), "mimo-v2.5", "mimo-v2.5-pro"));
  const extended = buildProviderInventory(
    stabilize(
      v1Observed("mimo-v2.5", "mimo-v2.5-pro", [{ id: "new-model", routes: [{ providerId: "mimo", providerModelId: "nm" }] }]),
      "mimo-v2.5",
      "mimo-v2.5-pro",
      ["new-model"],
    ),
  );
  assert.notEqual(base.digest, extended.digest);
});

test("catalog: a provider change moves the digest too", () => {
  const base = buildProviderInventory(stabilize(v1Observed("mimo-v2.5", "mimo-v2.5-pro"), "mimo-v2.5", "mimo-v2.5-pro"));
  const observed = v1Observed("mimo-v2.5", "mimo-v2.5-pro");
  const more = buildProviderInventory(
    stabilize({ ...observed, providers: [...observed.providers, provider("groq")] }, "mimo-v2.5", "mimo-v2.5-pro"),
  );
  assert.notEqual(base.digest, more.digest);
});

// ── the rule itself ─────────────────────────────────────────────────────────

test("catalog: the artifact rule requires ALL THREE conditions", () => {
  const ctx = { preferenceDerivedIds: ["x"], rosterDeclaredIds: ["y"] };
  assert.equal(isPreferenceArtifact("x", ctx), true, "preference-named, undeclared, not a built-in");
  assert.equal(isPreferenceArtifact("y", ctx), false, "not preference-named");
  assert.equal(isPreferenceArtifact("x", { ...ctx, rosterDeclaredIds: ["x"] }), false, "roster-declared");
  for (const id of STABLE_BUILTIN_MODEL_IDS) {
    assert.equal(isPreferenceArtifact(id, { preferenceDerivedIds: [id], rosterDeclaredIds: [] }), false, `${id} is a real built-in`);
  }
});

test("catalog: the seeded built-ins carry their SHIPPED ids and routes", () => {
  assert.deepEqual(V2_BUILTIN_CATALOG.map((m) => m.id), ["mimo-v2.5", "mimo-v2.5-pro"]);
  const driver = V2_BUILTIN_CATALOG[0]!;
  assert.deepEqual(driver.routes.map((r) => r.providerId), ["mimo", "openrouter"]);
  assert.deepEqual(driver.routes.map((r) => r.providerModelId), ["mimo-v2.5", "mimo-v2.5"], "the wire id is the shipped id, not a preference");
});

test("catalog: capability facts are filled in for SEEDED entries only", () => {
  const declared: ModelFactsInput = {
    id: "already-known",
    routes: [{ providerId: "mimo", providerModelId: "ak" }],
    capabilities: { contextWindow: 1, supportsTools: false, reasoningLevel: "low", speedClass: "fast", provenance: "declared" },
  };
  const stabilized = stabilizeInventory(
    { providers: PROVIDERS, models: [declared] },
    {
      preferenceDerivedIds: [],
      rosterDeclaredIds: ["already-known"],
      capabilitiesFor: () => ({ contextWindow: 999, supportsTools: true, reasoningLevel: "high", speedClass: "slow", provenance: "known" }),
    },
  );
  assert.equal(stabilized.models.find((m) => m.id === "already-known")?.capabilities?.contextWindow, 1, "observed facts are not overwritten");
  assert.equal(stabilized.models.find((m) => m.id === "mimo-v2.5")?.capabilities?.contextWindow, 999, "seeded entries get theirs");
});

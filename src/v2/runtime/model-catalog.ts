/**
 * INVENTORY INDEPENDENCE — separating "models that EXIST" from "models we PREFER".
 *
 * THE DEFECT (v1, `src/core/provider/index.ts:122-148`): `buildDefaultRegistry` names its
 * two built-in catalog entries after the operator's CONFIGURED PREFERENCE —
 * `const { driver, critic } = pc.defaultModels` and then `{ id: driver, … providerModelId: driver }`.
 * A preference is therefore not a choice among available models; it MINTS one.
 *
 * Demonstrated: with `IKBI_MODEL_DRIVER=totally-made-up-model`, a model by that name
 * appears in the registry — routed to mimo and openrouter — and the inventory digest
 * moves. A model that exists nowhere becomes "available". Conversely, setting the
 * preference to something real DELETES `mimo-v2.5` from the catalog, because the entry
 * that would have carried that id was renamed.
 *
 * WHY V2 CANNOT INHERIT IT: the resolver's whole job is to choose FROM the inventory. If
 * expressing a preference also edits the inventory, then "the preferred model is
 * available" is a tautology and the availability check means nothing.
 *
 * THE FIX, kept as small as the defect allows and entirely inside v2:
 *
 *   1. DROP entries that exist only because they were named as a preference — an id
 *      equal to a configured tier value that neither the operator's roster declares nor
 *      v1's stable built-in catalog contains.
 *   2. SEED the stable built-in catalog under its SHIPPED ids, so the two built-in
 *      models are present regardless of what the operator prefers.
 *   3. Leave everything else — roster-declared and key-auto-discovered models — exactly
 *      as observed. A roster declaration always wins over the seeded default.
 *
 * v1 is not modified. The registry keeps behaving as it does; v2 simply refuses to treat
 * a preference artifact as evidence of availability.
 */

import type { ModelCapabilityFacts, ModelFactsInput, ProviderInventoryInput } from "../core/config.js";

/**
 * Model ids v1's `buildDefaultRegistry` declares as LITERALS — genuinely shipped
 * catalog entries, not preference artifacts. Mirrors `src/core/provider/index.ts`.
 * `mimo-v2.5` / `mimo-v2.5-pro` are the shipped values of the two parameterized slots
 * (see `src/core/config.ts:474,477`), so they belong here too: they are what the
 * built-in catalog IS when nobody has expressed a preference.
 */
export const STABLE_BUILTIN_MODEL_IDS: readonly string[] = [
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "deepseek-chat",
  "deepseek-reasoner",
  "deepseek-v4-flash",
  "opus-4.8",
];

/**
 * The two built-in catalog entries under their SHIPPED ids and routes — the same
 * entries `buildDefaultRegistry` produces when no preference is configured, with the
 * parameterization removed. Routes mirror v1 exactly, including the critic's slightly
 * surprising second route through DeepSeek.
 */
export const V2_BUILTIN_CATALOG: readonly ModelFactsInput[] = Object.freeze([
  Object.freeze({
    id: "mimo-v2.5",
    role: "driver",
    routes: Object.freeze([
      { providerId: "mimo", providerModelId: "mimo-v2.5" },
      { providerId: "openrouter", providerModelId: "mimo-v2.5" },
    ]),
  }),
  Object.freeze({
    id: "mimo-v2.5-pro",
    role: "critic",
    routes: Object.freeze([
      { providerId: "mimo", providerModelId: "mimo-v2.5-pro" },
      { providerId: "deepseek", providerModelId: "mimo-v2.5-pro" },
    ]),
  }),
]) as readonly ModelFactsInput[];

/** What the caller must tell the stabilizer about the machine's preference state. */
export interface CatalogContext {
  /**
   * The model ids v1's registry construction parameterizes — `defaultModels.driver` and
   * `.critic`. NOT `.builder`: `buildDefaultRegistry` never names an entry after it.
   */
  readonly preferenceDerivedIds: readonly string[];
  /** Model ids the operator's roster file actually declares. Those are always real. */
  readonly rosterDeclaredIds: readonly string[];
  /** Attach capability facts to a model id, when any are truthfully known. */
  readonly capabilitiesFor?: (model: ModelFactsInput) => ModelCapabilityFacts | undefined;
}

/**
 * Is this observed entry an artifact of a preference rather than a real catalog member?
 *
 * True only when ALL three hold: the id matches a configured tier value, the roster does
 * not declare it, and it is not one of the stable built-ins. The conjunction matters —
 * preferring `mimo-v2.5` (the shipped default) or a roster-declared model must not
 * delete a model that genuinely exists.
 */
export function isPreferenceArtifact(id: string, context: CatalogContext): boolean {
  return (
    context.preferenceDerivedIds.includes(id) &&
    !context.rosterDeclaredIds.includes(id) &&
    !STABLE_BUILTIN_MODEL_IDS.includes(id)
  );
}

/**
 * Produce an inventory whose membership depends on what this machine can reach and
 * nothing else. Providers pass through untouched — they are constructed by v1 from real
 * endpoint configuration and were never preference-parameterized.
 */
export function stabilizeInventory(observed: ProviderInventoryInput, context: CatalogContext): ProviderInventoryInput {
  const kept: ModelFactsInput[] = observed.models.filter((m) => !isPreferenceArtifact(m.id, context));
  const present = new Set(kept.map((m) => m.id));

  // Seed the built-in catalog. A roster declaration or an already-observed entry of the
  // same id WINS — v2 restores the default, it does not override the operator.
  for (const builtin of V2_BUILTIN_CATALOG) {
    if (!present.has(builtin.id)) kept.push(builtin);
  }

  // Only the SEEDED entries need facts filled in; observed models were already given
  // theirs by the provider adapter, which had the roster's override in hand.
  const withCapabilities = kept.map((model) => {
    if (model.capabilities !== undefined) return model;
    const facts = context.capabilitiesFor?.(model);
    return facts === undefined ? model : { ...model, capabilities: facts };
  });

  return { providers: observed.providers, models: withCapabilities };
}

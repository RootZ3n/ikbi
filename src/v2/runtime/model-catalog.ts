/**
 * THE CANONICAL V2 MODEL CATALOG — inventory as FACT, never as preference.
 *
 * INVENTORY IS FACT. PREFERENCE IS POLICY. An operator preference may not create,
 * delete, rename, reroute, or suppress a model. This module is where that rule is made
 * structural rather than aspirational: `buildCanonicalCatalog` takes three declarative
 * fact sources and has NO PARAMETER a preference could be passed through. Membership is
 * therefore not filtered clean of preference — preference never enters.
 *
 *     shipped built-in catalog
 *   + provider auto-discovery facts   (a credential exists ⇒ the provider contributes)
 *   + declared roster facts           (the operator's providers.json)
 *   ────────────────────────────────
 *   = the canonical catalog
 *
 * WHY V2 RE-DECLARES THESE FACTS instead of reading v1's assembled registry.
 *
 * v1's `buildDefaultRegistry` names two of its built-in entries after the operator's
 * configured tier values (`src/core/provider/index.ts:124,129,138`), which produces two
 * distinct corruptions that a downstream filter cannot undo:
 *
 *   1. SUPPRESSION. The preference-named entry lands in the registry FIRST, so
 *      `autoDiscoverProviders` sees `reg.getModel(spec.modelId) !== undefined`
 *      (`index.ts:99`) and skips the genuine route. Reproduced: with an OpenAI key
 *      configured, `IKBI_MODEL_DRIVER=gpt-4o` makes the genuinely auto-discoverable
 *      `gpt-4o` DISAPPEAR — the real openai route is never added, and the fabricated
 *      mimo/openrouter one is (correctly) not trusted. A preference deleted a model.
 *   2. REROUTING. When a preference collides with another built-in's id, the later
 *      upsert wins and the surviving entry carries the WRONG routes. Reproduced:
 *      `IKBI_MODEL_CRITIC=mimo-v2.5` changes `mimo-v2.5` from [mimo, openrouter] to
 *      [mimo, deepseek]. A preference fabricated a route.
 *
 * Neither is recoverable by inspecting the merged result, because the merged result no
 * longer records which entries were real. So v2 states the facts itself. v1 is not
 * modified; it keeps behaving exactly as it does, and v2 simply stops treating its
 * preference-contaminated model map as evidence.
 *
 * DUPLICATION IS DELIBERATE AND GUARDED. `catalog-drift.test.ts` reads v1's source and
 * fails if the shipped built-ins, their routes, the shipped tier defaults, or the
 * auto-discovery mappings change without this file changing with them.
 */

import type { ModelCapabilityFacts, ModelFactsInput, ProviderFactsInput, ProviderInventoryInput } from "../core/config.js";
import { isUsableReadiness, readinessOf } from "../core/config.js";

// ---------------------------------------------------------------------------
// Shipped built-in catalog
// ---------------------------------------------------------------------------

/**
 * Every model v1 ships in its built-in catalog, under its SHIPPED id and with its true
 * routes — i.e. what `buildDefaultRegistry` produces when no preference is configured.
 * Mirrors `src/core/provider/index.ts:127-189`; ordering is the declaration order there.
 *
 * `opus-4.8` deliberately routes to the unregistered `stub` provider, exactly as v1
 * declares it. That is truthful: the model resolves for lookup, and v2's readiness rules
 * will report it as neither routable nor invocable until a real route is wired.
 */
export const V2_BUILTIN_CATALOG: readonly ModelFactsInput[] = Object.freeze([
  {
    id: "mimo-v2.5",
    role: "driver",
    routes: [
      { providerId: "mimo", providerModelId: "mimo-v2.5" },
      { providerId: "openrouter", providerModelId: "mimo-v2.5" },
    ],
  },
  {
    id: "mimo-v2.5-pro",
    role: "critic",
    routes: [
      { providerId: "mimo", providerModelId: "mimo-v2.5-pro" },
      { providerId: "deepseek", providerModelId: "mimo-v2.5-pro" },
    ],
  },
  { id: "deepseek-chat", role: "driver", routes: [{ providerId: "deepseek", providerModelId: "deepseek-chat" }] },
  { id: "deepseek-reasoner", role: "critic", routes: [{ providerId: "deepseek", providerModelId: "deepseek-reasoner" }] },
  { id: "deepseek-v4-flash", role: "driver", routes: [{ providerId: "deepseek", providerModelId: "deepseek-v4-flash" }] },
  { id: "opus-4.8", role: "critic", routes: [{ providerId: "stub", providerModelId: "opus-4.8" }] },
] as const satisfies readonly ModelFactsInput[]);

/**
 * The shipped values of the two tier slots v1 parameterizes. They are the ids the
 * built-in driver/critic entries carry when nobody has expressed a preference, and they
 * are recorded here so the drift guard can prove this catalog still matches v1's
 * defaults (`src/core/config.ts:474,477`).
 */
export const V2_SHIPPED_TIER_DEFAULTS = Object.freeze({ driver: "mimo-v2.5", critic: "mimo-v2.5-pro" });

// ---------------------------------------------------------------------------
// Auto-discovery facts
// ---------------------------------------------------------------------------

/**
 * One provider's auto-discovery contribution: the model it makes available purely by
 * being credentialed. Mirrors v1's `AUTO_DISCOVER` table
 * (`src/core/provider/index.ts:52-82`) and its `providerChecks` list.
 *
 * Cost is deliberately absent: it belongs to accounting, and v2's inventory carries no
 * pricing (keeping the digest from moving when a rate changes).
 */
export interface AutoDiscoveryFact {
  readonly providerId: string;
  readonly modelId: string;
  readonly role: string;
  readonly providerModelId: string;
}

/**
 * What each supported provider contributes when it is credentialed. This is a STATEMENT
 * OF FACT about the provider, not a preference: "if this machine can reach openai, then
 * gpt-4o is a model this machine can use".
 */
export const V2_AUTO_DISCOVERY_FACTS: readonly AutoDiscoveryFact[] = Object.freeze([
  { providerId: "minimax", modelId: "minimax-m3", role: "driver", providerModelId: "MiniMax-M3" },
  { providerId: "openai", modelId: "gpt-4o", role: "frontier", providerModelId: "gpt-4o" },
  { providerId: "anthropic", modelId: "claude-sonnet-4-5", role: "frontier", providerModelId: "claude-sonnet-4-5" },
  { providerId: "google", modelId: "gemini-2.5-flash", role: "driver", providerModelId: "gemini-2.5-flash" },
  { providerId: "groq", modelId: "llama-3.3-70b", role: "driver", providerModelId: "llama-3.3-70b-versatile" },
] as const satisfies readonly AutoDiscoveryFact[]);

/**
 * Which auto-discovery contributions this machine actually has.
 *
 * The condition is READINESS, evaluated exactly as V2-002/V2-003 define it: the provider
 * must be registered and `configured` or `keyless`. Nothing is contacted, no credential
 * value is read, and `unknown` readiness contributes nothing — an endpoint that cannot
 * describe itself is not evidence that a model is available through it.
 */
export function discoveredModels(providers: readonly ProviderFactsInput[]): ModelFactsInput[] {
  const byId = new Map(providers.map((p) => [p.id, p]));
  const out: ModelFactsInput[] = [];
  for (const fact of V2_AUTO_DISCOVERY_FACTS) {
    const provider = byId.get(fact.providerId);
    if (provider === undefined || !isUsableReadiness(readinessOf(provider))) continue;
    out.push({
      id: fact.modelId,
      role: fact.role,
      routes: [{ providerId: fact.providerId, providerModelId: fact.providerModelId }],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Canonical construction
// ---------------------------------------------------------------------------

/**
 * The ONLY inputs catalog membership may depend on.
 *
 * Note what this type cannot express: there is no field for an active profile, a tier
 * preference, an `IKBI_MODEL_*` value, or a resolver decision. Preference-independence
 * is enforced by the signature, not by a filtering step that could be forgotten.
 */
export interface CanonicalCatalogSources {
  /** Registered providers, as observed. Their readiness drives auto-discovery. */
  readonly providers: readonly ProviderFactsInput[];
  /** Models the operator's roster file DECLARES. Highest authority over membership. */
  readonly rosterModels: readonly ModelFactsInput[];
  /** Attach static capability facts to an entry that has none. Never invents them. */
  readonly capabilitiesFor?: (modelId: string) => ModelCapabilityFacts | undefined;
}

/**
 * Compose the canonical catalog.
 *
 * PRECEDENCE mirrors v1's own layering — built-ins are the base, auto-discovery fills
 * gaps only (v1 skips a model it already has), and the roster overwrites everything
 * (v1 applies the roster file after the built-ins). The difference is that none of the
 * three inputs has been through a preference.
 *
 * Ordering is deterministic: entries are returned sorted by id, so the digest is stable
 * regardless of the order the sources happened to be assembled in.
 */
export function buildCanonicalCatalog(sources: CanonicalCatalogSources): ProviderInventoryInput {
  const byId = new Map<string, ModelFactsInput>();
  for (const model of V2_BUILTIN_CATALOG) byId.set(model.id, model);
  for (const model of discoveredModels(sources.providers)) {
    if (!byId.has(model.id)) byId.set(model.id, model);
  }
  for (const model of sources.rosterModels) byId.set(model.id, model);

  const models = [...byId.values()]
    .map((model) => {
      if (model.capabilities !== undefined) return model;
      const facts = sources.capabilitiesFor?.(model.id);
      return facts === undefined ? model : { ...model, capabilities: facts };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  return { providers: sources.providers, models };
}

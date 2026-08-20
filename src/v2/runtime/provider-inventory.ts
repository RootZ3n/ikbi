/**
 * ADAPTER — v1 provider registry → v2 provider inventory facts.
 *
 * One of only three places in v2 that knows v1 exists. Its whole job is to READ the
 * proven v1 registry and restate what it found as plain, credential-free data. It
 * builds no transports, registers no providers, and performs no I/O beyond what the
 * registry already did at construction: nothing here contacts a provider, so nothing
 * here can claim a provider is reachable.
 *
 * The registry is INJECTED rather than imported as a singleton, so this module can be
 * tested against a hand-built registry and so the process-wide singleton is touched in
 * exactly one place (`runtime/index.ts`).
 */

import { getCapabilities, isModelClassified, type ModelCapabilities } from "../../core/provider/capabilities.js";
import type { ModelProvider } from "../../core/provider/contract.js";
import type { ModelSpec } from "../../core/provider/registry.js";
import type { ModelCapabilityFacts, ProviderFactsInput, ProviderInventoryInput, ModelFactsInput } from "../core/config.js";

/** The narrow slice of the v1 registry this adapter needs. `ModelRegistry` satisfies it. */
export interface InventoryRegistry {
  listProviders(): readonly ModelProvider[];
  listModels(): readonly ModelSpec[];
}

/** Restate one v1 provider as credential-free facts. */
export function providerFacts(provider: ModelProvider): ProviderFactsInput {
  const info = provider.preflightInfo?.();
  if (info === undefined) {
    // The provider cannot describe itself. Say so rather than inventing a readiness —
    // `ready()` alone tells us nothing about whether a credential is even required.
    return {
      id: provider.id,
      introspectable: false,
      kind: "unknown",
      baseUrl: "",
      credentialRequired: true,
      credentialPresent: false,
    };
  }
  return {
    id: provider.id,
    introspectable: true,
    kind: info.kind,
    baseUrl: info.baseUrl,
    credentialRequired: info.credentialRequired,
    credentialPresent: info.credentialPresent,
    ...(info.credentialSource !== undefined ? { credentialSource: info.credentialSource } : {}),
    ...(info.configurationSource !== undefined ? { configurationSource: info.configurationSource } : {}),
  };
}

/**
 * Capability facts for a model id — or NOTHING.
 *
 * v1's `getCapabilities` always returns a profile, falling back to a conservative
 * 8k/no-tools guess for an id it does not recognize. That guess is a safety default for
 * DRIVING a model, not a fact about it, so v2 publishes facts only when the roster
 * declares them or v1's classification table genuinely matched. The "declared" test
 * mirrors v1's own rule in `findUnclassifiedModels`: an override counts as intentional
 * when it sets either of the two fields the fallback degrades.
 */
export function capabilityFacts(modelId: string, override?: Partial<ModelCapabilities>): ModelCapabilityFacts | undefined {
  const declared =
    override !== undefined &&
    ((typeof override.context_window === "number" && override.context_window > 0) || typeof override.supports_tools === "boolean");
  const classified = isModelClassified(modelId);
  if (!declared && !classified) return undefined;
  const caps = getCapabilities(modelId, override);
  return {
    contextWindow: caps.context_window,
    supportsTools: caps.supports_tools,
    ...(caps.supports_thinking !== undefined ? { supportsThinking: caps.supports_thinking } : {}),
    reasoningLevel: caps.reasoning_level,
    speedClass: caps.speed_class,
    provenance: declared ? "declared" : "known",
    /*
      A declared density becomes a first-class estimator fact; anything else is left
      absent so the generic fallback applies. The builder never learns which happened —
      it is handed an estimator either way.
    */
    ...(typeof caps.chars_per_token === "number"
      ? { tokenEstimator: { kind: "chars_ratio" as const, charsPerToken: caps.chars_per_token, provenance: "declared" as const } }
      : {}),
  };
}

/** Restate one v1 roster model, preserving its ordered fallback chain. */
export function modelFacts(spec: ModelSpec): ModelFactsInput {
  const capabilities = capabilityFacts(spec.id, spec.capabilities);
  return {
    id: spec.id,
    ...(spec.role !== undefined ? { role: spec.role } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    routes: spec.providers.map((route) => ({
      providerId: route.provider,
      providerModelId: route.providerModelId,
    })),
  };
}

/**
 * Read the whole inventory.
 *
 * NOTE ON PROVENANCE: v1's registry does not record WHERE each model route came from
 * (built-in default, roster file, or key-triggered auto-discovery) — routes are merged
 * into one map by `buildDefaultRegistry`. Per-provider `configurationSource` is the
 * only origin v1 retains, and it is carried through. Per-model origin would require
 * re-deriving the merge, which this slice does not do.
 */
export function readProviderInventory(registry: InventoryRegistry): ProviderInventoryInput {
  return {
    providers: registry.listProviders().map(providerFacts),
    models: registry.listModels().map(modelFacts),
  };
}

/**
 * ikbi provider layer — public surface (frozen contract #1).
 *
 * Import the contract types and `invokeModel` from here. The default registry
 * and invoker are wired from `config` (mimo direct primary + OpenRouter backup),
 * with the roster file (if present) applied on top.
 */

import { config } from "../config.js";
import { childLogger } from "../log.js";
import { cachedInvoke } from "../../modules/cache/index.js";
import { ProviderInvoker } from "./invoke.js";
import type { ModelRequest, ModelResponse } from "./contract.js";
import {
  createDeepseekProvider,
  createMimoProvider,
  createOpenRouterProvider,
  DEEPSEEK_PROVIDER_ID,
  MIMO_PROVIDER_ID,
  OPENROUTER_PROVIDER_ID,
} from "./providers/index.js";
import { ModelRegistry, type ModelSpec } from "./registry.js";

const log = childLogger("provider");

/** Build the default registry: built-in roster + configured providers, then the roster file. */
function buildDefaultRegistry(): ModelRegistry {
  const pc = config.provider;
  const { driver, critic } = pc.defaultModels;

  // Placeholder cost rates (USD per 1M tokens). Override per-model via the roster file.
  const defaultModels: ModelSpec[] = [
    {
      id: driver,
      role: "driver",
      cost: { promptPerMTok: 0.3, completionPerMTok: 0.9 },
      providers: [
        { provider: MIMO_PROVIDER_ID, providerModelId: driver },
        { provider: OPENROUTER_PROVIDER_ID, providerModelId: driver },
      ],
    },
    {
      id: critic,
      role: "critic",
      cost: { promptPerMTok: 0.6, completionPerMTok: 1.8 },
      providers: [
        { provider: MIMO_PROVIDER_ID, providerModelId: critic },
        { provider: OPENROUTER_PROVIDER_ID, providerModelId: critic },
      ],
    },
    // DeepSeek direct models — usable out of the box once IKBI_DEEPSEEK_API_KEY is set.
    // Placeholder costs; override (and add OpenRouter fallback routes) via the roster file.
    {
      id: "deepseek-chat",
      role: "driver",
      cost: { promptPerMTok: 0.27, completionPerMTok: 1.1 },
      providers: [{ provider: DEEPSEEK_PROVIDER_ID, providerModelId: "deepseek-chat" }],
    },
    {
      id: "deepseek-reasoner",
      role: "critic",
      cost: { promptPerMTok: 0.55, completionPerMTok: 2.19 },
      providers: [{ provider: DEEPSEEK_PROVIDER_ID, providerModelId: "deepseek-reasoner" }],
    },
  ];

  const reg = new ModelRegistry({
    models: defaultModels,
    providers: [createMimoProvider(pc.mimo), createOpenRouterProvider(pc.openrouter), createDeepseekProvider(pc.deepseek)],
  });

  try {
    const applied = reg.loadRosterFile(pc.rosterFile);
    if (applied.models > 0 || applied.providers > 0) {
      log.info({ ...applied, file: pc.rosterFile }, "applied provider roster file");
    }
  } catch (err) {
    log.error({ err, file: pc.rosterFile }, "failed to load provider roster file");
    throw err;
  }
  return reg;
}

/** The process-wide registry (read/update path for models & providers). */
export const registry: ModelRegistry = buildDefaultRegistry();

/** The process-wide invoker. */
export const invoker = new ProviderInvoker({
  registry,
  circuit: config.provider.circuit,
  defaultTimeoutMs: config.provider.timeoutMs,
  logger: log,
});

/**
 * The frozen entry point. Every model call in the engine goes through this.
 *
 * The caching floor wraps here — ABOVE the invoker loop and the egress guard. A
 * cache hit returns a stored response with no network call; a miss falls through
 * to the unchanged invoker path and stores ONLY on a fully successful response
 * (errors/timeouts/guard denials are never cached). Opt-out-safe: when caching is
 * disabled this is an exact passthrough to `invoker.invokeModel`.
 */
export function invokeModel(request: ModelRequest): Promise<ModelResponse> {
  return cachedInvoke(request, () => invoker.invokeModel(request));
}

// --- re-export the frozen contract + building blocks ---
export * from "./contract.js";
export { ProviderInvoker, computeCost } from "./invoke.js";
export type { InvokerDeps } from "./invoke.js";
export { ModelRegistry, resolveRate } from "./registry.js";
export type { ModelSpec, ProviderRoute, RegistryInit } from "./registry.js";
export { CircuitBreaker } from "./circuit-breaker.js";
export type { Clock, CircuitState, CircuitSnapshot } from "./circuit-breaker.js";
export {
  createMimoProvider,
  createOpenRouterProvider,
  OpenAICompatibleProvider,
  MIMO_PROVIDER_ID,
  OPENROUTER_PROVIDER_ID,
} from "./providers/index.js";
export type { FetchLike, OpenAICompatibleOptions } from "./providers/openai-compatible.js";

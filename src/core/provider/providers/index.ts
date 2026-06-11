/**
 * ikbi provider layer — concrete provider factories.
 *
 * mimo direct (primary), OpenRouter (backup), and DeepSeek direct. All are
 * OpenAI-compatible, so they share the hardened HTTP client and differ only in
 * endpoint/auth/headers.
 */

import type { OpenRouterEndpointConfig, ProviderEndpointConfig } from "../../config.js";
import type { ModelProvider } from "../contract.js";
import { type FetchLike, OpenAICompatibleProvider } from "./openai-compatible.js";

export const MIMO_PROVIDER_ID = "mimo";
export const OPENROUTER_PROVIDER_ID = "openrouter";
export const DEEPSEEK_PROVIDER_ID = "deepseek";
export const MINIMAX_PROVIDER_ID = "minimax";

/** Build the mimo direct-API provider (primary driver). */
export function createMimoProvider(cfg: ProviderEndpointConfig, fetchImpl?: FetchLike): ModelProvider {
  return new OpenAICompatibleProvider({
    id: MIMO_PROVIDER_ID,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

/** Build the DeepSeek direct-API provider (OpenAI-compatible, no special headers). */
export function createDeepseekProvider(cfg: ProviderEndpointConfig, fetchImpl?: FetchLike): ModelProvider {
  return new OpenAICompatibleProvider({
    id: DEEPSEEK_PROVIDER_ID,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

/** Build the MiniMax direct-API provider (OpenAI-compatible). */
export function createMinimaxProvider(cfg: ProviderEndpointConfig, fetchImpl?: FetchLike): ModelProvider {
  return new OpenAICompatibleProvider({
    id: MINIMAX_PROVIDER_ID,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

/** Build the OpenRouter provider (hardened backup) with attribution headers. */
export function createOpenRouterProvider(
  cfg: OpenRouterEndpointConfig,
  fetchImpl?: FetchLike,
): ModelProvider {
  const extraHeaders: Record<string, string> = {};
  if (cfg.referer !== undefined) extraHeaders["HTTP-Referer"] = cfg.referer;
  if (cfg.title !== undefined) extraHeaders["X-Title"] = cfg.title;
  return new OpenAICompatibleProvider({
    id: OPENROUTER_PROVIDER_ID,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    extraHeaders,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

export { OpenAICompatibleProvider, type FetchLike } from "./openai-compatible.js";

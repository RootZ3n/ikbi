/**
 * ikbi provider layer — the single invocation entry point.
 *
 * `invokeModel(request)` resolves the model from the registry and walks its
 * ordered provider routes as a DETERMINISTIC fallback chain (e.g. mimo direct →
 * OpenRouter → typed error). Each route is guarded by a circuit breaker keyed
 * per (provider, model) and a per-request timeout. Cost and tokens are accounted
 * against the route that actually served. Fallback is never silent: every
 * attempt is logged and recorded on the response's `attempts` array.
 *
 * Health accounting: only retriable failures count toward a breaker; a
 * non-retriable failure (auth/config/bad-response) fails the call but does not
 * trip the breaker — the provider is healthy, the request is bad.
 */

import type { Logger } from "pino";

import type { CircuitConfig } from "../config.js";
import { CircuitBreaker, type Clock } from "./circuit-breaker.js";
import {
  AllProvidersFailedError,
  type Cost,
  CONTRACT_VERSION,
  type CostRate,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  ModelNotFoundError,
  type ProviderAttempt,
  ProviderError,
  type ProviderResult,
  type ToolCall,
  type TokenUsage,
} from "./contract.js";
import { type ModelRegistry, type ProviderRoute, resolveRate } from "./registry.js";

/**
 * Compute cost (USD) for a usage against a per-1M-token rate. Cached prompt
 * tokens are a subset of prompt tokens and are charged at the cached rate
 * (falling back to the normal prompt rate when no cached rate is configured).
 */
export function computeCost(rate: CostRate, usage: TokenUsage): Cost {
  const cachedTokens = Math.min(usage.cachedTokens ?? 0, usage.promptTokens);
  const nonCachedPrompt = usage.promptTokens - cachedTokens;
  const cachedRate = rate.cachedPromptPerMTok ?? rate.promptPerMTok;

  const promptUsd = (nonCachedPrompt / 1_000_000) * rate.promptPerMTok;
  const cachedUsd = (cachedTokens / 1_000_000) * cachedRate;
  const completionUsd = (usage.completionTokens / 1_000_000) * rate.completionPerMTok;
  return { usd: promptUsd + cachedUsd + completionUsd, promptUsd, cachedUsd, completionUsd, rate };
}

export interface InvokerDeps {
  readonly registry: ModelRegistry;
  readonly circuit: CircuitConfig;
  readonly defaultTimeoutMs: number;
  readonly logger: Logger;
  /** Clock for breaker cooldown + latency measurement. Defaults to Date.now. */
  readonly now?: Clock;
}

/** Breaker key: a bad model must not open the whole provider. */
function breakerKey(provider: string, providerModelId: string): string {
  return `${provider}::${providerModelId}`;
}

export class ProviderInvoker {
  private readonly registry: ModelRegistry;
  private readonly circuit: CircuitConfig;
  private readonly defaultTimeoutMs: number;
  private readonly log: Logger;
  private readonly now: Clock;
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(deps: InvokerDeps) {
    this.registry = deps.registry;
    this.circuit = deps.circuit;
    this.defaultTimeoutMs = deps.defaultTimeoutMs;
    this.log = deps.logger;
    this.now = deps.now ?? Date.now;
  }

  /** The frozen entry point: invoke a model with deterministic, hardened fallback. */
  async invokeModel(request: ModelRequest): Promise<ModelResponse> {
    const spec = this.registry.getModel(request.model);
    if (spec === undefined) throw new ModelNotFoundError(request.model);

    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const attempts: ProviderAttempt[] = [];
    let previousProvider: string | undefined;

    for (const [index, route] of spec.providers.entries()) {
      const isFallback = index > 0;
      const provider = this.registry.getProvider(route.provider);
      const breaker = this.breakerFor(route.provider, route.providerModelId);
      const rate = resolveRate(spec, route);

      if (provider === undefined) {
        attempts.push({
          provider: route.provider,
          providerModelId: route.providerModelId,
          outcome: "error",
          latencyMs: 0,
          error: "provider not registered",
        });
        this.log.warn(
          { event: "provider_missing", model: request.model, provider: route.provider },
          "provider route has no registered provider; skipping",
        );
        continue;
      }

      if (!breaker.canAttempt()) {
        attempts.push({
          provider: route.provider,
          providerModelId: route.providerModelId,
          outcome: "skipped_open_circuit",
          latencyMs: 0,
        });
        this.log.warn(
          {
            event: "circuit_open_skip",
            model: request.model,
            provider: route.provider,
            providerModelId: route.providerModelId,
            circuit: breaker.snapshot(),
          },
          "skipping provider: circuit open",
        );
        continue;
      }

      if (isFallback) {
        this.log.warn(
          {
            event: "provider_fallback",
            model: request.model,
            fromProvider: previousProvider,
            toProvider: route.provider,
            attempt: index,
          },
          "falling back to next provider",
        );
      }
      previousProvider = route.provider;

      const t0 = this.now();
      try {
        const result = await this.invokeWithTimeout(provider, route.providerModelId, request, timeoutMs);
        const latencyMs = this.now() - t0;
        breaker.recordSuccess();
        const cost = computeCost(rate, result.usage);
        attempts.push({
          provider: route.provider,
          providerModelId: route.providerModelId,
          outcome: "success",
          latencyMs,
          usage: result.usage,
          costUsd: cost.usd,
        });
        const response = this.assemble(request, route, result, cost, latencyMs, isFallback, attempts);
        this.log.info(
          {
            event: "model_invocation",
            model: request.model,
            provider: response.provider,
            providerModelId: response.providerModelId,
            agentId: request.identity.agentId,
            functionalRole: request.identity.functionalRole,
            trustTier: request.identity.trustTier,
            tokens: response.usage,
            costUsd: response.cost.usd,
            latencyMs,
            fellBack: isFallback,
            attempts: attempts.length,
          },
          "model invocation succeeded",
        );
        return response;
      } catch (err) {
        const latencyMs = this.now() - t0;
        const isProviderErr = err instanceof ProviderError;
        const isTimeout = isProviderErr && err.kind === "timeout";
        // Non-retriable failures (auth/config/bad-response) do NOT reflect provider
        // health: fail the call, but don't trip the breaker.
        const permanent = isProviderErr && err.retriable === false;
        if (permanent) breaker.recordIgnoredFailure();
        else breaker.recordFailure();

        // Surface any tokens the provider charged even on failure.
        const failUsage = isProviderErr ? err.usage : undefined;
        const failCostUsd = failUsage ? computeCost(rate, failUsage).usd : undefined;

        attempts.push({
          provider: route.provider,
          providerModelId: route.providerModelId,
          outcome: isTimeout ? "timeout" : permanent ? "permanent_error" : "error",
          latencyMs,
          error: err instanceof Error ? err.message : String(err),
          ...(failUsage ? { usage: failUsage } : {}),
          ...(failCostUsd !== undefined ? { costUsd: failCostUsd } : {}),
        });
        this.log.warn(
          {
            event: permanent ? "provider_attempt_permanent_error" : "provider_attempt_failed",
            model: request.model,
            provider: route.provider,
            providerModelId: route.providerModelId,
            kind: isProviderErr ? err.kind : "unknown",
            retriable: isProviderErr ? err.retriable : undefined,
            permanent,
            latencyMs,
            circuit: breaker.snapshot(),
          },
          permanent ? "provider attempt failed (permanent, breaker not tripped)" : "provider attempt failed",
        );
        continue;
      }
    }

    this.log.error(
      { event: "model_invocation_exhausted", model: request.model, attempts },
      "all providers failed for model",
    );
    throw new AllProvidersFailedError(request.model, attempts);
  }

  /** Circuit-breaker state for a (provider, model) route — for observability/tests. */
  breakerSnapshot(provider: string, providerModelId: string): ReturnType<CircuitBreaker["snapshot"]> {
    return this.breakerFor(provider, providerModelId).snapshot();
  }

  private breakerFor(provider: string, providerModelId: string): CircuitBreaker {
    const key = breakerKey(provider, providerModelId);
    let b = this.breakers.get(key);
    if (b === undefined) {
      b = new CircuitBreaker({
        failureThreshold: this.circuit.failureThreshold,
        cooldownMs: this.circuit.cooldownMs,
        halfOpenMaxTrials: this.circuit.halfOpenMaxTrials,
        now: this.now,
      });
      this.breakers.set(key, b);
    }
    return b;
  }

  private async invokeWithTimeout(
    provider: ModelProvider,
    providerModelId: string,
    request: ModelRequest,
    timeoutMs: number,
  ): Promise<ProviderResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        // Reject with the timeout error FIRST so it wins the race, THEN abort the
        // attempt — otherwise a provider that rejects on abort could settle first
        // and the failure would be mis-classified as a generic error. The abort
        // propagates to the provider's fetch so the attempt is actually cancelled
        // and not left in flight (or billed) after fallback fires.
        reject(
          new ProviderError(`Provider ${provider.id} timed out after ${timeoutMs}ms`, {
            kind: "timeout",
            provider: provider.id,
            retriable: true,
          }),
        );
        controller.abort();
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        provider.invoke({ providerModelId, request, timeoutMs, signal: controller.signal }),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // Ensure the attempt is cancelled on any settle path (success or error).
      controller.abort();
    }
  }

  private assemble(
    request: ModelRequest,
    route: ProviderRoute,
    result: ProviderResult,
    cost: Cost,
    latencyMs: number,
    fellBack: boolean,
    attempts: readonly ProviderAttempt[],
  ): ModelResponse {
    const toolCalls: readonly ToolCall[] | undefined = result.toolCalls;
    return {
      // Always the SERVER's contract version, never the echoed request version —
      // so consumers can detect a version mismatch.
      contractVersion: CONTRACT_VERSION,
      model: request.model,
      provider: route.provider,
      providerModelId: route.providerModelId,
      content: result.content,
      ...(result.reasoning !== undefined ? { reasoning: result.reasoning } : {}),
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
      finishReason: result.finishReason,
      usage: result.usage,
      cost,
      latencyMs,
      fellBack,
      attempts: [...attempts],
    };
  }
}

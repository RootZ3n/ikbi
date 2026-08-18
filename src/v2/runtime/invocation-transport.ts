/**
 * ADAPTER — v1 provider TRANSPORTS, without v1 provider ROUTING.
 *
 * v1's `ProviderInvoker.invokeModel` (`core/provider/invoke.ts:139`) is a routing
 * authority: it looks the logical model up in the registry, walks `spec.providers` as a
 * fallback chain, consults circuit breakers, and retries a route on transient failures.
 * All of that is selection, and selection already happened — so v2 does not go near it.
 *
 * This adapter calls the TRANSPORT directly: `provider.invoke(...)`, which the audit
 * confirms performs exactly one outbound fetch and contains no retry of its own
 * (`providers/openai-compatible.ts:438`, `providers/anthropic.ts` `post`). One
 * authorized route in, one HTTP attempt out, and the attempt count is reported so a
 * transport that ever grew an internal retry would be caught rather than hidden.
 *
 * The adapter receives a provider ID and a wire model ID. It is given no model spec, no
 * route list and no ability to look for an alternative: `getProvider(id)` either returns
 * the endpoint we were authorized to use, or the invocation fails.
 *
 * Credentials live inside the provider objects and are used by them. Nothing credential-
 * bearing crosses back out through this boundary.
 */

import type { ModelProvider, ModelRequest, ProviderError } from "../../core/provider/contract.js";
import { V2_INVOCATION_FAILURE_CODES, type InvocationTransport, type ObservedUsage, type TransportOutcome } from "../core/invocation.js";

/** The narrow slice of the v1 registry this adapter needs: look one provider up by id. */
export interface TransportProviderLookup {
  getProvider(id: string): ModelProvider | undefined;
}

/** Is this a v1 `ProviderError`? Structural, so a fake transport can produce one too. */
function isProviderError(err: unknown): err is ProviderError {
  return typeof err === "object" && err !== null && "kind" in err && "provider" in err;
}

/**
 * Map the donor layer's own classification onto v2 codes.
 *
 * The donor already knows more than "it failed" — auth, rate limit, timeout, bad
 * response and config are distinct there, and collapsing them into one bucket would
 * throw away information the provider layer went to the trouble of establishing.
 */
export function mapProviderErrorCode(kind: ProviderError["kind"], status: number | undefined): string {
  switch (kind) {
    case "timeout":
      return V2_INVOCATION_FAILURE_CODES.transportTimeout;
    case "auth":
      return V2_INVOCATION_FAILURE_CODES.credentialMissing;
    case "rate_limit":
      return V2_INVOCATION_FAILURE_CODES.rateLimited;
    case "bad_response":
      return V2_INVOCATION_FAILURE_CODES.malformedResponse;
    case "config":
      return V2_INVOCATION_FAILURE_CODES.unsupportedProtocol;
    case "http":
      // A 4xx is the provider refusing the request we made; a 5xx is the provider
      // failing to serve one it accepted. Different facts, different codes.
      return status !== undefined && status >= 400 && status < 500
        ? V2_INVOCATION_FAILURE_CODES.providerRejected
        : V2_INVOCATION_FAILURE_CODES.transportFailure;
    case "network":
      return V2_INVOCATION_FAILURE_CODES.transportFailure;
    case "unknown":
    default:
      return V2_INVOCATION_FAILURE_CODES.internal;
  }
}

/** Carry across only usage fields the provider actually reported. */
function observedUsage(usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cachedPromptTokens?: number; reasoningTokens?: number } | undefined): ObservedUsage | undefined {
  if (usage === undefined) return undefined;
  const out: ObservedUsage = {
    ...(typeof usage.promptTokens === "number" ? { promptTokens: usage.promptTokens } : {}),
    ...(typeof usage.completionTokens === "number" ? { completionTokens: usage.completionTokens } : {}),
    ...(typeof usage.totalTokens === "number" ? { totalTokens: usage.totalTokens } : {}),
    ...(typeof usage.cachedPromptTokens === "number" ? { cachedPromptTokens: usage.cachedPromptTokens } : {}),
    ...(typeof usage.reasoningTokens === "number" ? { reasoningTokens: usage.reasoningTokens } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Build the transport over a provider lookup.
 *
 * `now`/`setTimeout` are not injected: the timeout is enforced with a real
 * `AbortController`, because a fake clock would prove nothing about a real socket.
 */
export function createInvocationTransport(lookup: TransportProviderLookup): InvocationTransport {
  return {
    async send(input): Promise<TransportOutcome> {
      const provider = lookup.getProvider(input.providerId);
      if (provider === undefined) {
        // NOT an attempt: nothing reached the wire, so nothing may be counted as invoked.
        return {
          ok: false,
          failure: {
            code: V2_INVOCATION_FAILURE_CODES.providerNotAvailable,
            message: `provider "${input.providerId}" is not registered on this machine`,
            providerId: input.providerId,
            attempts: 0,
          },
        };
      }
      if (provider.ready?.() === false) {
        return {
          ok: false,
          failure: {
            code: V2_INVOCATION_FAILURE_CODES.credentialMissing,
            message: `provider "${input.providerId}" is registered but not usable (no credential)`,
            providerId: input.providerId,
            attempts: 0,
          },
        };
      }

      const request: ModelRequest = {
        // The WIRE id. The donor transports send `providerModelId` from the invocation,
        // not this field, but keeping them equal means nothing can diverge silently.
        model: input.providerModelId,
        // The donor `ModelMessage` already round-trips a full tool loop: an assistant turn
        // carries the calls it made, and a tool message names the call it answers. v2
        // carries both across verbatim rather than inventing a second representation.
        messages: input.messages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.toolCalls !== undefined ? { toolCalls: m.toolCalls } : {}),
          ...(m.toolCallId !== undefined ? { toolCallId: m.toolCallId } : {}),
          // Structural-isolation metadata (v1 ModelMessage.untrusted). It does not change
          // the wire body — the fence in `content` is what contains the data.
          ...(m.untrusted === true ? { untrusted: true } : {}),
        })),
        ...(input.tools !== undefined ? { tools: input.tools } : {}),
        maxTokens: input.parameters.maxOutputTokens,
        // v1's request contract requires a calling identity. The v2 spine has no agent
        // identity system yet, so this states plainly what is making the call rather
        // than borrowing a trust tier v2 has not earned.
        identity: { agentId: "ikbi-v2", functionalRole: "builder" },
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), input.parameters.timeoutMs);
      try {
        const result = await provider.invoke({
          // EXACTLY the authorized wire id. There is no other value in scope here.
          providerModelId: input.providerModelId,
          request,
          timeoutMs: input.parameters.timeoutMs,
          signal: controller.signal,
        });
        return {
          ok: true,
          response: {
            content: result.content,
            finishReason: result.finishReason,
            // PROVIDER-NATIVE ONLY. What the donor parsed out of a structured
            // `tool_calls` field, and nothing scraped out of prose.
            ...(result.toolCalls !== undefined && result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}),
            ...(result.servedModelId !== undefined ? { servedModelId: result.servedModelId } : {}),
            ...(observedUsage(result.usage) !== undefined ? { usage: observedUsage(result.usage)! } : {}),
            // One call to `provider.invoke` is one outbound attempt: the donor
            // transports issue a single fetch and retry nothing internally (audited).
            attempts: 1,
          },
        };
      } catch (err) {
        if (isProviderError(err)) {
          return {
            ok: false,
            failure: {
              code: mapProviderErrorCode(err.kind, err.status),
              // The donor's message, which never contains a credential.
              message: err.message,
              providerId: err.provider,
              ...(err.status !== undefined ? { status: err.status } : {}),
              attempts: 1,
            },
          };
        }
        return {
          ok: false,
          failure: {
            code: V2_INVOCATION_FAILURE_CODES.internal,
            message: err instanceof Error ? err.message : String(err),
            providerId: input.providerId,
            attempts: 1,
          },
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

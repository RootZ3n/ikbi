import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { OperationContext } from "../../core/identity/resolver.js";
import type { ModelMessage, ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import type { NeutralizedContent, UntrustedContext } from "../../core/injection/index.js";
import { createAgentRouter } from "./router.js";
import { ROUTER_MODEL } from "./config.js";
import type { CapabilityScore, CapabilitySelector } from "../capability-client/contract.js";

const silent = () => pino({ level: "silent" });

function makeCtx(agentId: string): OperationContext {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId, kind: "agent", defaultTrustTier: "trusted", tokenHashes: [hashToken(`${agentId}-secret`)] }] }),
    logger: silent(),
    now: () => 1000,
  });
  return beginOperation(resolver.resolve({ token: `${agentId}-secret` }), { requestId: "req-1" });
}

function modelResponse(content: string): ModelResponse {
  return {
    contractVersion: "1.1.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
    content, finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}

/** A model spy capturing each request (so a test can assert which model id was routed to). */
function modelSpy(content: string) {
  const calls: ModelRequest[] = [];
  const invokeModel = async (req: ModelRequest): Promise<ModelResponse> => {
    calls.push(req);
    return modelResponse(content);
  };
  return { invokeModel, calls };
}

const neutralize = (content: string, context: UntrustedContext): NeutralizedContent =>
  ({ wrapped: `[N] ${content}`, source: context.source } as unknown as NeutralizedContent);
const toUntrusted = (n: NeutralizedContent): ModelMessage => ({ role: "user", content: n.wrapped, untrusted: true });

/** A capability selector returning a fixed score (or null) for any category. */
function selector(score: CapabilityScore | null): CapabilitySelector {
  return { getBestModelForCategory: async () => score };
}

function aScore(over: Partial<CapabilityScore> = {}): CapabilityScore {
  return { modelId: "deepseek-v4-pro", category: "instruction_following", score: 0.85, confidence: 0.9, sampleCount: 10, evidenceSources: ["arena"], ...over };
}

const baseDeps = (sm: ReturnType<typeof modelSpy>) => ({
  invokeModel: sm.invokeModel,
  neutralizeUntrusted: neutralize,
  toUntrustedMessage: toUntrusted,
  publish: () => {},
});

// ── capability-driven selection wins when a confident, well-sampled score exists ──

test("classify routes to the capability ledger's best model when the score clears the trust gates", async () => {
  const sm = modelSpy('{"intent":"build"}');
  const router = createAgentRouter({ ...baseDeps(sm), capabilityClient: selector(aScore({ modelId: "deepseek-v4-pro" })) });

  await router.classify({ parentCtx: makeCtx("agent-a"), message: "build it" });
  assert.equal(sm.calls[0]?.model, "deepseek-v4-pro", "capability-driven model selection overrode the static ROUTER_MODEL");
});

test("ask routes to the capability ledger's best model for its category", async () => {
  const sm = modelSpy("an answer");
  const router = createAgentRouter({ ...baseDeps(sm), capabilityClient: selector(aScore({ modelId: "mimo-v2.5-pro", category: "chat_personality" })) });

  await router.ask({ parentCtx: makeCtx("agent-a"), question: "what happened?" });
  assert.equal(sm.calls[0]?.model, "mimo-v2.5-pro");
});

// ── fall back to static config on low confidence / few samples / no data ──────

test("falls back to static ROUTER_MODEL when the best score's confidence is too low", async () => {
  const sm = modelSpy('{"intent":"build"}');
  const router = createAgentRouter({ ...baseDeps(sm), capabilityClient: selector(aScore({ modelId: "deepseek-v4-pro", confidence: 0.4 })) });

  await router.classify({ parentCtx: makeCtx("agent-a"), message: "x" });
  assert.equal(sm.calls[0]?.model, ROUTER_MODEL, "low confidence → static fallback");
});

test("falls back to static ROUTER_MODEL when the best score has too few samples", async () => {
  const sm = modelSpy('{"intent":"build"}');
  const router = createAgentRouter({ ...baseDeps(sm), capabilityClient: selector(aScore({ modelId: "deepseek-v4-pro", sampleCount: 2 })) });

  await router.classify({ parentCtx: makeCtx("agent-a"), message: "x" });
  assert.equal(sm.calls[0]?.model, ROUTER_MODEL, "too few samples → static fallback");
});

test("falls back to static ROUTER_MODEL when the ledger has no score (returns null)", async () => {
  const sm = modelSpy('{"intent":"build"}');
  const router = createAgentRouter({ ...baseDeps(sm), capabilityClient: selector(null) });

  await router.classify({ parentCtx: makeCtx("agent-a"), message: "x" });
  assert.equal(sm.calls[0]?.model, ROUTER_MODEL, "no score → static fallback");
});

test("falls back to static ROUTER_MODEL when the capability lookup throws (ledger error)", async () => {
  const sm = modelSpy('{"intent":"build"}');
  const throwing: CapabilitySelector = { getBestModelForCategory: async () => { throw new Error("ledger boom"); } };
  const router = createAgentRouter({ ...baseDeps(sm), capabilityClient: throwing });

  await router.classify({ parentCtx: makeCtx("agent-a"), message: "x" });
  assert.equal(sm.calls[0]?.model, ROUTER_MODEL, "a thrown lookup degrades to static config");
});

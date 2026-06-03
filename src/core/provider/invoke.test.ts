import assert from "node:assert/strict";
import { test } from "node:test";

import { pino, type Logger } from "pino";

import {
  AllProvidersFailedError,
  type AgentIdentity,
  CONTRACT_VERSION,
  type ModelProvider,
  ModelNotFoundError,
  type ProviderInvocation,
  ProviderError,
  type ProviderResult,
  type TokenUsage,
} from "./contract.js";
import { computeCost, ProviderInvoker } from "./invoke.js";
import { ModelRegistry, type ModelSpec, type ProviderRoute } from "./registry.js";

const ID: AgentIdentity = { agentId: "test-agent", functionalRole: "tester", trustTier: "verified" };
const DEFAULT_COST = { promptPerMTok: 1, completionPerMTok: 2 };

function captureLogger(): { logger: Logger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const logger = pino(
    { level: "trace" },
    { write: (s: string) => void lines.push(JSON.parse(s) as Record<string, unknown>) },
  );
  return { logger, lines };
}

function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

class MockProvider implements ModelProvider {
  calls = 0;
  constructor(
    readonly id: string,
    private readonly impl: (inv: ProviderInvocation) => Promise<ProviderResult>,
  ) {}
  async invoke(inv: ProviderInvocation): Promise<ProviderResult> {
    this.calls += 1;
    return this.impl(inv);
  }
}

function okResult(usage?: Partial<TokenUsage>): ProviderResult {
  return {
    content: "hello",
    finishReason: "stop",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, ...usage },
  };
}

function http500(provider: string): ProviderError {
  return new ProviderError("boom", { kind: "http", provider, status: 500 });
}

function makeInvoker(
  providers: ModelProvider[],
  routes: ProviderRoute[],
  opts: { cost?: typeof DEFAULT_COST; now?: () => number; threshold?: number; cooldownMs?: number } = {},
): { invoker: ProviderInvoker; lines: Array<Record<string, unknown>> } {
  const model: ModelSpec = { id: "m", cost: opts.cost ?? DEFAULT_COST, providers: routes };
  const registry = new ModelRegistry({ models: [model], providers });
  const { logger, lines } = captureLogger();
  const invoker = new ProviderInvoker({
    registry,
    circuit: {
      failureThreshold: opts.threshold ?? 5,
      cooldownMs: opts.cooldownMs ?? 1000,
      halfOpenMaxTrials: 1,
    },
    defaultTimeoutMs: 1000,
    logger,
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { invoker, lines };
}

const ROUTES_2: ProviderRoute[] = [
  { provider: "p1", providerModelId: "x" },
  { provider: "p2", providerModelId: "y" },
];

test("deterministic fallback: primary fails -> backup serves; attempts recorded", async () => {
  const p1 = new MockProvider("p1", async () => { throw http500("p1"); });
  const p2 = new MockProvider("p2", async () => okResult());
  const { invoker, lines } = makeInvoker([p1, p2], ROUTES_2);

  const res = await invoker.invokeModel({ model: "m", prompt: "hi", identity: ID });

  assert.equal(res.provider, "p2");
  assert.equal(res.providerModelId, "y");
  assert.equal(res.fellBack, true);
  assert.equal(res.attempts.length, 2);
  assert.equal(res.attempts[0]?.outcome, "error");
  assert.equal(res.attempts[0]?.provider, "p1");
  assert.equal(res.attempts[1]?.outcome, "success");
  assert.equal(p1.calls, 1);
  assert.equal(p2.calls, 1);

  // Fallback is never silent — a fallback event and a success event are logged.
  assert.ok(lines.some((l) => l.event === "provider_fallback" && l.toProvider === "p2"));
  const ok = lines.find((l) => l.event === "model_invocation");
  assert.ok(ok, "success invocation logged");
  assert.equal(ok?.provider, "p2");
  assert.equal(typeof ok?.costUsd, "number");
  assert.equal(typeof ok?.latencyMs, "number");
  assert.ok(ok?.tokens, "tokens logged");
});

test("both providers fail -> typed AllProvidersFailedError with attempts", async () => {
  const p1 = new MockProvider("p1", async () => { throw http500("p1"); });
  const p2 = new MockProvider("p2", async () => { throw http500("p2"); });
  const { invoker } = makeInvoker([p1, p2], ROUTES_2);

  await assert.rejects(
    () => invoker.invokeModel({ model: "m", prompt: "hi", identity: ID }),
    (err: unknown) =>
      err instanceof AllProvidersFailedError &&
      err.model === "m" &&
      err.attempts.length === 2 &&
      err.attempts.every((a) => a.outcome === "error"),
  );
});

test("unknown model -> ModelNotFoundError", async () => {
  const { invoker } = makeInvoker([], []);
  await assert.rejects(
    () => invoker.invokeModel({ model: "ghost", prompt: "x", identity: ID }),
    ModelNotFoundError,
  );
});

test("cost & token accounting is correct", async () => {
  const p1 = new MockProvider("p1", async () =>
    okResult({ promptTokens: 1_000_000, completionTokens: 500_000, totalTokens: 1_500_000 }),
  );
  const { invoker } = makeInvoker([p1], [{ provider: "p1", providerModelId: "x" }], {
    cost: { promptPerMTok: 1, completionPerMTok: 2 },
  });

  const res = await invoker.invokeModel({ model: "m", prompt: "hi", identity: ID });
  assert.equal(res.usage.promptTokens, 1_000_000);
  assert.equal(res.usage.completionTokens, 500_000);
  assert.equal(res.cost.promptUsd, 1); // 1M / 1M * $1
  assert.equal(res.cost.completionUsd, 1); // 0.5M / 1M * $2
  assert.equal(res.cost.usd, 2);
  assert.deepEqual(res.cost.rate, { promptPerMTok: 1, completionPerMTok: 2 });
});

test("contract shape is stable and complete", async () => {
  const p1 = new MockProvider("p1", async () => okResult());
  const { invoker } = makeInvoker([p1], [{ provider: "p1", providerModelId: "x" }]);

  const res = await invoker.invokeModel({ model: "m", prompt: "hi", identity: ID });
  assert.equal(res.contractVersion, CONTRACT_VERSION);
  assert.equal(res.model, "m");
  assert.equal(res.provider, "p1");
  assert.equal(res.providerModelId, "x");
  assert.equal(res.content, "hello");
  assert.equal(res.finishReason, "stop");
  assert.equal(res.fellBack, false);
  assert.equal(res.toolCalls, undefined); // omitted when none
  assert.ok(res.usage && typeof res.usage.totalTokens === "number");
  assert.ok(res.cost && typeof res.cost.usd === "number");
  assert.equal(res.attempts.length, 1);
});

test("tool calls flow through when present", async () => {
  const p1 = new MockProvider("p1", async () => ({
    content: "",
    finishReason: "tool_calls",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    toolCalls: [{ id: "c1", name: "do_thing", arguments: '{"a":1}' }],
  }));
  const { invoker } = makeInvoker([p1], [{ provider: "p1", providerModelId: "x" }]);
  const res = await invoker.invokeModel({ model: "m", prompt: "hi", identity: ID });
  assert.equal(res.finishReason, "tool_calls");
  assert.equal(res.toolCalls?.length, 1);
  assert.equal(res.toolCalls?.[0]?.name, "do_thing");
});

test("per-request timeout trips, then falls back to a fast provider", async () => {
  const slow = new MockProvider(
    "p1",
    (inv) =>
      new Promise<ProviderResult>((resolve, reject) => {
        const t = setTimeout(() => resolve(okResult()), 5000);
        inv.signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new ProviderError("aborted", { kind: "network", provider: "p1" }));
        });
      }),
  );
  const fast = new MockProvider("p2", async () => okResult());
  const { invoker } = makeInvoker([slow, fast], ROUTES_2);

  const res = await invoker.invokeModel({ model: "m", prompt: "hi", identity: ID, timeoutMs: 25 });
  assert.equal(res.provider, "p2", "served by the fast backup");
  assert.equal(res.attempts[0]?.outcome, "timeout", "primary attempt classified as timeout");
  assert.equal(res.fellBack, true);
});

test("circuit breaker trips after N failures, skips during cooldown, retries after", async () => {
  const clock = fakeClock();
  const pf = new MockProvider("pf", async () => { throw http500("pf"); });
  const model: ModelSpec = {
    id: "solo",
    cost: DEFAULT_COST,
    providers: [{ provider: "pf", providerModelId: "z" }],
  };
  const registry = new ModelRegistry({ models: [model], providers: [pf] });
  const { logger } = captureLogger();
  const invoker = new ProviderInvoker({
    registry,
    circuit: { failureThreshold: 2, cooldownMs: 1000, halfOpenMaxTrials: 1 },
    defaultTimeoutMs: 1000,
    logger,
    now: clock.now,
  });

  const call = () => invoker.invokeModel({ model: "solo", prompt: "a", identity: ID });

  await assert.rejects(call); // failure 1
  await assert.rejects(call); // failure 2 -> opens
  assert.equal(pf.calls, 2);
  assert.equal(invoker.breakerSnapshot("pf", "z").state, "open");

  // While open, the provider is skipped (not hammered).
  await assert.rejects(call, (e: unknown) =>
    e instanceof AllProvidersFailedError && e.attempts[0]?.outcome === "skipped_open_circuit");
  assert.equal(pf.calls, 2, "provider not called while circuit open");

  // After cooldown, a half-open trial calls it again.
  clock.advance(1000);
  await assert.rejects(call);
  assert.equal(pf.calls, 3, "half-open trial reaches the provider");
});

test("cost is cache-aware: cached prompt tokens charged at the cached rate", () => {
  const cost = computeCost(
    { promptPerMTok: 10, completionPerMTok: 20, cachedPromptPerMTok: 1 },
    { promptTokens: 1_000_000, completionTokens: 500_000, totalTokens: 1_500_000, cachedTokens: 400_000 },
  );
  // 600k non-cached prompt @ $10/M = 6 ; 400k cached @ $1/M = 0.4 ; 500k completion @ $20/M = 10
  assert.equal(cost.promptUsd, 6);
  assert.equal(cost.cachedUsd, 0.4);
  assert.equal(cost.completionUsd, 10);
  assert.equal(cost.usd, 16.4);
});

test("cached rate falls back to the prompt rate when unset", () => {
  const cost = computeCost(
    { promptPerMTok: 10, completionPerMTok: 20 },
    { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, cachedTokens: 500_000 },
  );
  // No cached rate -> cached tokens charged at the prompt rate; total prompt cost unchanged.
  assert.equal(cost.promptUsd + cost.cachedUsd, 10);
  assert.equal(cost.usd, 10);
});

test("per-provider cost: fallback is priced at the serving route's rate", async () => {
  const p1 = new MockProvider("p1", async () => { throw http500("p1"); });
  const p2 = new MockProvider("p2", async () =>
    okResult({ promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 }),
  );
  const routes: ProviderRoute[] = [
    { provider: "p1", providerModelId: "x", cost: { promptPerMTok: 5, completionPerMTok: 5 } },
    { provider: "p2", providerModelId: "y", cost: { promptPerMTok: 99, completionPerMTok: 99 } },
  ];
  const registry = new ModelRegistry({ models: [{ id: "m", providers: routes }], providers: [p1, p2] });
  const { logger } = captureLogger();
  const invoker = new ProviderInvoker({
    registry,
    circuit: { failureThreshold: 5, cooldownMs: 1000, halfOpenMaxTrials: 1 },
    defaultTimeoutMs: 1000,
    logger,
  });
  const res = await invoker.invokeModel({ model: "m", prompt: "hi", identity: ID });
  assert.equal(res.provider, "p2");
  assert.equal(res.cost.usd, 99, "priced at p2's rate, not p1's");
  assert.equal(res.cost.rate.promptPerMTok, 99);
});

test("response.contractVersion is always the server version, never the echoed request", async () => {
  const p1 = new MockProvider("p1", async () => okResult());
  const { invoker } = makeInvoker([p1], [{ provider: "p1", providerModelId: "x" }]);
  const res = await invoker.invokeModel({
    model: "m",
    prompt: "hi",
    identity: ID,
    contractVersion: "0.0.1-ancient",
  });
  assert.equal(res.contractVersion, CONTRACT_VERSION);
  assert.notEqual(res.contractVersion, "0.0.1-ancient");
});

test("non-retriable failures fail the call but do NOT trip the breaker", async () => {
  const authFail = new MockProvider("p1", async () => {
    throw new ProviderError("bad key", { kind: "auth", provider: "p1", retriable: false });
  });
  const registry = new ModelRegistry({
    models: [{ id: "m", cost: DEFAULT_COST, providers: [{ provider: "p1", providerModelId: "x" }] }],
    providers: [authFail],
  });
  const { logger } = captureLogger();
  const invoker = new ProviderInvoker({
    registry,
    circuit: { failureThreshold: 2, cooldownMs: 1000, halfOpenMaxTrials: 1 },
    defaultTimeoutMs: 1000,
    logger,
  });
  const call = () => invoker.invokeModel({ model: "m", prompt: "hi", identity: ID });

  // Many permanent failures, well past the threshold.
  for (let i = 0; i < 5; i++) {
    await assert.rejects(call, (e: unknown) =>
      e instanceof AllProvidersFailedError && e.attempts[0]?.outcome === "permanent_error");
  }
  assert.equal(invoker.breakerSnapshot("p1", "x").state, "closed", "breaker never opened on permanent errors");
  assert.equal(authFail.calls, 5, "provider still attempted each time (not skipped)");
});

test("breaker is keyed per (provider, model): a bad model doesn't open the whole provider", async () => {
  // Same provider id "p", two models. Model "bad" always fails; "good" always succeeds.
  const provider = new MockProvider("p", async (inv) => {
    if (inv.providerModelId === "bad-wire") throw http500("p");
    return okResult();
  });
  const registry = new ModelRegistry({
    models: [
      { id: "bad", cost: DEFAULT_COST, providers: [{ provider: "p", providerModelId: "bad-wire" }] },
      { id: "good", cost: DEFAULT_COST, providers: [{ provider: "p", providerModelId: "good-wire" }] },
    ],
    providers: [provider],
  });
  const { logger } = captureLogger();
  const invoker = new ProviderInvoker({
    registry,
    circuit: { failureThreshold: 2, cooldownMs: 1000, halfOpenMaxTrials: 1 },
    defaultTimeoutMs: 1000,
    logger,
  });

  // Trip the breaker for the bad model only.
  await assert.rejects(() => invoker.invokeModel({ model: "bad", prompt: "x", identity: ID }));
  await assert.rejects(() => invoker.invokeModel({ model: "bad", prompt: "x", identity: ID }));
  assert.equal(invoker.breakerSnapshot("p", "bad-wire").state, "open");

  // The good model on the SAME provider is unaffected.
  assert.equal(invoker.breakerSnapshot("p", "good-wire").state, "closed");
  const res = await invoker.invokeModel({ model: "good", prompt: "x", identity: ID });
  assert.equal(res.provider, "p");
  assert.equal(res.content, "hello");
});

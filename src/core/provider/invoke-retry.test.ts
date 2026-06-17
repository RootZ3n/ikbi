import assert from "node:assert/strict";
import { test } from "node:test";

import { pino, type Logger } from "pino";

import {
  AllProvidersFailedError,
  type AgentIdentity,
  type ModelProvider,
  type ProviderInvocation,
  ProviderError,
  type ProviderResult,
} from "./contract.js";
import { ProviderInvoker, type InvokerRetryConfig } from "./invoke.js";
import { ModelRegistry, type ModelSpec, type ProviderRoute } from "./registry.js";
import { parseRetryAfter } from "./providers/openai-compatible.js";

const ID: AgentIdentity = { agentId: "a", functionalRole: "tester", trustTier: "verified" };
const COST = { promptPerMTok: 1, completionPerMTok: 2 };
const ROUTE: ProviderRoute[] = [{ provider: "p1", providerModelId: "x" }];

function silentLogger(): Logger {
  return pino({ level: "silent" }, { write: () => {} });
}

class MockProvider implements ModelProvider {
  calls = 0;
  constructor(readonly id: string, private readonly impl: (n: number) => Promise<ProviderResult>) {}
  async invoke(_inv: ProviderInvocation): Promise<ProviderResult> {
    this.calls += 1;
    return this.impl(this.calls);
  }
}

function ok(): ProviderResult {
  return { content: "ok", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
}

function http(status: number, provider = "p1", retryAfterMs?: number): ProviderError {
  return new ProviderError("boom", {
    kind: status === 429 ? "rate_limit" : "http",
    provider,
    status,
    retriable: status >= 500 || status === 429,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
}

function makeInvoker(provider: ModelProvider, retry: InvokerRetryConfig): { invoker: ProviderInvoker; delays: number[] } {
  const model: ModelSpec = { id: "m", cost: COST, providers: ROUTE };
  const registry = new ModelRegistry({ models: [model], providers: [provider] });
  const delays: number[] = [];
  const invoker = new ProviderInvoker({
    registry,
    circuit: { failureThreshold: 5, cooldownMs: 1000, halfOpenMaxTrials: 1 },
    defaultTimeoutMs: 1000,
    logger: silentLogger(),
    retry,
    sleep: async (ms) => void delays.push(ms),
  });
  return { invoker, delays };
}

test("retry: a single-route 5xx is retried on the SAME route and then succeeds", async () => {
  const p = new MockProvider("p1", async (n) => {
    if (n < 3) throw http(500);
    return ok();
  });
  const { invoker, delays } = makeInvoker(p, { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 100 });
  const res = await invoker.invokeModel({ model: "m", prompt: "hi", identity: ID });
  assert.equal(res.provider, "p1");
  assert.equal(p.calls, 3); // 1 initial + 2 retries
  assert.equal(delays.length, 2); // two backoff sleeps
});

test("retry: maxRetries 0 (default) does NOT retry — one attempt then fail", async () => {
  const p = new MockProvider("p1", async () => { throw http(500); });
  const { invoker, delays } = makeInvoker(p, { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 100 });
  await assert.rejects(invoker.invokeModel({ model: "m", prompt: "hi", identity: ID }), AllProvidersFailedError);
  assert.equal(p.calls, 1);
  assert.equal(delays.length, 0);
});

test("retry: a permanent (non-retriable) failure is never retried", async () => {
  const p = new MockProvider("p1", async () => new Promise((_r, rej) => rej(http(401))));
  const { invoker, delays } = makeInvoker(p, { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100 });
  await assert.rejects(invoker.invokeModel({ model: "m", prompt: "hi", identity: ID }), AllProvidersFailedError);
  assert.equal(p.calls, 1); // 401 is permanent — no retry
  assert.equal(delays.length, 0);
});

test("retry: honors a server Retry-After (retryAfterMs) over computed backoff", async () => {
  const p = new MockProvider("p1", async (n) => {
    if (n < 2) throw http(429, "p1", 4321);
    return ok();
  });
  const { invoker, delays } = makeInvoker(p, { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50 });
  await invoker.invokeModel({ model: "m", prompt: "hi", identity: ID });
  assert.equal(delays[0], 4321); // server-requested backoff used verbatim
});

test("parseRetryAfter: delta-seconds, HTTP-date, and junk", () => {
  assert.equal(parseRetryAfter("5"), 5000);
  assert.equal(parseRetryAfter("0"), undefined);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter("not-a-date"), undefined);
  // 10s in the future from a fixed now
  const now = 1_000_000;
  const future = new Date(now + 10_000).toUTCString();
  const parsed = parseRetryAfter(future, now);
  assert.ok(parsed !== undefined && parsed > 8_000 && parsed <= 10_000);
  // absurd values are clamped to the 120s cap
  assert.equal(parseRetryAfter("99999"), 120_000);
});

/**
 * THE TRANSPORT ADAPTER — one attempt, real sockets, donor errors mapped.
 *
 * These run against the same protocol-faithful local server the end-to-end suite uses,
 * but drive the adapter directly, so the timeout and error-classification paths can be
 * exercised in milliseconds instead of at production timeouts.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { OpenAICompatibleProvider } from "../../core/provider/providers/openai-compatible.js";
import type { ModelProvider } from "../../core/provider/contract.js";
import { V2_INVOCATION_FAILURE_CODES } from "../core/invocation.js";
import { startFakeOpenAIProvider, type FakeProviderOptions, type FakeProviderServer } from "../cli/fake-provider-server.js";
import { createInvocationTransport, mapProviderErrorCode } from "./invocation-transport.js";

const servers: FakeProviderServer[] = [];

after(async () => {
  for (const server of servers) await server.close();
});

/** A REAL v1 transport pointed at a REAL local endpoint. The fetch guard is bypassed by
 *  injecting `globalThis.fetch` — the egress floor is proven separately, end to end. */
async function realProvider(options: FakeProviderOptions = {}): Promise<{ provider: ModelProvider; server: FakeProviderServer }> {
  const server = await startFakeOpenAIProvider(options);
  servers.push(server);
  const provider = new OpenAICompatibleProvider({
    id: "p1",
    baseUrl: server.baseUrl,
    apiKey: undefined,
    keyless: true,
    fetchImpl: globalThis.fetch,
  });
  return { provider, server };
}

const lookupOf = (provider: ModelProvider | undefined) => ({ getProvider: () => provider });

const send = (provider: ModelProvider | undefined, timeoutMs = 5_000) =>
  createInvocationTransport(lookupOf(provider)).send({
    providerId: "p1",
    providerModelId: "alpha-v1",
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "user" },
    ],
    parameters: { maxOutputTokens: 32, timeoutMs },
  });

test("adapter: one call reaches the wire and returns served identity + usage", async () => {
  const { provider, server } = await realProvider();
  const outcome = await send(provider);
  assert.ok(outcome.ok);
  assert.equal(outcome.response.attempts, 1, "exactly one outbound attempt");
  assert.equal(outcome.response.servedModelId, "alpha-v1", "read from the response body");
  assert.deepEqual(outcome.response.usage, { promptTokens: 42, completionTokens: 7, totalTokens: 49 });
  const calls = (await server.received()).filter((r) => r.path.includes("chat/completions"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.wireModelId, "alpha-v1", "EXACTLY the id it was given");
  assert.equal(calls[0]?.maxTokens, 32);
});

test("adapter: a response with no model yields no servedModelId — never the sent id", async () => {
  const { provider } = await realProvider({ servedModelId: null });
  const outcome = await send(provider);
  assert.ok(outcome.ok);
  assert.equal(outcome.response.servedModelId, undefined);
});

test("adapter: a slow provider TIMES OUT structurally, after exactly one attempt", async () => {
  const { provider, server } = await realProvider({ delayMs: 3_000 });
  const outcome = await send(provider, 250);
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok);
  assert.equal(outcome.failure.code, V2_INVOCATION_FAILURE_CODES.transportTimeout);
  assert.equal(outcome.failure.attempts, 1);
  const calls = (await server.received()).filter((r) => r.path.includes("chat/completions"));
  assert.equal(calls.length, 1, "a timeout is not retried");
});

test("adapter: a 4xx is a rejection and a 5xx is a transport failure", async () => {
  const rejected = await send((await realProvider({ status: 400 })).provider);
  assert.ok(!rejected.ok);
  assert.equal(rejected.failure.code, V2_INVOCATION_FAILURE_CODES.providerRejected);
  assert.equal(rejected.failure.status, 400);

  const failed = await send((await realProvider({ status: 503 })).provider);
  assert.ok(!failed.ok);
  assert.equal(failed.failure.code, V2_INVOCATION_FAILURE_CODES.transportFailure);
});

test("adapter: a malformed body is a malformed-response failure", async () => {
  const outcome = await send((await realProvider({ bodyOverride: { nonsense: true } })).provider);
  assert.ok(!outcome.ok);
  assert.equal(outcome.failure.code, V2_INVOCATION_FAILURE_CODES.malformedResponse);
});

test("adapter: an unregistered provider fails WITHOUT reaching the wire", async () => {
  const outcome = await send(undefined);
  assert.ok(!outcome.ok);
  assert.equal(outcome.failure.code, V2_INVOCATION_FAILURE_CODES.providerNotAvailable);
  assert.equal(outcome.failure.attempts, 0, "intention is not an invocation");
});

test("adapter: a provider that is not ready fails WITHOUT reaching the wire", async () => {
  const notReady = { id: "p1", ready: () => false, invoke: () => Promise.reject(new Error("must not be called")) } as unknown as ModelProvider;
  const outcome = await send(notReady);
  assert.ok(!outcome.ok);
  assert.equal(outcome.failure.code, V2_INVOCATION_FAILURE_CODES.credentialMissing);
  assert.equal(outcome.failure.attempts, 0);
});

test("adapter: the donor's own classification is preserved, not collapsed", () => {
  assert.equal(mapProviderErrorCode("timeout", undefined), V2_INVOCATION_FAILURE_CODES.transportTimeout);
  assert.equal(mapProviderErrorCode("auth", 401), V2_INVOCATION_FAILURE_CODES.credentialMissing);
  assert.equal(mapProviderErrorCode("rate_limit", 429), V2_INVOCATION_FAILURE_CODES.rateLimited);
  assert.equal(mapProviderErrorCode("bad_response", undefined), V2_INVOCATION_FAILURE_CODES.malformedResponse);
  assert.equal(mapProviderErrorCode("config", undefined), V2_INVOCATION_FAILURE_CODES.unsupportedProtocol);
  assert.equal(mapProviderErrorCode("network", undefined), V2_INVOCATION_FAILURE_CODES.transportFailure);
  assert.equal(mapProviderErrorCode("http", 404), V2_INVOCATION_FAILURE_CODES.providerRejected);
  assert.equal(mapProviderErrorCode("http", 502), V2_INVOCATION_FAILURE_CODES.transportFailure);
  assert.equal(mapProviderErrorCode("unknown", undefined), V2_INVOCATION_FAILURE_CODES.internal);
});

test("adapter: the v1 transport itself never retries — one invoke is one request", async () => {
  // The audit claim, asserted rather than assumed: a single `invoke` produces a single
  // HTTP request, so `attempts: 1` is a fact about the donor and not a hopeful constant.
  const { provider, server } = await realProvider();
  await send(provider);
  await send(provider);
  const calls = (await server.received()).filter((r) => r.path.includes("chat/completions"));
  assert.equal(calls.length, 2, "two invocations, two requests — nothing multiplied them");
});

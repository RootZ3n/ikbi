import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import type { AgentIdentity, ModelProvider, ProviderInvocation, ProviderResult, StreamDelta } from "./contract.js";
import { ProviderError } from "./contract.js";
import { registerFetchGuard } from "./fetch-guard.js";
import { ProviderInvoker } from "./invoke.js";
import { ModelRegistry, type ModelSpec, type ProviderRoute } from "./registry.js";
import { StreamAccumulator } from "./stream-accumulate.js";
import { type FetchLike, OpenAICompatibleProvider } from "./providers/openai-compatible.js";

// Construction-time fail-closed seam (mirrors the other provider tests).
registerFetchGuard((async () => {
  throw new Error("egress guard stub: not exercised");
}) as FetchLike);

const ID: AgentIdentity = { agentId: "test", functionalRole: "tester", trustTier: "verified" };

function invocation(): ProviderInvocation {
  return {
    providerModelId: "wire-model",
    request: { model: "m", prompt: "hi", identity: ID },
    timeoutMs: 1000,
    signal: new AbortController().signal,
  };
}

/** A ReadableStream of UTF-8 bytes from the given text chunks (chunks need not align to frames). */
function byteStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

/** A streaming fetch double whose body replays the supplied SSE chunks. */
function streamFetch(chunks: readonly string[], opts: { status?: number; errorBody?: string } = {}): FetchLike {
  const status = opts.status ?? 200;
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => opts.errorBody ?? "",
    body: status >= 200 && status < 300 ? byteStream(chunks) : null,
  })) as unknown as FetchLike;
}

async function collect(stream: AsyncIterable<StreamDelta>): Promise<StreamDelta[]> {
  const out: StreamDelta[] = [];
  for await (const d of stream) out.push(d);
  return out;
}

// ── provider invokeStream: SSE → deltas ─────────────────────────────────────

test("invokeStream parses content deltas, finish reason, and trailing usage", async () => {
  const chunks = [
    `data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n`,
    `data: {"choices":[{"delta":{"content":"lo"}}]}\n\n`,
    `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`,
    `data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n`,
    `data: [DONE]\n\n`,
  ];
  const p = new OpenAICompatibleProvider({ id: "mimo", baseUrl: "https://x/v1", apiKey: "k", fetchImpl: streamFetch(chunks) });
  const deltas = await collect(await p.invokeStream(invocation()));

  const acc = new StreamAccumulator();
  for (const d of deltas) acc.push(d);
  const r = acc.result();
  assert.equal(r.content, "Hello");
  assert.equal(r.finishReason, "stop");
  assert.equal(r.usage?.totalTokens, 7);
  assert.equal(r.toolCalls.length, 0);
});

test("invokeStream tolerates frames split across network chunks", async () => {
  // The same two-frame payload, but sliced mid-frame and mid-newline.
  const chunks = [`data: {"choices":[{"delta":{"con`, `tent":"AB"}}]}\n\ndata: {"choices":[{"delta":{"content":"CD"}}]}`, `\n\ndata: [DONE]\n\n`];
  const p = new OpenAICompatibleProvider({ id: "mimo", baseUrl: "https://x/v1", apiKey: "k", fetchImpl: streamFetch(chunks) });
  const acc = new StreamAccumulator();
  for (const d of await collect(await p.invokeStream(invocation()))) acc.push(d);
  assert.equal(acc.result().content, "ABCD");
});

test("invokeStream sends stream:true + include_usage in the body", async () => {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    body = JSON.parse(init.body) as Record<string, unknown>;
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}), text: async () => "", body: byteStream([`data: [DONE]\n\n`]) };
  }) as unknown as FetchLike;
  const p = new OpenAICompatibleProvider({ id: "mimo", baseUrl: "https://x/v1", apiKey: "k", fetchImpl });
  await collect(await p.invokeStream(invocation()));
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
});

test("invokeStream assembles index-keyed tool-call fragments", async () => {
  const chunks = [
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":""}}]}}]}\n\n`,
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}\n\n`,
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.ts\\"}"}}]}}]}\n\n`,
    `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n`,
    `data: [DONE]\n\n`,
  ];
  const p = new OpenAICompatibleProvider({ id: "mimo", baseUrl: "https://x/v1", apiKey: "k", fetchImpl: streamFetch(chunks) });
  const acc = new StreamAccumulator();
  for (const d of await collect(await p.invokeStream(invocation()))) acc.push(d);
  const r = acc.result();
  assert.equal(r.finishReason, "tool_calls");
  assert.equal(r.toolCalls.length, 1);
  assert.deepEqual(r.toolCalls[0], { id: "call_1", name: "read_file", arguments: `{"path":"a.ts"}` });
});

test("invokeStream throws a ProviderError on an HTTP error (pre-stream), like invoke", async () => {
  const p = new OpenAICompatibleProvider({ id: "mimo", baseUrl: "https://x/v1", apiKey: "k", fetchImpl: streamFetch([], { status: 500, errorBody: "boom" }) });
  await assert.rejects(
    () => p.invokeStream(invocation()),
    (e: unknown) => e instanceof ProviderError && e.kind === "http" && e.status === 500,
  );
});

test("invokeStream throws bad_response when a chunk is malformed JSON", async () => {
  const p = new OpenAICompatibleProvider({ id: "mimo", baseUrl: "https://x/v1", apiKey: "k", fetchImpl: streamFetch([`data: {not json}\n\n`]) });
  await assert.rejects(
    async () => collect(await p.invokeStream(invocation())),
    (e: unknown) => e instanceof ProviderError && e.kind === "bad_response",
  );
});

test("invokeStream fails fast on a missing API key (keyed provider), no fetch", async () => {
  let called = false;
  const fetchImpl = (async () => { called = true; throw new Error("nope"); }) as unknown as FetchLike;
  const p = new OpenAICompatibleProvider({ id: "mimo", baseUrl: "https://x/v1", apiKey: undefined, fetchImpl });
  await assert.rejects(
    () => p.invokeStream(invocation()),
    (e: unknown) => e instanceof ProviderError && e.kind === "auth" && e.retriable === false,
  );
  assert.equal(called, false);
});

// ── StreamAccumulator unit behavior ─────────────────────────────────────────

test("StreamAccumulator infers tool_calls finishReason when none was sent", () => {
  const acc = new StreamAccumulator();
  acc.push({ toolCalls: [{ index: 0, id: "c", name: "done", arguments: "{}" }] });
  const r = acc.result();
  assert.equal(r.finishReason, "tool_calls");
  assert.equal(r.toolCalls[0]?.name, "done");
});

test("StreamAccumulator exposes running content via currentContent", () => {
  const acc = new StreamAccumulator();
  acc.push({ content: "foo" });
  assert.equal(acc.currentContent, "foo");
  acc.push({ content: "bar" });
  assert.equal(acc.currentContent, "foobar");
});

// ── invoker.invokeModelStream: fallback chain ───────────────────────────────

function makeInvoker(providers: ModelProvider[], routes: ProviderRoute[]): ProviderInvoker {
  const model: ModelSpec = { id: "m", cost: { promptPerMTok: 1, completionPerMTok: 2 }, providers: routes };
  const registry = new ModelRegistry({ models: [model], providers });
  return new ProviderInvoker({
    registry,
    circuit: { failureThreshold: 5, cooldownMs: 1000, halfOpenMaxTrials: 1 },
    defaultTimeoutMs: 1000,
    logger: pino({ level: "silent" }),
  });
}

/** A provider with NO invokeStream — exercises the non-streaming fallback adaptation. */
class NonStreamingProvider implements ModelProvider {
  constructor(readonly id: string, private readonly result: ProviderResult) {}
  async invoke(): Promise<ProviderResult> {
    return this.result;
  }
}

test("invokeModelStream falls back to invoke() for a provider that cannot stream", async () => {
  const p = new NonStreamingProvider("p1", { content: "whole answer", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
  const invoker = makeInvoker([p], [{ provider: "p1", providerModelId: "x" }]);
  const acc = new StreamAccumulator();
  for await (const d of await invoker.invokeModelStream({ model: "m", prompt: "hi", identity: ID })) acc.push(d);
  const r = acc.result();
  assert.equal(r.content, "whole answer");
  assert.equal(r.finishReason, "stop");
  assert.equal(r.usage?.totalTokens, 2);
});

test("invokeModelStream falls back to the next route when the primary stream fails pre-stream", async () => {
  // p1 streams but its endpoint 500s before any frame; p2 cannot stream and serves request/response.
  const p1 = new OpenAICompatibleProvider({ id: "p1", baseUrl: "https://x/v1", apiKey: "k", fetchImpl: streamFetch([], { status: 500, errorBody: "down" }) });
  const p2 = new NonStreamingProvider("p2", { content: "served by backup", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
  const invoker = makeInvoker([p1, p2], [{ provider: "p1", providerModelId: "x" }, { provider: "p2", providerModelId: "y" }]);
  const acc = new StreamAccumulator();
  for await (const d of await invoker.invokeModelStream({ model: "m", prompt: "hi", identity: ID })) acc.push(d);
  assert.equal(acc.result().content, "served by backup");
});

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModelMessage, ProviderInvocation, StreamDelta } from "../contract.js";
import { StreamAccumulator } from "../stream-accumulate.js";
import { AnthropicProvider } from "./anthropic.js";
import type { FetchLike } from "./openai-compatible.js";

function invocation(overrides?: Partial<ProviderInvocation["request"]>): ProviderInvocation {
  // When the caller supplies `messages`, omit the convenience `prompt` (they are alternatives).
  const base =
    overrides?.messages !== undefined
      ? { model: "opus-4.8", identity: { agentId: "a" } }
      : { model: "opus-4.8", prompt: "hi", identity: { agentId: "a" } };
  return {
    providerModelId: "claude-opus-4-8",
    request: { ...base, ...overrides },
    timeoutMs: 1000,
    signal: new AbortController().signal,
  };
}

function jsonFetch(
  status: number,
  payload: unknown,
): { fetchImpl: FetchLike; captured: { url?: string; init?: Parameters<FetchLike>[1] } } {
  const captured: { url?: string; init?: Parameters<FetchLike>[1] } = {};
  const fetchImpl: FetchLike = async (url, init) => {
    captured.url = url;
    captured.init = init;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => payload,
      text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
    };
  };
  return { fetchImpl, captured };
}

function byteStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

function streamFetch(chunks: readonly string[]): FetchLike {
  return (async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => "",
    body: byteStream(chunks),
  })) as unknown as FetchLike;
}

test("hits /messages with x-api-key + anthropic-version and parses text + usage", async () => {
  const { fetchImpl, captured } = jsonFetch(200, {
    content: [{ type: "text", text: "hello there" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 4 },
  });
  const p = new AnthropicProvider({ id: "anthropic", baseUrl: "https://api.anthropic.com/v1/", apiKey: "sk", fetchImpl });
  const r = await p.invoke(invocation());

  assert.equal(r.content, "hello there");
  assert.equal(r.finishReason, "stop");
  assert.equal(r.usage.promptTokens, 10);
  assert.equal(r.usage.completionTokens, 4);
  assert.equal(r.usage.totalTokens, 14);

  assert.equal(captured.url, "https://api.anthropic.com/v1/messages");
  assert.equal(captured.init?.headers["x-api-key"], "sk");
  assert.equal(captured.init?.headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(captured.init?.body ?? "{}") as { model: string; max_tokens: number; messages: unknown };
  assert.equal(body.model, "claude-opus-4-8");
  assert.equal(body.max_tokens, 4096); // Anthropic requires max_tokens; defaulted
  assert.deepEqual(body.messages, [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
});

test("hoists system messages to top-level system[] with a cache breakpoint", async () => {
  const { fetchImpl, captured } = jsonFetch(200, {
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const messages: ModelMessage[] = [
    { role: "system", content: "you are a builder" },
    { role: "user", content: "go" },
  ];
  const p = new AnthropicProvider({ id: "anthropic", baseUrl: "https://x/v1", apiKey: "sk", fetchImpl });
  await p.invoke(invocation({ messages }));

  const body = JSON.parse(captured.init?.body ?? "{}") as { system: unknown[]; messages: unknown[] };
  assert.deepEqual(body.system, [{ type: "text", text: "you are a builder", cache_control: { type: "ephemeral" } }]);
  assert.deepEqual(body.messages, [{ role: "user", content: [{ type: "text", text: "go" }] }]);
});

test("caches the last tool schema and maps tools to Anthropic input_schema", async () => {
  const { fetchImpl, captured } = jsonFetch(200, {
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const p = new AnthropicProvider({ id: "anthropic", baseUrl: "https://x/v1", apiKey: "sk", fetchImpl });
  await p.invoke(
    invocation({
      tools: [
        { name: "read_file", description: "read", parameters: { type: "object" } },
        { name: "write_file", description: "write", parameters: { type: "object" } },
      ],
    }),
  );
  const body = JSON.parse(captured.init?.body ?? "{}") as { tools: unknown[] };
  assert.equal(body.tools.length, 2);
  // Read cache_control off fresh casts BEFORE any deepEqual (which narrows the binding).
  assert.equal((body.tools[0] as Record<string, unknown>).cache_control, undefined);
  assert.deepEqual((body.tools[1] as Record<string, unknown>).cache_control, { type: "ephemeral" });
  assert.deepEqual(body.tools[0], { name: "read_file", description: "read", input_schema: { type: "object" } });
});

test("round-trips tool_use (assistant) and tool_result (tool) blocks", async () => {
  const { fetchImpl, captured } = jsonFetch(200, {
    content: [
      { type: "text", text: "calling" },
      { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a.ts" } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 5, output_tokens: 6 },
  });
  const messages: ModelMessage[] = [
    { role: "user", content: "read a.ts" },
    { role: "assistant", content: "", toolCalls: [{ id: "tu_1", name: "read_file", arguments: '{"path":"a.ts"}' }] },
    { role: "tool", content: "file contents", toolCallId: "tu_1" },
  ];
  const p = new AnthropicProvider({ id: "anthropic", baseUrl: "https://x/v1", apiKey: "sk", fetchImpl });
  const r = await p.invoke(invocation({ messages }));

  // Response tool_use parsed into a ToolCall.
  assert.equal(r.finishReason, "tool_calls");
  assert.equal(r.content, "calling");
  assert.equal(r.toolCalls?.length, 1);
  assert.equal(r.toolCalls?.[0]?.name, "read_file");
  assert.equal(r.toolCalls?.[0]?.arguments, JSON.stringify({ path: "a.ts" }));

  // Request wire: assistant tool_use block + a following user tool_result block.
  const body = JSON.parse(captured.init?.body ?? "{}") as { messages: Array<{ role: string; content: unknown[] }> };
  assert.equal(body.messages[1]?.role, "assistant");
  assert.deepEqual(body.messages[1]?.content, [{ type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a.ts" } }]);
  assert.equal(body.messages[2]?.role, "user");
  assert.deepEqual(body.messages[2]?.content, [{ type: "tool_result", tool_use_id: "tu_1", content: "file contents" }]);
});

test("maps cache-read tokens into promptTokens + cachedTokens", async () => {
  const { fetchImpl } = jsonFetch(200, {
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
  });
  const p = new AnthropicProvider({ id: "anthropic", baseUrl: "https://x/v1", apiKey: "sk", fetchImpl });
  const r = await p.invoke(invocation());
  assert.equal(r.usage.promptTokens, 123); // 3 + 100 + 20
  assert.equal(r.usage.cachedTokens, 100);
  assert.ok((r.usage.cachedTokens ?? 0) <= r.usage.promptTokens);
});

test("missing API key fails fast as a non-retriable auth error (no fetch)", async () => {
  let called = false;
  const fetchImpl: FetchLike = async () => {
    called = true;
    throw new Error("should not be called");
  };
  const p = new AnthropicProvider({ id: "anthropic", baseUrl: "https://x/v1", apiKey: undefined, fetchImpl });
  await assert.rejects(p.invoke(invocation()), /no API key/);
  assert.equal(called, false);
});

test("maps a 429 to a retriable rate_limit error", async () => {
  const { fetchImpl } = jsonFetch(429, "slow down");
  const p = new AnthropicProvider({ id: "anthropic", baseUrl: "https://x/v1", apiKey: "sk", fetchImpl });
  await assert.rejects(p.invoke(invocation()), (e: unknown) => {
    const err = e as { kind?: string; retriable?: boolean };
    return err.kind === "rate_limit" && err.retriable === true;
  });
});

test("streams typed SSE events into content + tool call + usage", async () => {
  const frames = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 1 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_9", name: "read_file" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"a.ts"}' } })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ];
  const p = new AnthropicProvider({ id: "anthropic", baseUrl: "https://x/v1", apiKey: "sk", fetchImpl: streamFetch(frames) });
  const stream = await p.invokeStream(invocation());

  const acc = new StreamAccumulator();
  const deltas: StreamDelta[] = [];
  for await (const d of stream) {
    deltas.push(d);
    acc.push(d);
  }
  const final = acc.result();
  assert.equal(final.content, "Hello");
  assert.equal(final.finishReason, "tool_calls");
  assert.equal(final.toolCalls?.length, 1);
  assert.equal(final.toolCalls?.[0]?.id, "tu_9");
  assert.equal(final.toolCalls?.[0]?.name, "read_file");
  assert.equal(final.toolCalls?.[0]?.arguments, '{"path":"a.ts"}');
  assert.ok(final.usage);
  assert.equal(final.usage.promptTokens, 12);
  assert.equal(final.usage.completionTokens, 7);
});

test("flushes tail buffer content when stream ends without trailing newline", async () => {
  // Split the last SSE frame so it has no trailing newline — the tail flush must still yield it.
  const frames = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } })}\n\n`,
    // message_delta WITHOUT a trailing newline — simulates a server that omits the final \n
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } })}\n`,
    // no trailing newline — buffer has leftover content when stream ends
  ];
  const p = new AnthropicProvider({ id: "anthropic", baseUrl: "https://x/v1", apiKey: "sk", fetchImpl: streamFetch(frames) });
  const stream = await p.invokeStream(invocation());

  const acc = new StreamAccumulator();
  for await (const d of stream) acc.push(d);
  const final = acc.result();
  assert.equal(final.content, "Hello");
  assert.equal(final.finishReason, "stop");
  assert.ok(final.usage);
  assert.equal(final.usage.promptTokens, 5);
  assert.equal(final.usage.completionTokens, 3);
});

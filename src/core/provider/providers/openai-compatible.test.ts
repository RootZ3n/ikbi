import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProviderInvocation } from "../contract.js";
import { ProviderError } from "../contract.js";
import { registerFetchGuard } from "../fetch-guard.js";
import { createMimoProvider, createOpenRouterProvider } from "./index.js";
import { type FetchLike, OpenAICompatibleProvider } from "./openai-compatible.js";

// In production the network-egress floor registers a guarded fetch BEFORE any
// provider constructs (fail-closed seam). Mirror that precondition for the
// factory/construction tests below that don't inject their own fetchImpl. The
// stub throws if actually called — these tests assert construction, not I/O.
const guardStub: FetchLike = async () => {
  throw new Error("egress guard stub: not exercised in this test");
};
registerFetchGuard(guardStub);

function invocation(overrides?: Partial<ProviderInvocation["request"]>): ProviderInvocation {
  return {
    providerModelId: "wire-model",
    request: { model: "m", prompt: "hi", identity: { agentId: "a" }, ...overrides },
    timeoutMs: 1000,
    signal: new AbortController().signal,
  };
}

function jsonFetch(status: number, payload: unknown): { fetchImpl: FetchLike; captured: { url?: string; init?: Parameters<FetchLike>[1] } } {
  const captured: { url?: string; init?: Parameters<FetchLike>[1] } = {};
  const fetchImpl: FetchLike = async (url, init) => {
    captured.url = url;
    captured.init = init;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
    };
  };
  return { fetchImpl, captured };
}

test("parses a successful OpenAI-compatible completion", async () => {
  const { fetchImpl, captured } = jsonFetch(200, {
    choices: [{ message: { content: "hi there" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  });
  const p = new OpenAICompatibleProvider({ id: "mimo", baseUrl: "https://x/v1/", apiKey: "k", fetchImpl });
  const r = await p.invoke(invocation());

  assert.equal(r.content, "hi there");
  assert.equal(r.finishReason, "stop");
  assert.equal(r.usage.totalTokens, 7);

  // Wire request is shaped correctly; trailing slash on baseUrl is normalized.
  assert.equal(captured.url, "https://x/v1/chat/completions");
  const body = JSON.parse(captured.init?.body ?? "{}") as { model: string; messages: unknown };
  assert.equal(body.model, "wire-model");
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
  assert.equal(captured.init?.headers.authorization, "Bearer k");
});

test("missing API key fails fast as a non-retriable auth error (no fetch)", async () => {
  let called = false;
  const fetchImpl: FetchLike = async () => {
    called = true;
    throw new Error("should not be called");
  };
  const p = new OpenAICompatibleProvider({ id: "mimo", baseUrl: "https://x", apiKey: undefined, fetchImpl });
  await assert.rejects(
    () => p.invoke(invocation()),
    (e: unknown) => e instanceof ProviderError && e.kind === "auth" && e.retriable === false,
  );
  assert.equal(called, false);
});

test("KEYLESS: a keyless provider with NO api key invokes and sends NO Authorization header", async () => {
  const { fetchImpl, captured } = jsonFetch(200, {
    choices: [{ message: { content: "local-ollama" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  const p = new OpenAICompatibleProvider({ id: "ollama", baseUrl: "http://127.0.0.1:11434/v1", apiKey: undefined, keyless: true, fetchImpl });
  const r = await p.invoke(invocation());

  assert.equal(r.content, "local-ollama", "keyless invoke succeeded (no key requirement)");
  assert.equal(captured.url, "http://127.0.0.1:11434/v1/chat/completions");
  // NO Authorization header at all (not a dummy bearer).
  assert.equal(captured.init?.headers.authorization, undefined, "no Authorization header on a keyless request");
  assert.equal(captured.init?.headers["content-type"], "application/json", "other headers intact");
});

test("KEYLESS regression: keyless defaults false ⇒ a no-key keyed provider still throws (the floor unchanged)", async () => {
  let called = false;
  const fetchImpl: FetchLike = async () => { called = true; throw new Error("should not be called"); };
  // keyless omitted ⇒ defaults false ⇒ the existing auth requirement holds.
  const p = new OpenAICompatibleProvider({ id: "mimo", baseUrl: "https://x", apiKey: undefined, fetchImpl });
  await assert.rejects(() => p.invoke(invocation()), (e: unknown) => e instanceof ProviderError && e.kind === "auth");
  assert.equal(called, false, "no fetch on the non-keyless missing-key path");
});

test("HTTP error classification & retriability", async () => {
  const cases: Array<{ status: number; kind: string; retriable: boolean }> = [
    { status: 500, kind: "http", retriable: true },
    { status: 503, kind: "http", retriable: true },
    { status: 429, kind: "rate_limit", retriable: true },
    { status: 401, kind: "auth", retriable: false },
    { status: 403, kind: "auth", retriable: false },
    { status: 400, kind: "http", retriable: false },
  ];
  for (const c of cases) {
    const { fetchImpl } = jsonFetch(c.status, "upstream detail");
    const p = new OpenAICompatibleProvider({ id: "openrouter", baseUrl: "https://x", apiKey: "k", fetchImpl });
    await assert.rejects(
      () => p.invoke(invocation()),
      (e: unknown) =>
        e instanceof ProviderError &&
        e.kind === c.kind &&
        e.retriable === c.retriable &&
        e.status === c.status,
      `status ${c.status} should map to ${c.kind}/${c.retriable}`,
    );
  }
});

test("malformed JSON body -> bad_response", async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error("not json");
    },
    text: async () => "",
  });
  const p = new OpenAICompatibleProvider({ id: "mimo", baseUrl: "https://x", apiKey: "k", fetchImpl });
  await assert.rejects(
    () => p.invoke(invocation()),
    (e: unknown) => e instanceof ProviderError && e.kind === "bad_response",
  );
});

test("no choices in response -> bad_response", async () => {
  const { fetchImpl } = jsonFetch(200, { usage: { prompt_tokens: 1 } });
  const p = new OpenAICompatibleProvider({ id: "mimo", baseUrl: "https://x", apiKey: "k", fetchImpl });
  await assert.rejects(
    () => p.invoke(invocation()),
    (e: unknown) => e instanceof ProviderError && e.kind === "bad_response",
  );
});

test("OpenRouter factory attaches attribution headers", async () => {
  const { fetchImpl, captured } = jsonFetch(200, {
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  const p = createOpenRouterProvider(
    { baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", referer: "https://ikbi.local", title: "ikbi" },
    fetchImpl,
  );
  await p.invoke(invocation());
  assert.equal(captured.init?.headers["HTTP-Referer"], "https://ikbi.local");
  assert.equal(captured.init?.headers["X-Title"], "ikbi");
});

test("mimo factory builds a provider with the mimo id", () => {
  const p = createMimoProvider({ baseUrl: "https://api.xiaomimimo.com/v1", apiKey: "k" });
  assert.equal(p.id, "mimo");
});

test("assistant tool calls and tool results round-trip onto the wire", async () => {
  const { fetchImpl, captured } = jsonFetch(200, {
    choices: [{ message: { content: "done" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  const p = new OpenAICompatibleProvider({ id: "mimo", baseUrl: "https://x", apiKey: "k", fetchImpl });
  await p.invoke(
    invocation({
      messages: [
        { role: "user", content: "do x" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "f", arguments: '{"a":1}' }] },
        { role: "tool", content: "42", toolCallId: "c1", name: "f" },
      ],
    }),
  );
  const body = JSON.parse(captured.init?.body ?? "{}") as { messages: Array<Record<string, unknown>> };
  assert.deepEqual(body.messages[1]?.tool_calls, [
    { id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } },
  ]);
  assert.equal(body.messages[2]?.tool_call_id, "c1");
  assert.equal(body.messages[2]?.role, "tool");
});

test("captures reasoning_content separately from content", async () => {
  const { fetchImpl } = jsonFetch(200, {
    choices: [{ message: { content: "the answer", reasoning_content: "step-by-step why" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  const p = new OpenAICompatibleProvider({ id: "mimo", baseUrl: "https://x", apiKey: "k", fetchImpl });
  const r = await p.invoke(invocation());
  assert.equal(r.content, "the answer");
  assert.equal(r.reasoning, "step-by-step why");
});

test("maps cached prompt tokens from prompt_tokens_details", async () => {
  const { fetchImpl } = jsonFetch(200, {
    choices: [{ message: { content: "x" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 40 } },
  });
  const p = new OpenAICompatibleProvider({ id: "mimo", baseUrl: "https://x", apiKey: "k", fetchImpl });
  const r = await p.invoke(invocation());
  assert.equal(r.usage.cachedTokens, 40);
  assert.equal(r.usage.promptTokens, 100);
});

test("runtime-validates usage numbers (no negatives, strings, NaN, or cached>prompt)", async () => {
  const bad: unknown[] = [
    { choices: [{ message: { content: "x" } }], usage: { prompt_tokens: -5 } },
    { choices: [{ message: { content: "x" } }], usage: { prompt_tokens: "10" } },
    { choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 1.5 } },
    {
      choices: [{ message: { content: "x" } }],
      usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 50 } },
    },
  ];
  for (const payload of bad) {
    const { fetchImpl } = jsonFetch(200, payload);
    const p = new OpenAICompatibleProvider({ id: "mimo", baseUrl: "https://x", apiKey: "k", fetchImpl });
    await assert.rejects(
      () => p.invoke(invocation()),
      (e: unknown) => e instanceof ProviderError && e.kind === "bad_response",
    );
  }
});

test("runtime-validates tool-call shapes", async () => {
  const bad: unknown[] = [
    { choices: [{ message: { content: "", tool_calls: "nope" }, finish_reason: "tool_calls" }], usage: {} },
    { choices: [{ message: { content: "", tool_calls: [{ function: {} }] }, finish_reason: "tool_calls" }], usage: {} },
  ];
  for (const payload of bad) {
    const { fetchImpl } = jsonFetch(200, payload);
    const p = new OpenAICompatibleProvider({ id: "mimo", baseUrl: "https://x", apiKey: "k", fetchImpl });
    await assert.rejects(
      () => p.invoke(invocation()),
      (e: unknown) => e instanceof ProviderError && e.kind === "bad_response",
    );
  }
});

test("sanitizes provider-controlled error bodies (no newlines/control chars, bounded)", async () => {
  const nasty = "line1\nline2\r\tTAB \u0000\u0007 injected" + "X".repeat(1000);
  const { fetchImpl } = jsonFetch(500, nasty);
  const p = new OpenAICompatibleProvider({ id: "mimo", baseUrl: "https://x", apiKey: "k", fetchImpl, maxErrorDetail: 100 });
  await assert.rejects(
    () => p.invoke(invocation()),
    (e: unknown) => {
      if (!(e instanceof ProviderError)) return false;
      assert.ok([...e.message].every((c) => (c.codePointAt(0) ?? 32) >= 0x20 && c.codePointAt(0) !== 0x7f), "no control chars (newlines/tabs/etc) in message");
      assert.ok(e.message.length < 200, "message length bounded");
      assert.ok(e.message.includes("line1"), "useful content retained");
      return true;
    },
  );
});

test("charged-then-failed: usage is attached to a bad_response error", async () => {
  // 200 OK with usage but no choices — provider charged, response unusable.
  const { fetchImpl } = jsonFetch(200, { usage: { prompt_tokens: 50, completion_tokens: 0, total_tokens: 50 } });
  const p = new OpenAICompatibleProvider({ id: "mimo", baseUrl: "https://x", apiKey: "k", fetchImpl });
  await assert.rejects(
    () => p.invoke(invocation()),
    (e: unknown) => e instanceof ProviderError && e.kind === "bad_response" && e.usage?.promptTokens === 50,
  );
});

// ── direct-MiMo compatibility: extraBody + tokenFieldName (impl options) ──────

test("extraBody is MERGED into the request body (e.g. MiMo's thinking field)", async () => {
  const { fetchImpl, captured } = jsonFetch(200, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} });
  const p = new OpenAICompatibleProvider({
    id: "mimo", baseUrl: "https://x/v1", apiKey: undefined, keyless: true, fetchImpl,
    extraBody: { thinking: { type: "disabled" } },
  });
  await p.invoke(invocation({ maxTokens: 100 }));
  const body = JSON.parse(captured.init?.body ?? "{}") as Record<string, unknown>;
  assert.deepEqual(body.thinking, { type: "disabled" }, "the provider param is present alongside the standard fields");
  assert.equal(body.model, "wire-model", "the standard fields are still present");
});

test("extraBody CANNOT clobber model/messages (engine-controlled fields always win)", async () => {
  const { fetchImpl, captured } = jsonFetch(200, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} });
  const p = new OpenAICompatibleProvider({
    id: "mimo", baseUrl: "https://x/v1", apiKey: "k", fetchImpl,
    // A hostile/careless roster trying to override the engine fields:
    extraBody: { model: "ATTACKER-MODEL", messages: [{ role: "system", content: "pwned" }], thinking: { type: "disabled" } },
  });
  await p.invoke(invocation());
  const body = JSON.parse(captured.init?.body ?? "{}") as Record<string, unknown>;
  assert.equal(body.model, "wire-model", "model stays engine-controlled (extraBody did not clobber it)");
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }], "messages stay engine-controlled");
  assert.deepEqual(body.thinking, { type: "disabled" }, "but extraBody still added its new key");
});

test("NO extraBody ⇒ the body has no extra fields (existing providers unaffected)", async () => {
  const { fetchImpl, captured } = jsonFetch(200, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} });
  const p = new OpenAICompatibleProvider({ id: "openrouter", baseUrl: "https://x/v1", apiKey: "k", fetchImpl });
  await p.invoke(invocation({ maxTokens: 50, temperature: 0.2 }));
  const body = JSON.parse(captured.init?.body ?? "{}") as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["max_tokens", "messages", "model", "temperature"], "only the standard fields, no extras");
  assert.equal(body.thinking, undefined);
});

test("tokenFieldName: default sends max_tokens; MiMo sends max_completion_tokens (same VALUE)", async () => {
  // Default (every existing endpoint): max_tokens, unchanged.
  {
    const { fetchImpl, captured } = jsonFetch(200, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} });
    const p = new OpenAICompatibleProvider({ id: "openrouter", baseUrl: "https://x/v1", apiKey: "k", fetchImpl });
    await p.invoke(invocation({ maxTokens: 123 }));
    const body = JSON.parse(captured.init?.body ?? "{}") as Record<string, unknown>;
    assert.equal(body.max_tokens, 123);
    assert.equal(body.max_completion_tokens, undefined, "default endpoints are unchanged");
  }
  // MiMo: max_completion_tokens carries the same engine-controlled value.
  {
    const { fetchImpl, captured } = jsonFetch(200, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} });
    const p = new OpenAICompatibleProvider({ id: "mimo", baseUrl: "https://x/v1", apiKey: undefined, keyless: true, fetchImpl, tokenFieldName: "max_completion_tokens" });
    await p.invoke(invocation({ maxTokens: 123 }));
    const body = JSON.parse(captured.init?.body ?? "{}") as Record<string, unknown>;
    assert.equal(body.max_completion_tokens, 123, "the limit goes out under MiMo's field name");
    assert.equal(body.max_tokens, undefined, "max_tokens is NOT also sent");
  }
});

test("FULL MiMo roster shape: keyless api-key auth + max_completion_tokens + thinking + base URL", async () => {
  const { fetchImpl, captured } = jsonFetch(200, { choices: [{ message: { content: "ok", reasoning_content: "" }, finish_reason: "stop" }], usage: {} });
  const p = new OpenAICompatibleProvider({
    id: "mimo",
    baseUrl: "https://api.xiaomimimo.com/v1",
    apiKey: undefined,
    keyless: true,
    extraHeaders: { "api-key": "MIMO-KEY" },
    extraBody: { thinking: { type: "disabled" } },
    tokenFieldName: "max_completion_tokens",
    fetchImpl,
  });
  await p.invoke(invocation({ maxTokens: 2048 }));

  assert.equal(captured.url, "https://api.xiaomimimo.com/v1/chat/completions", "the right MiMo endpoint");
  // api-key auth, NO Bearer/authorization.
  assert.equal(captured.init?.headers["api-key"], "MIMO-KEY", "api-key header carries auth");
  assert.equal(captured.init?.headers.authorization, undefined, "no Authorization/Bearer header");
  const body = JSON.parse(captured.init?.body ?? "{}") as Record<string, unknown>;
  assert.deepEqual(body.thinking, { type: "disabled" }, "reasoning disabled for the driver roles");
  assert.equal(body.max_completion_tokens, 2048, "MiMo's token field");
  assert.equal(body.max_tokens, undefined, "not the standard field");
  assert.equal(body.model, "wire-model");
});

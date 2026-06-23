import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyError, translateError, formatFriendlyError } from "./translator.js";

// Minimal stand-ins for the typed provider errors (duck-typed by name + shape), so this
// test does not construct the provider singleton.
class FakeProviderError extends Error {
  readonly kind: string;
  readonly provider: string;
  constructor(message: string, kind: string, provider = "anthropic") {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.provider = provider;
  }
}
class FakeAllFailed extends Error {
  readonly attempts: ReadonlyArray<{ outcome: string; provider: string }>;
  constructor(attempts: ReadonlyArray<{ outcome: string; provider: string }>) {
    super(`All providers failed: ${attempts.map((a) => `${a.provider}=${a.outcome}`).join(", ")}`);
    this.name = "AllProvidersFailedError";
    this.attempts = attempts;
  }
}
class FakeModelNotFound extends Error {
  readonly model: string;
  constructor(model: string) {
    super(`Model "${model}" is not in the roster.`);
    this.name = "ModelNotFoundError";
    this.model = model;
  }
}

test("ProviderError kinds map to the right category", () => {
  assert.equal(classifyError(new FakeProviderError("slow", "timeout")), "model_timeout");
  assert.equal(classifyError(new FakeProviderError("nope", "auth")), "api_key_missing");
  assert.equal(classifyError(new FakeProviderError("down", "network")), "network");
  assert.equal(classifyError(new FakeProviderError("slow down", "rate_limit")), "rate_limit");
});

test("AllProvidersFailedError reads per-route outcomes — circuit open wins", () => {
  const err = new FakeAllFailed([
    { provider: "anthropic", outcome: "skipped_open_circuit" },
    { provider: "openrouter", outcome: "error" },
  ]);
  assert.equal(classifyError(err), "circuit_open");
});

test("AllProvidersFailedError with only auth failures → api key missing", () => {
  const err = new FakeAllFailed([{ provider: "anthropic", outcome: "auth" }]);
  assert.equal(classifyError(err), "api_key_missing");
});

test("ModelNotFoundError → model_not_found", () => {
  assert.equal(classifyError(new FakeModelNotFound("gpt-9")), "model_not_found");
});

test("context overflow is detected from the message", () => {
  assert.equal(classifyError(new Error("This model's maximum context length is 8192 tokens")), "context_overflow");
  assert.equal(classifyError(new Error("prompt is too long for the context window")), "context_overflow");
});

test("tool failure is detected from opts.tool and the loop's ERROR prefix", () => {
  assert.equal(classifyError(new Error("boom"), { tool: "terminal" }), "tool_failure");
  assert.equal(classifyError(new Error('ERROR: tool "patch" failed: bad hunk')), "tool_failure");
});

test("untyped message heuristics catch timeout / network / rate-limit / api-key", () => {
  assert.equal(classifyError(new Error("Request timed out after 60s")), "model_timeout");
  assert.equal(classifyError(new Error("getaddrinfo ENOTFOUND api.example.com")), "network");
  assert.equal(classifyError(new Error("429 Too Many Requests")), "rate_limit");
  assert.equal(classifyError(new Error("401 invalid api key")), "api_key_missing");
});

test("unknown errors fall through to the generic category", () => {
  assert.equal(classifyError(new Error("kaboom")), "unknown");
  assert.equal(classifyError("a bare string"), "unknown");
  assert.equal(classifyError(42), "unknown");
});

test("translateError fills message + suggestion + technical for each category", () => {
  const t = translateError(new FakeProviderError("slow", "timeout"));
  assert.equal(t.category, "model_timeout");
  assert.match(t.message, /took too long/i);
  assert.match(t.suggestion, /models --recommend/);
  assert.equal(t.technical, "slow");
});

test("api-key message names the provider and its IKBI_ env var", () => {
  const t = translateError(new FakeProviderError("nope", "auth", "deepseek"));
  assert.match(t.message, /deepseek/);
  assert.match(t.suggestion, /IKBI_DEEPSEEK_API_KEY/);
  assert.match(t.suggestion, /ikbi init/);
});

test("model-not-found names the model when provided in opts", () => {
  const t = translateError(new FakeModelNotFound("gpt-9"), { model: "gpt-9" });
  assert.match(t.message, /gpt-9/);
  assert.match(t.suggestion, /models --recommend/);
});

test("tool failure gives a tool-specific suggestion", () => {
  assert.match(translateError(new Error("x"), { tool: "terminal" }).suggestion, /command|policy|permission/i);
  assert.match(translateError(new Error("x"), { tool: "run_checks" }).suggestion, /doctor --fix/);
});

test("formatFriendlyError hides the technical detail unless verbose", () => {
  const fe = translateError(new Error("raw internal detail"), { tool: "terminal" });
  const quiet = formatFriendlyError(fe);
  assert.ok(!quiet.includes("raw internal detail"), "technical detail hidden by default");
  assert.match(quiet, /→/);
  const loud = formatFriendlyError(fe, { verbose: true, stack: "at foo (x.ts:1)" });
  assert.match(loud, /raw internal detail/);
  assert.match(loud, /at foo/);
});

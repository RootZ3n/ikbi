import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import { cacheKey, createModelCache, type CacheConfig } from "./index.js";

// --- fixtures ---------------------------------------------------------------

function req(overrides?: Partial<ModelRequest>): ModelRequest {
  return {
    model: "mimo-v2.5",
    messages: [{ role: "user", content: "hello" }],
    temperature: 0.2,
    maxTokens: 256,
    identity: { agentId: "agent-a" },
    ...overrides,
  };
}

function resp(content = "hi"): ModelResponse {
  return {
    contractVersion: "1.1.0",
    model: "mimo-v2.5",
    provider: "mimo",
    providerModelId: "mimo-v2.5",
    content,
    finishReason: "stop",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 5,
    fellBack: false,
    attempts: [],
  };
}

const ON: CacheConfig = { enabled: true, ttlMs: 1000 };
const OFF: CacheConfig = { enabled: false, ttlMs: 1000 };

/** A `next` that returns a fixed response and counts its calls. */
function countingNext(r: ModelResponse = resp()) {
  let calls = 0;
  const next = async (): Promise<ModelResponse> => {
    calls += 1;
    return r;
  };
  return { next, calls: () => calls };
}

// --- key determinism --------------------------------------------------------

test("cacheKey is deterministic for identical content", () => {
  assert.equal(cacheKey(req()), cacheKey(req()));
});

test("cacheKey changes when keyed content changes", () => {
  const base = cacheKey(req());
  assert.notEqual(base, cacheKey(req({ model: "other" })), "model");
  assert.notEqual(base, cacheKey(req({ messages: [{ role: "user", content: "different" }] })), "messages");
  assert.notEqual(base, cacheKey(req({ temperature: 0.9 })), "temperature");
  assert.notEqual(base, cacheKey(req({ maxTokens: 999 })), "maxTokens");
  assert.notEqual(
    base,
    cacheKey(req({ tools: [{ name: "f", description: "d", parameters: {} }] })),
    "tools-presence",
  );
});

test("the prompt form and the equivalent messages form key the same", () => {
  const id = { agentId: "agent-a" };
  const viaMessages = cacheKey({ model: "mimo-v2.5", messages: [{ role: "user", content: "hello" }], identity: id });
  const viaPrompt = cacheKey({ model: "mimo-v2.5", prompt: "hello", identity: id });
  assert.equal(viaMessages, viaPrompt);
});

test("identity and metadata are EXCLUDED from the key (caller-specific, not content)", () => {
  const base = cacheKey(req());
  assert.equal(
    base,
    cacheKey(req({ identity: { agentId: "totally-different", trustTier: "operator", sessionId: "s9" } })),
    "identity excluded",
  );
  assert.equal(base, cacheKey(req({ metadata: { trace: "xyz" } })), "metadata excluded");
  assert.equal(base, cacheKey(req({ timeoutMs: 12345, contractVersion: "1.1.0" })), "timeout/version excluded");
});

// --- hit / miss -------------------------------------------------------------

test("miss falls through to the invoker exactly once", async () => {
  const cache = createModelCache({ config: ON });
  const { next, calls } = countingNext();
  const out = await cache.wrap(req(), next);
  assert.equal(out.content, "hi");
  assert.equal(calls(), 1, "invoker called once on a miss");
  assert.equal(cache.size(), 1, "response stored");
});

test("hit returns the stored response WITHOUT calling the invoker", async () => {
  const cache = createModelCache({ config: ON });
  const first = countingNext(resp("first"));
  await cache.wrap(req(), first.next); // miss → store

  const second = countingNext(resp("SHOULD-NOT-BE-RETURNED"));
  const out = await cache.wrap(req(), second.next); // hit
  assert.equal(out.content, "first", "served from cache");
  assert.equal(second.calls(), 0, "invoker NOT called on a hit");
});

// --- store-on-success-only --------------------------------------------------

test("a failing invocation is NOT stored (errors / denials never cached)", async () => {
  const cache = createModelCache({ config: ON });
  const boom = async (): Promise<ModelResponse> => {
    throw new Error("AllProvidersFailed / egress denied / timeout");
  };
  await assert.rejects(() => cache.wrap(req(), boom));
  assert.equal(cache.size(), 0, "nothing cached after a failure");

  // The next attempt must re-invoke (not be served a poisoned entry).
  const { next, calls } = countingNext(resp("recovered"));
  const out = await cache.wrap(req(), next);
  assert.equal(out.content, "recovered");
  assert.equal(calls(), 1, "re-invoked after the prior failure");
});

// --- TTL --------------------------------------------------------------------

test("an entry expires after the TTL and triggers a re-fetch", async () => {
  let clock = 1000;
  const cache = createModelCache({ config: { enabled: true, ttlMs: 500 }, now: () => clock });

  const first = countingNext(resp("v1"));
  await cache.wrap(req(), first.next); // stored, expiresAt = 1500

  clock = 1499;
  const stillFresh = countingNext(resp("v2"));
  assert.equal((await cache.wrap(req(), stillFresh.next)).content, "v1", "served before expiry");
  assert.equal(stillFresh.calls(), 0);

  clock = 1500; // expiresAt <= now ⇒ expired
  const afterExpiry = countingNext(resp("v2"));
  assert.equal((await cache.wrap(req(), afterExpiry.next)).content, "v2", "re-fetched after expiry");
  assert.equal(afterExpiry.calls(), 1);
});

// --- disabled passthrough ---------------------------------------------------

test("disabled config is a pure passthrough (never stores, always invokes)", async () => {
  const cache = createModelCache({ config: OFF });
  const a = countingNext(resp("a"));
  await cache.wrap(req(), a.next);
  const b = countingNext(resp("b"));
  const out = await cache.wrap(req(), b.next);

  assert.equal(out.content, "b", "second call NOT served from cache");
  assert.equal(a.calls(), 1);
  assert.equal(b.calls(), 1, "invoker called every time when disabled");
  assert.equal(cache.size(), 0, "nothing stored when disabled");
});

// --- events -----------------------------------------------------------------

test("hit / miss / store publish namespaced cache.* events", async () => {
  const seen: string[] = [];
  const cache = createModelCache({ config: ON, publish: (e) => seen.push(e.type) });
  await cache.wrap(req(), countingNext().next); // miss + store
  await cache.wrap(req(), countingNext().next); // hit
  assert.deepEqual(seen, ["cache.miss", "cache.store", "cache.hit"]);
});

// --- M1: vision content keys distinctly even when the flattened text is identical ----------
test("M1: two vision turns with identical text but different images key distinctly (no collision)", () => {
  const textOnly = cacheKey(req({ messages: [{ role: "user", content: "describe this" }] }));
  const withImgA = cacheKey(req({ messages: [{ role: "user", content: "describe this", parts: [{ type: "text", text: "describe this" }, { type: "image_url", image_url: { url: "https://x/a.png" } }] }] }));
  const withImgB = cacheKey(req({ messages: [{ role: "user", content: "describe this", parts: [{ type: "text", text: "describe this" }, { type: "image_url", image_url: { url: "https://x/b.png" } }] }] }));
  // different images ⇒ different keys (the bug: B would otherwise be served A's answer)
  assert.notEqual(withImgA, withImgB, "distinct images key distinctly");
  // an image turn never collides with the text-only turn that shares its flattened text
  assert.notEqual(textOnly, withImgA, "image turn differs from the bare-text turn");
});

test("M1: a text-only `parts` array does not change the key (equivalent to plain content)", () => {
  const plain = cacheKey(req({ messages: [{ role: "user", content: "hi" }] }));
  const textParts = cacheKey(req({ messages: [{ role: "user", content: "hi", parts: [{ type: "text", text: "hi" }] }] }));
  assert.equal(plain, textParts, "text-only parts carry no image content → no key change");
});

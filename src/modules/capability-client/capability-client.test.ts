import assert from "node:assert/strict";
import { test } from "node:test";

import type { EventInput } from "../../core/events/index.js";
import { createCapabilityClient, type FetchLike } from "./client.js";
import type { CapabilityClientConfig } from "./config.js";
import type { CapabilityEventPayload } from "./events.js";

const cfg = (over: Partial<CapabilityClientConfig> = {}): CapabilityClientConfig => ({
  enabled: true,
  url: "http://ledger.test/api/nous/capability-scores",
  ttlMs: 1_000,
  timeoutMs: 100,
  minConfidence: 0.5,
  minSamples: 3,
  ...over,
});

function score(modelId: string, category: string, s: number, over: Record<string, unknown> = {}) {
  return { modelId, category, score: s, confidence: 0.9, sampleCount: 10, evidenceSources: ["arena"], ...over };
}

/** A fetch fake returning a fixed body; records each URL it was called with. */
function okFetch(body: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const calls: string[] = [];
  const fn: FetchLike = async (url) => {
    calls.push(url);
    return { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => body };
  };
  return { fn, calls };
}

/** A fetch fake that always rejects (ledger down). */
function downFetch() {
  const calls: string[] = [];
  const fn: FetchLike = async (url) => {
    calls.push(url);
    throw new Error("ECONNREFUSED");
  };
  return { fn, calls };
}

function clock(start = 0) {
  const box = { v: start };
  return { now: () => box.v, advance: (ms: number) => (box.v += ms) };
}

function captureEvents() {
  const sent: Array<EventInput<CapabilityEventPayload>> = [];
  return { publish: (e: EventInput<CapabilityEventPayload>) => void sent.push(e), sent, types: () => sent.map((e) => e.type) };
}

const envelope = (...scores: unknown[]) => ({ ok: true, count: scores.length, scores });

// ── fetch + cache ────────────────────────────────────────────────────────────

test("fetches scores once and serves subsequent reads from the TTL cache", async () => {
  const f = okFetch(envelope(score("deepseek-v4-pro", "code_patch", 0.8), score("mimo-v2.5", "code_patch", 0.6)));
  const c = createCapabilityClient({ config: cfg(), fetchImpl: f.fn, now: clock().now, publish: () => {} });

  const first = await c.getScoresForModel("deepseek-v4-pro");
  const second = await c.getBestModelForCategory("code_patch");

  assert.equal(f.calls.length, 1, "two reads within the TTL → exactly ONE fetch");
  assert.equal(first.length, 1);
  assert.equal(first[0]?.modelId, "deepseek-v4-pro");
  assert.equal(second?.modelId, "deepseek-v4-pro", "best for code_patch is the higher score (0.8)");
});

test("re-fetches after the TTL expires", async () => {
  const f = okFetch(envelope(score("mimo-v2.5", "tool_calling", 0.7)));
  const ck = clock();
  const c = createCapabilityClient({ config: cfg({ ttlMs: 1_000 }), fetchImpl: f.fn, now: ck.now, publish: () => {} });

  await c.getBestModelForCategory("tool_calling");
  ck.advance(999);
  await c.getBestModelForCategory("tool_calling");
  assert.equal(f.calls.length, 1, "still within TTL → no re-fetch");
  ck.advance(2);
  await c.getBestModelForCategory("tool_calling");
  assert.equal(f.calls.length, 2, "past TTL → re-fetch");
});

test("getBestModelForCategory returns the highest-scoring model and null for an unknown category", async () => {
  const f = okFetch(
    envelope(
      score("a", "code_patch", 0.4),
      score("b", "code_patch", 0.91),
      score("c", "code_patch", 0.7),
    ),
  );
  const c = createCapabilityClient({ config: cfg(), fetchImpl: f.fn, now: clock().now, publish: () => {} });

  assert.equal((await c.getBestModelForCategory("code_patch"))?.modelId, "b");
  assert.equal(await c.getBestModelForCategory("no_such_category"), null);
});

// ── graceful when down ───────────────────────────────────────────────────────

test("ledger down → getBestModelForCategory null, getScoresForModel empty (graceful fallback)", async () => {
  const f = downFetch();
  const c = createCapabilityClient({ config: cfg(), fetchImpl: f.fn, now: clock().now, publish: () => {} });

  assert.equal(await c.getBestModelForCategory("code_patch"), null);
  assert.deepEqual(await c.getScoresForModel("mimo-v2.5"), []);
});

test("a down ledger is negative-cached — not re-hit on every call within the TTL", async () => {
  const f = downFetch();
  const c = createCapabilityClient({ config: cfg({ ttlMs: 10_000 }), fetchImpl: f.fn, now: clock().now, publish: () => {} });

  await c.getBestModelForCategory("code_patch");
  await c.getBestModelForCategory("tool_calling");
  await c.getScoresForModel("mimo-v2.5");
  assert.equal(f.calls.length, 1, "negative cache prevents hammering a down ledger");
});

test("serves the prior successful cache if a later refresh fails", async () => {
  let body: unknown = envelope(score("mimo-v2.5", "code_patch", 0.8));
  let fail = false;
  const calls: string[] = [];
  const fn: FetchLike = async (url) => {
    calls.push(url);
    if (fail) throw new Error("ECONNREFUSED");
    return { ok: true, status: 200, json: async () => body };
  };
  const ck = clock();
  const c = createCapabilityClient({ config: cfg({ ttlMs: 1_000 }), fetchImpl: fn, now: ck.now, publish: () => {} });

  assert.equal((await c.getBestModelForCategory("code_patch"))?.modelId, "mimo-v2.5");
  fail = true;
  ck.advance(2_000); // force a refresh, which now fails
  assert.equal((await c.getBestModelForCategory("code_patch"))?.modelId, "mimo-v2.5", "stale success is served");
});

// ── disabled + bad responses ─────────────────────────────────────────────────

test("disabled config never fetches and always returns empty/null", async () => {
  const f = okFetch(envelope(score("mimo-v2.5", "code_patch", 0.8)));
  const c = createCapabilityClient({ config: cfg({ enabled: false }), fetchImpl: f.fn, now: clock().now, publish: () => {} });

  assert.equal(await c.getBestModelForCategory("code_patch"), null);
  assert.deepEqual(await c.getScoresForModel("mimo-v2.5"), []);
  assert.equal(f.calls.length, 0, "disabled → no network call at all");
});

test("a non-OK HTTP status degrades gracefully (null)", async () => {
  const f = okFetch({}, { ok: false, status: 503 });
  const c = createCapabilityClient({ config: cfg(), fetchImpl: f.fn, now: clock().now, publish: () => {} });
  assert.equal(await c.getBestModelForCategory("code_patch"), null);
});

test("malformed entries are skipped; valid ones are kept", async () => {
  const f = okFetch(
    envelope(
      { category: "code_patch", score: 0.9 }, // no modelId → dropped
      { modelId: "x", score: 0.9 }, // no category → dropped
      { modelId: "y", category: "code_patch", score: "high" }, // non-numeric score → dropped
      score("good", "code_patch", 0.5, { confidence: undefined, sampleCount: undefined, evidenceSources: undefined }),
    ),
  );
  const c = createCapabilityClient({ config: cfg(), fetchImpl: f.fn, now: clock().now, publish: () => {} });
  const best = await c.getBestModelForCategory("code_patch");
  assert.equal(best?.modelId, "good");
  assert.equal(best?.confidence, 0, "missing confidence defaults to 0");
  assert.equal(best?.sampleCount, 0, "missing sampleCount defaults to 0");
  assert.deepEqual(best?.evidenceSources, []);
});

test("accepts a bare array response (no envelope)", async () => {
  const f = okFetch([score("mimo-v2.5", "latency", 0.95)]);
  const c = createCapabilityClient({ config: cfg(), fetchImpl: f.fn, now: clock().now, publish: () => {} });
  assert.equal((await c.getBestModelForCategory("latency"))?.modelId, "mimo-v2.5");
});

// ── events ───────────────────────────────────────────────────────────────────

test("emits capability.fetched on success and capability.unavailable when down", async () => {
  const okEv = captureEvents();
  const okC = createCapabilityClient({ config: cfg(), fetchImpl: okFetch(envelope(score("m", "code_patch", 0.8))).fn, now: clock().now, publish: okEv.publish });
  await okC.getBestModelForCategory("code_patch");
  assert.ok(okEv.types().includes("capability.fetched"));
  assert.equal(okEv.sent[0]?.source, "capability-client");
  assert.equal(okEv.sent[0]?.payload.scoreCount, 1);

  const downEv = captureEvents();
  const downC = createCapabilityClient({ config: cfg(), fetchImpl: downFetch().fn, now: clock().now, publish: downEv.publish });
  await downC.getBestModelForCategory("code_patch");
  assert.ok(downEv.types().includes("capability.unavailable"));
});

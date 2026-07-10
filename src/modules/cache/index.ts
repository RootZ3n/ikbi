/**
 * ikbi caching floor — content-addressed, store-on-success, in-memory.
 *
 * Wraps the `invokeModel` entry seam (provider/index.ts) ABOVE the invoker loop
 * and the egress guard. A cache hit returns a previously-stored `ModelResponse`
 * with NO network call; a miss falls through to the unchanged invoker path and,
 * ONLY on a fully successful response, stores the result.
 *
 * STORE-ON-SUCCESS-ONLY (the stale-authorization defense): the store happens
 * AFTER `next()` resolves. Any rejection — AllProvidersFailedError, timeout,
 * guard-denied/network-failed attempt — propagates BEFORE the store line is
 * reached, so a denied host can never become a cache entry.
 *
 * KEY = sha256(model + messages + temperature + maxTokens + FULL tool defs). The tool DEFINITIONS
 * (names + descriptions + parameter schemas) are in the key, not just tools-presence (H7) — the model's
 * behavior depends on its full toolset, so keying on a presence boolean would poison across differing
 * toolsets. Identity and metadata are EXCLUDED — caller-specific, not content-specific — so two agents
 * issuing the same content share an entry (authorization is enforced downstream at call time regardless).
 *
 * In-memory: `Map<key, { response, expiresAt }>` used as an LRU with a hard entry cap (H7 memory bound)
 * + TTL, plus an in-flight map so concurrent identical misses COALESCE onto one model call (H7 stampede
 * guard). No persistence / substrate.
 */

import { createHash } from "node:crypto";

import { events as defaultBus } from "../../core/events/index.js";
import type { EventInput } from "../../core/events/index.js";
import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import { registerModelInvokeWrapper } from "../../core/provider/invoke-wrapper.js";
import { cacheConfig, type CacheConfig } from "./config.js";
import { cacheHit, cacheMiss, cacheStore, type CacheEventPayload } from "./events.js";

/** One stored entry: the response plus its absolute expiry (ms epoch). */
interface CacheEntry {
  readonly response: ModelResponse;
  readonly expiresAt: number;
}

/** Injectable dependencies (tests substitute config / clock / publish). */
export interface ModelCacheDeps {
  /** Config slice. Defaults to the process-wide `cacheConfig`. */
  readonly config?: CacheConfig;
  /** Clock (ms epoch). Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Event sink. Defaults to the process event bus. */
  readonly publish?: (input: EventInput<CacheEventPayload>) => void;
}

/** A model invocation to defer to on a miss (the existing invoker path). */
export type InvokeNext = () => Promise<ModelResponse>;

/** Canonical, content-only projection of a request's messages (order preserved). */
function normalizeMessages(request: ModelRequest): Array<Record<string, unknown>> {
  const msgs =
    request.messages ?? (request.prompt !== undefined ? [{ role: "user", content: request.prompt }] : []);
  // Fixed field order ⇒ deterministic JSON. Only content-bearing fields; the
  // `untrusted` isolation flag does not change what the model sees, so it is excluded.
  return msgs.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.name !== undefined ? { name: m.name } : {}),
    ...(m.toolCallId !== undefined ? { toolCallId: m.toolCallId } : {}),
    ...(m.toolCalls !== undefined
      ? { toolCalls: m.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })) }
      : {}),
    // M1: vision turns carry images in `parts`, NOT in `content` (the flattened-text fallback).
    // Two turns with identical text but DIFFERENT images would otherwise collide on `content`
    // alone — the second served the first image's answer. Fold a hash of `parts` into the key
    // whenever they carry non-text (image) content so distinct images key distinctly.
    ...(m.parts !== undefined && m.parts.some((p) => p.type !== "text")
      ? { partsHash: createHash("sha256").update(JSON.stringify(m.parts)).digest("hex") }
      : {}),
  }));
}

/**
 * Canonical projection of the tool DEFINITIONS a request exposes to the model. H7: keying on tools
 * PRESENCE alone (a boolean) is a cache-poisoning bug — two requests with identical messages but
 * DIFFERENT tools (or different tool SCHEMAS) would collide, so the second is served a response the
 * model produced under a different toolset. The model's behavior depends on the full tool surface
 * (names + descriptions + parameter schemas), so the full surface must be in the key. Order-preserved
 * (tool order can itself steer the model). `undefined`/empty ⇒ null (distinct from "has tools").
 */
function normalizeTools(request: ModelRequest): unknown {
  if (request.tools === undefined || request.tools.length === 0) return null;
  return request.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

/**
 * Compute the content-addressed cache key. Covers the full MODEL-VISIBLE request — messages, sampling
 * params, AND the tool definitions (H7). EXCLUDES identity, metadata, contractVersion and timeoutMs
 * (caller/transport-specific, not content). Note: what a model MAY do is governed downstream (egress /
 * gate-wall) at call time regardless of a cache hit, so identity-policy divergence cannot ride a shared
 * content-addressed entry into an unauthorized effect — the key stays content-only by design.
 */
export function cacheKey(request: ModelRequest): string {
  const canonical = {
    model: request.model,
    messages: normalizeMessages(request),
    temperature: request.temperature ?? null,
    maxTokens: request.maxTokens ?? null,
    // FULL tool definitions (names + descriptions + parameter schemas), not just presence.
    tools: normalizeTools(request),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** A model-response cache instance. The default singleton wires config + the bus. */
export function createModelCache(deps: ModelCacheDeps = {}) {
  const config = deps.config ?? cacheConfig;
  const now = deps.now ?? Date.now;
  const publish = deps.publish ?? ((input: EventInput<CacheEventPayload>) => void defaultBus.publish(input));
  // Insertion-ordered Map used as an LRU: a lookup HIT re-inserts the key (moves it to the newest
  // position), and put() evicts from the OLDEST end when over the cap (H7 memory bound).
  const store = new Map<string, CacheEntry>();
  // H7 STAMPEDE GUARD: concurrent identical MISSES share ONE in-flight `next()` rather than each
  // firing an (expensive, network) model call. Keyed by cacheKey; cleared when the call settles.
  const inflight = new Map<string, Promise<ModelResponse>>();

  /** Look up a live (non-expired) entry. Expired entries are evicted on access; a hit refreshes LRU. */
  function lookup(key: string): ModelResponse | undefined {
    const entry = store.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now()) {
      store.delete(key);
      return undefined;
    }
    // LRU: re-insert so this key becomes the most-recently-used (last in iteration order).
    store.delete(key);
    store.set(key, entry);
    return entry.response;
  }

  /** Store a response under `key` with the configured TTL. TTL `0` ⇒ no storage. Enforces the LRU cap. */
  function put(key: string, response: ModelResponse): void {
    if (config.ttlMs <= 0) return;
    store.delete(key); // ensure re-insert lands at the newest position (in case it already existed)
    store.set(key, { response, expiresAt: now() + config.ttlMs });
    // H7 SIZE BOUND: evict least-recently-used (oldest insertion) entries until within the cap.
    if (config.maxEntries > 0) {
      while (store.size > config.maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    }
  }

  /**
   * Wrap a model invocation: hit → stored response (no `next`); miss → `next()`,
   * and on SUCCESS only, store. A throwing `next` propagates without storing. Concurrent identical
   * misses are COALESCED onto a single `next()` (stampede guard) and every waiter gets its result —
   * or its rejection, in which case nothing is stored (the store-on-success invariant is preserved).
   */
  async function wrap(request: ModelRequest, next: InvokeNext): Promise<ModelResponse> {
    if (!config.enabled) return next(); // opt-out-safe: exact passthrough

    const key = cacheKey(request);
    const hit = lookup(key);
    if (hit !== undefined) {
      publish(cacheHit.create({ key, model: request.model }, { source: "cache" }));
      return hit;
    }
    publish(cacheMiss.create({ key, model: request.model }, { source: "cache" }));

    // STAMPEDE GUARD: if an identical request is already in flight, await ITS result instead of
    // issuing a second model call. The follower does not re-store (the leader stores on success).
    const pending = inflight.get(key);
    if (pending !== undefined) return pending;

    // Store-on-success-only: a rejection propagates BEFORE the store, and the inflight entry is
    // cleared in `finally` so a failed call never wedges the key.
    const call = (async () => {
      const response = await next();
      put(key, response);
      publish(cacheStore.create({ key, model: request.model }, { source: "cache" }));
      return response;
    })();
    inflight.set(key, call);
    try {
      return await call;
    } finally {
      inflight.delete(key);
    }
  }

  return {
    wrap,
    lookup,
    put,
    cacheKey,
    /** Clear all entries (test/maintenance). */
    clear: (): void => store.clear(),
    /** Current entry count. */
    size: (): number => store.size,
  };
}

/** The process-wide model-response cache. */
export const modelCache = createModelCache();

/**
 * The wrap bound to the default cache — what `provider/index.ts` calls at the
 * `invokeModel` seam. `next` is the existing `invoker.invokeModel(request)` path.
 */
export function cachedInvoke(request: ModelRequest, next: InvokeNext): Promise<ModelResponse> {
  return modelCache.wrap(request, next);
}

registerModelInvokeWrapper(cachedInvoke);

export { cacheConfig, loadCacheConfig, DEFAULT_TTL_MS, type CacheConfig } from "./config.js";
export { cacheHit, cacheMiss, cacheStore, type CacheEventPayload } from "./events.js";

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
 * KEY = sha256(model + messages + temperature + maxTokens + tools-presence).
 * Identity and metadata are EXCLUDED — they are caller-specific, not
 * content-specific, so two agents issuing the same content share an entry.
 *
 * In-memory only this pass: `Map<key, { response, expiresAt }>` + TTL. No
 * persistence / substrate.
 */

import { createHash } from "node:crypto";

import { events as defaultBus } from "../../core/events/index.js";
import type { EventInput } from "../../core/events/index.js";
import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
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
 * Compute the content-addressed cache key. EXCLUDES identity, metadata,
 * contractVersion and timeoutMs (caller/transport-specific, not content).
 */
export function cacheKey(request: ModelRequest): string {
  const canonical = {
    model: request.model,
    messages: normalizeMessages(request),
    temperature: request.temperature ?? null,
    maxTokens: request.maxTokens ?? null,
    // tools-presence only (per the key spec): whether the request carried tools.
    toolsPresent: request.tools !== undefined && request.tools.length > 0,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** A model-response cache instance. The default singleton wires config + the bus. */
export function createModelCache(deps: ModelCacheDeps = {}) {
  const config = deps.config ?? cacheConfig;
  const now = deps.now ?? Date.now;
  const publish = deps.publish ?? ((input: EventInput<CacheEventPayload>) => void defaultBus.publish(input));
  const store = new Map<string, CacheEntry>();

  /** Look up a live (non-expired) entry. Expired entries are evicted on access. */
  function lookup(key: string): ModelResponse | undefined {
    const entry = store.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now()) {
      store.delete(key);
      return undefined;
    }
    return entry.response;
  }

  /** Store a response under `key` with the configured TTL. TTL `0` ⇒ no storage. */
  function put(key: string, response: ModelResponse): void {
    if (config.ttlMs <= 0) return;
    store.set(key, { response, expiresAt: now() + config.ttlMs });
  }

  /**
   * Wrap a model invocation: hit → stored response (no `next`); miss → `next()`,
   * and on SUCCESS only, store. A throwing `next` propagates without storing.
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

    // Store-on-success-only: a rejection here propagates BEFORE the store below.
    const response = await next();
    put(key, response);
    publish(cacheStore.create({ key, model: request.model }, { source: "cache" }));
    return response;
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

export { cacheConfig, loadCacheConfig, DEFAULT_TTL_MS, type CacheConfig } from "./config.js";
export { cacheHit, cacheMiss, cacheStore, type CacheEventPayload } from "./events.js";

/**
 * ikbi caching floor — its events (namespaced `cache.*` per module plan ## 8).
 *
 * Published on the existing event bus so monitoring / the operator stream sees
 * cache behavior live. Transient signals, not the durable record.
 */

import { defineEvent } from "../../core/events/index.js";

/** Common payload for the cache lifecycle events. */
export interface CacheEventPayload {
  /** The content-addressed cache key (sha256 hex of the keyed request fields). */
  readonly key: string;
  /** Logical model id the request targeted. */
  readonly model: string;
}

/** A keyed request was served from cache (no network call). */
export const cacheHit = defineEvent<CacheEventPayload>("cache.hit");

/** A keyed request was not in cache (falls through to the invoker). */
export const cacheMiss = defineEvent<CacheEventPayload>("cache.miss");

/** A successful response was written to cache. */
export const cacheStore = defineEvent<CacheEventPayload>("cache.store");

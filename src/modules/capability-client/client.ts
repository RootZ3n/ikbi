/**
 * ikbi capability-client — the HTTP client + in-memory TTL cache.
 *
 * Talks to the lab Capability Ledger (ittunaha `GET /api/nous/capability-scores`)
 * over plain HTTP and caches the full score set with a TTL so routing never hammers
 * the API. Every accessor is GRACEFUL: when the ledger is disabled, unreachable, slow
 * (timeout), or returns a malformed body, the client serves a prior cache if it has
 * one and otherwise returns empty/null — the caller falls back to static config.
 *
 * It uses plain `fetch` (NOT the egress fetch-guard): the ledger is internal lab infra
 * on loopback (default `http://localhost:18783`, enabled by default), which the SSRF
 * guard blocks BY DESIGN. This path is read-only, talks to a SINGLE endpoint, and carries
 * no model/web egress. The SSRF guard's job is to stop a MODEL-chosen (untrusted) URL from
 * reaching internal space — it is the wrong tool here, where the URL is OPERATOR config
 * reaching out to known internal infra; routing this through the guard would break the
 * default loopback setup. Residual: `IKBI_CAPABILITY_LEDGER_URL` is operator-controlled,
 * so an operator who points it at a public host gets an un-allowlisted plain-HTTP call —
 * a trust-the-operator boundary, not a model-exposed one. The feature degrades gracefully
 * (falls back to static config) on any failure, so this is bounded and fail-safe.
 */

import { childLogger } from "../../core/log.js";
import { events as coreEvents } from "../../core/events/index.js";
import type { EventInput } from "../../core/events/index.js";
import { capabilityClientConfig, type CapabilityClientConfig } from "./config.js";
import { capabilityFetched, capabilityUnavailable, type CapabilityEventPayload } from "./events.js";
import type { CapabilityClient, CapabilityScore } from "./contract.js";

const log = childLogger("capability-client");
const EVENT_SOURCE = "capability-client";

/** A minimal `fetch`-like surface (injectable for tests). */
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

/** Injectable dependencies (tests substitute config / fetch / clock / publish). */
export interface CapabilityClientDeps {
  readonly config?: CapabilityClientConfig;
  /** HTTP client. Default: the global `fetch`. */
  readonly fetchImpl?: FetchLike;
  /** Monotonic-ish clock in ms. Default: `Date.now`. */
  readonly now?: () => number;
  readonly publish?: (input: EventInput<CapabilityEventPayload>) => void;
}

interface CacheEntry {
  readonly scores: readonly CapabilityScore[];
  readonly fetchedAt: number;
}

/**
 * Defensively parse one raw ledger entry into a `CapabilityScore`. Returns null when
 * the required fields (modelId, category, numeric score) are missing/ill-typed, so a
 * partially-malformed response yields the entries it CAN, never a throw.
 */
function parseScore(raw: unknown): CapabilityScore | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const modelId = typeof r.modelId === "string" ? r.modelId : undefined;
  const category = typeof r.category === "string" ? r.category : undefined;
  const score = typeof r.score === "number" && Number.isFinite(r.score) ? r.score : undefined;
  if (modelId === undefined || category === undefined || score === undefined) return null;
  const confidence = typeof r.confidence === "number" && Number.isFinite(r.confidence) ? r.confidence : 0;
  const sampleCount = typeof r.sampleCount === "number" && Number.isFinite(r.sampleCount) ? r.sampleCount : 0;
  const evidenceSources = Array.isArray(r.evidenceSources)
    ? r.evidenceSources.filter((s): s is string => typeof s === "string")
    : [];
  return { modelId, category, score, confidence, sampleCount, evidenceSources };
}

/** Pull the score array out of the response envelope (`{ scores: [...] }` or a bare array). */
function extractScores(body: unknown): CapabilityScore[] {
  const arr = Array.isArray(body)
    ? body
    : typeof body === "object" && body !== null && Array.isArray((body as Record<string, unknown>).scores)
      ? ((body as Record<string, unknown>).scores as unknown[])
      : [];
  const out: CapabilityScore[] = [];
  for (const entry of arr) {
    const parsed = parseScore(entry);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

/** Build a capability client. Default deps wire the live config, global fetch, and event bus. */
export function createCapabilityClient(deps: CapabilityClientDeps = {}): CapabilityClient {
  const config = deps.config ?? capabilityClientConfig;
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((url, init) => fetch(url, init) as ReturnType<FetchLike>);
  const now = deps.now ?? (() => Date.now());
  const publish = deps.publish ?? ((input: EventInput<CapabilityEventPayload>) => void coreEvents.publish(input));

  let cache: CacheEntry | null = null;

  function emitUnavailable(reason: string): void {
    publish(capabilityUnavailable.create({ reason }, { source: EVENT_SOURCE }));
  }

  /** Fetch + parse the score set, or null on any failure (network, timeout, bad body). */
  async function fetchScores(): Promise<CapabilityScore[] | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const res = await fetchImpl(config.url, { signal: controller.signal });
      if (!res.ok) {
        log.debug({ status: res.status, url: config.url }, "capability ledger returned non-OK");
        emitUnavailable("http_error");
        return null;
      }
      const scores = extractScores(await res.json());
      publish(capabilityFetched.create({ scoreCount: scores.length }, { source: EVENT_SOURCE }));
      return scores;
    } catch (err) {
      log.debug({ err, url: config.url }, "capability ledger fetch failed");
      emitUnavailable("fetch_failed");
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Return the current scores, refreshing the cache when stale. On a refresh failure
   * serves the prior cache if present (best-effort resilience), otherwise caches an
   * empty negative result for the TTL window (so a down ledger is not hammered) and
   * returns null.
   */
  async function ensureScores(): Promise<readonly CapabilityScore[] | null> {
    if (!config.enabled) {
      emitUnavailable("disabled");
      return null;
    }
    const t = now();
    if (cache !== null && t - cache.fetchedAt < config.ttlMs) return cache.scores;

    const fetched = await fetchScores();
    if (fetched !== null) {
      cache = { scores: fetched, fetchedAt: t };
      return fetched;
    }
    if (cache !== null) return cache.scores; // serve stale success
    cache = { scores: [], fetchedAt: t }; // negative cache — don't re-hit a down ledger every call
    return null;
  }

  async function getScoresForModel(modelId: string): Promise<CapabilityScore[]> {
    const scores = await ensureScores();
    if (scores === null) return [];
    return scores.filter((s) => s.modelId === modelId);
  }

  async function getBestModelForCategory(category: string): Promise<CapabilityScore | null> {
    const scores = await ensureScores();
    if (scores === null) return null;
    let best: CapabilityScore | null = null;
    for (const s of scores) {
      if (s.category !== category) continue;
      if (best === null || s.score > best.score) best = s;
    }
    return best;
  }

  return { getScoresForModel, getBestModelForCategory };
}

/** The default process-wide capability client, wired to the live config + global fetch. */
export const capabilityClient: CapabilityClient = createCapabilityClient();

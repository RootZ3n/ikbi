/**
 * Velum — Credential Buffer
 * ============================================================
 * In-memory, short-lived, single-use vault for credentials extracted from
 * user input. When Velum redacts a secret from the model's view, the raw
 * value lands here so a downstream tool can consume it WITHOUT the model
 * ever seeing it.
 *
 * Guarantees:
 *  - Values expire after a TTL (default 5 minutes)
 *  - Values are single-use: consuming one marks it spent
 *  - Values are NEVER logged, NEVER written to disk, NEVER in API responses
 *    (only metadata — pattern/context/age — is ever exposed)
 * ============================================================
 */

import { randomUUID } from "node:crypto";

import { sanitizePii } from "./pii.js";

export interface CredentialEntry {
  id: string;
  pattern: string;
  value: string;
  context: string;
  createdAt: number;
  ttlMs: number;
  consumed: boolean;
}

/** Safe-to-expose view of a buffered credential — never includes the value. */
export interface CredentialMetadata {
  id: string;
  pattern: string;
  context: string;
  createdAt: number;
  ttlMs: number;
  consumed: boolean;
  ageMs: number;
  expired: boolean;
}

export const DEFAULT_TTL_MS = 5 * 60_000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60_000;

const buffer = new Map<string, CredentialEntry>();
let ttlMs = DEFAULT_TTL_MS;

/** Override the default TTL for newly stored credentials (mainly for config/tests). */
export function setCredentialTtl(ms: number): void {
  if (Number.isFinite(ms) && ms > 0) ttlMs = ms;
}

export function getCredentialTtl(): number {
  return ttlMs;
}

/** Store a credential and return its opaque buffer id. */
export function storeCredential(pattern: string, value: string, context: string): string {
  // Full 128-bit UUID — short ids were only 44 bits of entropy (M3).
  const id = randomUUID();
  const entry: CredentialEntry = {
    id,
    pattern,
    value,
    context: context.slice(0, 50),
    createdAt: Date.now(),
    ttlMs,
    consumed: false,
  };
  buffer.set(id, entry);

  // Best-effort auto-expiry. Unref so the timer never keeps the process alive.
  const t = setTimeout(() => {
    const e = buffer.get(id);
    if (e && !e.consumed) buffer.delete(id);
  }, entry.ttlMs);
  if (typeof t.unref === "function") t.unref();

  return id;
}

/**
 * Fetch a live (unconsumed, unexpired) entry, or null. Expired entries are evicted.
 *
 * @internal Exposes the raw credential value — NOT part of the public API.
 *   Use {@link consumeCredential} (single-use) or {@link getAvailableCredentials}
 *   (metadata only) instead.
 */
export function getCredential(id: string): CredentialEntry | null {
  const entry = buffer.get(id);
  if (!entry) return null;
  if (entry.consumed) return null;
  if (Date.now() - entry.createdAt > entry.ttlMs) {
    buffer.delete(id);
    return null;
  }
  return entry;
}

/** Consume a credential exactly once, returning its raw value (or null). */
export function consumeCredential(id: string): string | null {
  const entry = getCredential(id);
  if (!entry) return null;
  entry.consumed = true;
  const value = entry.value;
  // Drop it immediately after consumption — no lingering value in memory.
  buffer.delete(id);
  return value;
}

/** List metadata for available credentials (never the values). */
export function getAvailableCredentials(pattern?: string): CredentialMetadata[] {
  const now = Date.now();
  const results: CredentialMetadata[] = [];
  for (const entry of buffer.values()) {
    const expired = now - entry.createdAt > entry.ttlMs;
    if (entry.consumed || expired) continue;
    if (pattern && entry.pattern !== pattern) continue;
    results.push({
      id: entry.id,
      pattern: entry.pattern,
      // M2 — the context window can capture adjacent PII (emails, names);
      // scrub it before exposing metadata.
      context: sanitizePii(entry.context),
      createdAt: entry.createdAt,
      ttlMs: entry.ttlMs,
      consumed: entry.consumed,
      ageMs: now - entry.createdAt,
      expired: false,
    });
  }
  return results;
}

/** Evict all consumed or expired entries. */
export function clearExpiredCredentials(): void {
  const now = Date.now();
  for (const [id, entry] of buffer) {
    if (entry.consumed || now - entry.createdAt > entry.ttlMs) {
      buffer.delete(id);
    }
  }
}

/** Drop every entry. Primarily for tests. */
export function clearAllCredentials(): void {
  buffer.clear();
}

// Periodic cleanup. Unref so it never blocks process exit.
const cleanup = setInterval(clearExpiredCredentials, CLEANUP_INTERVAL_MS);
if (typeof cleanup.unref === "function") cleanup.unref();

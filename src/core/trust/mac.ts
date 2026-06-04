/**
 * ikbi trust system — durable-state integrity MAC.
 *
 * Each persisted trust doc carries a keyed MAC over its content. The key is kept
 * SEPARATE from the trust dir (config/env), so a hand-edited or hand-forged trust
 * doc (e.g. `tier: "trusted"`) fails verification at load and is REJECTED (fail
 * closed), not clamped-and-accepted. Defense-in-depth: an agent with a write
 * primitive to the state root cannot self-promote by editing the file.
 *
 * Canonicalization is deterministic (recursively sorted keys, undefined dropped)
 * so the MAC does not depend on JSON property order.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import type { TrustState } from "./contract.js";

/** The persisted form: the trust state plus its integrity MAC. */
export type PersistedTrustState = TrustState & { readonly mac: string };

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      if (obj[key] !== undefined) out[key] = sortValue(obj[key]);
    }
    return out;
  }
  return value;
}

/** Deterministic JSON used as the MAC input. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/** Compute the keyed MAC (hex) over a trust state. */
export function computeMac(key: string, state: TrustState): string {
  return createHmac("sha256", key).update(canonicalize(state)).digest("hex");
}

/** Wrap a state with its MAC for persistence. */
export function wrap(key: string, state: TrustState): PersistedTrustState {
  return { ...state, mac: computeMac(key, state) };
}

function macsEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/**
 * Verify + unwrap a persisted doc. Returns the TrustState if the MAC is valid;
 * returns undefined if the MAC is missing/invalid (forged or corrupt) — the caller
 * fails closed on undefined.
 */
export function verifyUnwrap(key: string, persisted: PersistedTrustState | undefined): TrustState | undefined {
  if (persisted === undefined || persisted === null || typeof persisted !== "object") return undefined;
  const { mac, ...state } = persisted;
  if (typeof mac !== "string" || mac.length === 0) return undefined;
  const expected = computeMac(key, state as TrustState);
  return macsEqual(mac, expected) ? (state as TrustState) : undefined;
}

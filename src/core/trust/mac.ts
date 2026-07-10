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
import { MAX_TRANSITIONS, TRUST_CONTRACT_VERSION } from "./contract.js";
import { TRUST_TIERS } from "../identity/contract.js";

const TIERS = new Set<string>(TRUST_TIERS);
const isNonNegInt = (n: unknown): boolean => typeof n === "number" && Number.isFinite(n) && n >= 0;
const isFiniteNum = (n: unknown): boolean => typeof n === "number" && Number.isFinite(n);

/**
 * Post-MAC SCHEMA validation (Codex M3). The MAC proves integrity, but a MAC-valid doc could still
 * be malformed — a contract-version mismatch after an upgrade, a serialization bug, or (if the key
 * ever leaked) a forged doc with an out-of-range tier/counter. Validate the shape before trusting
 * it; anything off ⇒ reject (fail closed, exactly like a bad MAC), so the caller resets to the floor.
 */
function isValidTrustState(s: Record<string, unknown>): boolean {
  if (s.contractVersion !== TRUST_CONTRACT_VERSION) return false;
  if (typeof s.agentId !== "string" || s.agentId.length === 0) return false;
  if (s.kind !== "operator" && s.kind !== "agent") return false;
  if (typeof s.defaultTrustTier !== "string" || !TIERS.has(s.defaultTrustTier)) return false;
  if (typeof s.tier !== "string" || !TIERS.has(s.tier)) return false;
  for (const k of ["successCount", "failureCount", "partialCount", "rejectedCount", "injectionFlags", "promotableStreak", "consecutiveFailures"] as const) {
    if (!isNonNegInt(s[k])) return false;
  }
  if (typeof s.injectionFlagged !== "boolean") return false;
  if (!isFiniteNum(s.createdAt) || !isFiniteNum(s.updatedAt)) return false;
  if (!Array.isArray(s.transitions) || s.transitions.length > MAX_TRANSITIONS) return false;
  if (!Array.isArray(s.streakOperations) || !s.streakOperations.every((o) => typeof o === "string")) return false;
  if (s.operations === null || typeof s.operations !== "object" || Array.isArray(s.operations)) return false;
  return true;
}

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
  if (!macsEqual(mac, expected)) return undefined;
  // MAC valid — now require a well-formed schema too (M3), else fail closed.
  return isValidTrustState(state as Record<string, unknown>) ? (state as TrustState) : undefined;
}

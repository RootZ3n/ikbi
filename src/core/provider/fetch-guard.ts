/**
 * ikbi provider layer — fetch-guard seam (additive, FAIL-CLOSED).
 *
 * Every OpenAI-compatible provider performs outbound HTTP through a `FetchLike`.
 * To subject ALL provider egress to the network-egress SSRF floor WITHOUT the
 * frozen provider layer depending on the egress module, provider construction
 * reads a process-wide GUARDED fetch from this registry instead of falling back
 * to raw `globalThis.fetch`.
 *
 * THE FAIL-CLOSED CONTRACT:
 *   - `registerFetchGuard(guard)` is called once by the network-egress floor at
 *     load (it registers its `guardedFetch`).
 *   - `resolveFetchGuard()` returns that guard, or THROWS `EgressGuardMissingError`
 *     if none has been registered. It NEVER falls back to `globalThis.fetch`, so a
 *     provider constructed before the egress floor loads fails closed rather than
 *     performing un-guarded network I/O.
 *   - An explicit `fetchImpl` passed at construction (tests inject one) bypasses
 *     this registry entirely — that path is unchanged.
 *
 * This is the only place the provider layer references the egress floor, and it
 * does so by inversion (the floor pushes a guard in) — no import edge from core
 * provider to the module. See provider/contract.ts CONTRACT_VERSION 1.1.0.
 */

import type { FetchLike } from "./providers/openai-compatible.js";

/**
 * Thrown when a provider would perform HTTP but no egress guard is registered.
 * Fail-closed: the engine must load the network-egress floor before any provider
 * constructs against the live network.
 */
export class EgressGuardMissingError extends Error {
  constructor() {
    super(
      "no egress fetch guard registered — the network-egress floor must load before any provider performs HTTP",
    );
    this.name = "EgressGuardMissingError";
  }
}

/** The process-wide guarded fetch. Undefined until the egress floor registers one. */
let guard: FetchLike | undefined;

/**
 * Register the process-wide guarded fetch. Called by the network-egress floor at
 * module load. The last registration wins (the floor owns this).
 */
export function registerFetchGuard(g: FetchLike): void {
  guard = g;
}

/**
 * Resolve the registered guarded fetch, or throw `EgressGuardMissingError`.
 * FAIL-CLOSED — there is deliberately NO `globalThis.fetch` fallback here.
 */
export function resolveFetchGuard(): FetchLike {
  if (guard === undefined) throw new EgressGuardMissingError();
  return guard;
}

/** Is a guard currently registered? (Diagnostics / wiring checks.) */
export function hasFetchGuard(): boolean {
  return guard !== undefined;
}

/**
 * TEST-ONLY: clear the registered guard so a test can assert the fail-closed path.
 * Not part of the runtime contract — production never un-registers the floor.
 */
export function resetFetchGuardForTests(): void {
  guard = undefined;
}

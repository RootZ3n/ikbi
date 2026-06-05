/**
 * ikbi kill-switch — the durable, authorized kill consumer of the Step-S seam.
 *
 * SAFETY-CRITICAL (3-eyes):
 *  - AUTHORIZATION: an "operator" kill requires an operator-tier identity; a
 *    non-operator is REJECTED — never published, never latched. `clear()` is
 *    operator-only. The raw core publishKill gates nothing; this is the gate.
 *  - DURABLE LATCH: kills persist to a substrate DocumentStore under the state root,
 *    so a kill SURVIVES a restart until an operator clears it. The latch is the source
 *    of truth; isKilled reads it (lazily loaded, kept warm via the seam subscription).
 *  - COOPERATIVE: isKilled is the read the long-running loops call at checkpoints;
 *    this module never aborts anyone — the loops obey.
 */

import { createDocumentStore } from "../../core/substrate/index.js";
import { events as coreEvents } from "../../core/events/index.js";
import type { EventInput } from "../../core/events/index.js";
import { isValidatedIdentity } from "../../core/identity/index.js";
import type { ValidatedIdentity } from "../../core/identity/index.js";
import {
  killTargets,
  onKill as coreOnKill,
  publishKill as corePublishKill,
  type KillSignal,
  type KillTarget,
} from "../../core/kill-switch.js";
import type { Subscription } from "../../core/events/index.js";
import { killSwitchConfig, LATCH_ID, type KillSwitchConfig } from "./config.js";
import { killswitchCleared, killswitchEngaged, killswitchRejected } from "./events.js";
import type { ClearResult, KillCheck, KillResult, KillState, KillStatus, KillSwitch, DegradeOptions } from "./contract.js";

const EVENT_SOURCE = "kill-switch";

/** Stable identity for a signal (so we never double-latch the same kill). */
function signalKey(s: KillSignal): string {
  return `${s.reason}|${s.mode}|${s.scope}|${s.target ?? ""}`;
}

/** Is this identity operator-tier (the authorization bar for an operator kill / clear)? */
function isOperatorTier(identity: ValidatedIdentity): boolean {
  return isValidatedIdentity(identity) && identity.identity.trustTier === "operator";
}

/** Minimal latch store surface (substitutable in tests). */
export interface LatchStore {
  get(id: string): Promise<KillState | undefined>;
  put(id: string, value: KillState): Promise<void>;
}

/** Injectable dependencies. */
export interface KillSwitchDeps {
  readonly config?: KillSwitchConfig;
  readonly store?: LatchStore;
  readonly publishKill?: (signal: KillSignal, opts?: { source?: string }) => void;
  readonly onKill?: (handler: (signal: KillSignal) => void) => Subscription;
  readonly publish?: (input: EventInput<unknown>) => void;
  readonly now?: () => number;
  /** Subscribe to the bus at construction to keep the latch warm (default true; tests set false). */
  readonly subscribe?: boolean;
}

/** Build the kill-switch. Defaults wire the live substrate + seam. */
export function createKillSwitch(deps: KillSwitchDeps = {}): KillSwitch {
  const config = deps.config ?? killSwitchConfig;
  const store: LatchStore = deps.store ?? createDocumentStore<KillState>({ dir: config.latchDir });
  const doPublishKill = deps.publishKill ?? ((signal: KillSignal, opts?: { source?: string }) => void corePublishKill(signal, opts));
  const publish = deps.publish ?? ((input: EventInput<unknown>) => void coreEvents.publish(input));
  const now = deps.now ?? Date.now;

  let signals: KillSignal[] = [];
  let loaded = false;
  let loadPromise: Promise<void> | undefined;

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    if (loadPromise === undefined) {
      loadPromise = (async () => {
        const s = await store.get(LATCH_ID).catch(() => undefined);
        signals = s !== undefined ? [...s.signals] : [];
        loaded = true;
      })();
    }
    await loadPromise;
  }

  async function persist(): Promise<void> {
    await store.put(LATCH_ID, { signals: [...signals], updatedAt: now() });
  }

  /** Add to the in-memory latch (dedup by key). Returns true if newly added. */
  function latch(signal: KillSignal): boolean {
    const key = signalKey(signal);
    if (signals.some((s) => signalKey(s) === key)) return false;
    signals.push(signal);
    return true;
  }

  function emit<P>(event: { create: (p: P, o?: { source?: string }) => EventInput<P> }, payload: P): void {
    publish(event.create(payload, { source: EVENT_SOURCE }));
  }

  // Keep the in-memory latch WARM from the live bus (a kill from another path syncs in).
  const subscribe = deps.subscribe ?? true;
  if (subscribe) {
    const sub = (deps.onKill ?? coreOnKill)((signal: KillSignal) => {
      void ensureLoaded().then(() => latch(signal));
    });
    void sub; // held for process lifetime
  }
  // Warm the latch shortly after construction (honors a persisted kill near boot).
  void ensureLoaded();

  async function engage(signal: KillSignal, identity: ValidatedIdentity): Promise<KillResult> {
    if (!isValidatedIdentity(identity)) {
      emit(killswitchRejected, { reason: signal.reason, scope: signal.scope, why: "no validated identity" });
      return { engaged: false, reason: "no validated identity" };
    }
    // AUTHORIZATION (Decision 2): an operator kill REQUIRES an operator-tier identity.
    if (signal.reason === "operator" && !isOperatorTier(identity)) {
      emit(killswitchRejected, { reason: signal.reason, scope: signal.scope, why: "operator kill requires an operator-tier identity" });
      return { engaged: false, reason: "operator kill requires an operator-tier identity" };
    }
    await ensureLoaded();
    latch(signal);
    await persist();
    doPublishKill(signal, { source: EVENT_SOURCE }); // the seam event (now a real halt)
    emit(killswitchEngaged, { reason: signal.reason, mode: signal.mode, scope: signal.scope, ...(signal.target !== undefined ? { target: signal.target } : {}), ...(signal.note !== undefined ? { note: signal.note } : {}) });
    return { engaged: true };
  }

  async function kill(signal: KillSignal, identity: ValidatedIdentity): Promise<KillResult> {
    return engage(signal, identity);
  }

  async function degrade(opts: DegradeOptions, identity: ValidatedIdentity): Promise<KillResult> {
    const signal: KillSignal = { reason: "degraded", mode: "soft", scope: opts.scope ?? "engine", ...(opts.target !== undefined ? { target: opts.target } : {}), ...(opts.note !== undefined ? { note: opts.note } : {}) };
    return engage(signal, identity);
  }

  async function clear(identity: ValidatedIdentity): Promise<ClearResult> {
    // CLEAR IS OPERATOR-ONLY — a persisted kill stays until an operator clears it.
    if (!isOperatorTier(identity)) {
      emit(killswitchRejected, { reason: "operator", scope: "engine", why: "clear requires an operator-tier identity" });
      return { cleared: false, reason: "clear requires an operator-tier identity" };
    }
    await ensureLoaded();
    const clearedCount = signals.length;
    signals = [];
    await persist();
    emit(killswitchCleared, { clearedCount });
    return { cleared: true };
  }

  async function isKilled(target: KillTarget): Promise<KillCheck> {
    if (!config.enabled) return { killed: false };
    await ensureLoaded();
    const signal = signals.find((s) => killTargets(s, target));
    return signal !== undefined ? { killed: true, signal } : { killed: false };
  }

  async function status(): Promise<KillStatus> {
    await ensureLoaded();
    return { killed: signals.length > 0, signals: [...signals] };
  }

  return { kill, degrade, clear, isKilled, status };
}

/** The default process-wide kill-switch (live substrate + seam; subscribes at load). */
export const killSwitch: KillSwitch = createKillSwitch();

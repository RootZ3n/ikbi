/**
 * ikbi kill-switch — the durable, authorized kill consumer of the Step-S seam.
 *
 * SAFETY-CRITICAL (3-eyes):
 *  - AUTHORIZATION BY IMPACT: ANY kill that HALTS work requires an operator-tier
 *    identity — the authorization is keyed on IMPACT (does this stop work?), NOT on the
 *    `reason` string (reason is audit metadata only). A non-operator engaging a
 *    policy/shutdown/degraded halt is REJECTED exactly like an operator-reason one —
 *    never published, never latched. `clear()` is operator-only.
 *  - UNFORGEABLE LATCH: the durable latch is the SOLE source of truth for isKilled(),
 *    and it is written ONLY by this module's authorized engage()/degrade() path. The
 *    module does NOT warm/trust the latch from raw inbound engine.kill events — so a
 *    direct, ungated core publishKill() emits an observable event but CANNOT forge an
 *    obeyed kill the checkpoints honor. The authorized module path is the only writer.
 *  - DURABLE LATCH: kills persist to a substrate DocumentStore under the state root,
 *    so a kill SURVIVES a restart until an operator clears it. The latch is the source
 *    of truth; isKilled reads it (lazily loaded, warmed from the durable store on boot).
 *  - FAIL-CLOSED: an unreadable latch (store error / corruption) is NOT treated as
 *    "not killed" — the module assumes an engine-scope soft kill + emits a LOUD event
 *    until an operator clears or a restart recovers. A killed engine must never
 *    silently forget it was killed.
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
  publishKill as corePublishKill,
  type KillSignal,
  type KillTarget,
} from "../../core/kill-switch.js";
import { killSwitchConfig, LATCH_ID, type KillSwitchConfig } from "./config.js";
import { killswitchCleared, killswitchEngaged, killswitchRejected, killswitchUnreadable } from "./events.js";
import type { ClearResult, KillCheck, KillResult, KillState, KillStatus, KillSwitch, DegradeOptions } from "./contract.js";

const EVENT_SOURCE = "kill-switch";

/** Stable identity for a signal (so we never double-latch the same kill). */
function signalKey(s: KillSignal): string {
  return `${s.reason}|${s.mode}|${s.scope}|${s.target ?? ""}`;
}

/** Is this identity operator-tier (the authorization bar for a work-halting kill / clear)? */
function isOperatorTier(identity: ValidatedIdentity): boolean {
  return isValidatedIdentity(identity) && identity.identity.trustTier === "operator";
}

/**
 * Does this signal HALT work? AUTHORIZATION IS BY IMPACT (C3a), not by `reason`. A
 * "soft" kill stops NEW work; a "hard" kill aborts the current step at the next
 * checkpoint — BOTH halt work, at every scope (engine/agent/run/operation halts its
 * subjects). So every kill mode halts; the `reason` string is audit metadata and must
 * NOT be the authorization key (treating reason:"operator" as the only gated case was
 * the bug — a non-operator could engage a policy/shutdown/degraded halt).
 */
function haltsWork(signal: KillSignal): boolean {
  return signal.mode === "soft" || signal.mode === "hard";
}

/**
 * The FAIL-CLOSED kill assumed when the durable latch is UNREADABLE (store error /
 * corruption). An engine-scope soft kill (prevent new work) held in memory until an
 * operator clears or a restart recovers the read. NOT persisted — it is a safe derived
 * state, not an authorized latch write.
 */
const UNREADABLE_LATCH_KILL: KillSignal = Object.freeze({
  reason: "policy",
  mode: "soft",
  scope: "engine",
  note: "fail-closed: durable kill latch unreadable",
});

/** Minimal latch store surface (substitutable in tests). */
export interface LatchStore {
  get(id: string): Promise<KillState | undefined>;
  put(id: string, value: KillState): Promise<void>;
  /**
   * H4 — atomic READ-MODIFY-WRITE under a CROSS-PROCESS lock (no lost updates). The latch is written
   * from separate processes (a build/server AND the `ikbi kill` / `ikbi unkill` CLI), so engage/clear
   * must not do a get-then-put on a possibly-stale in-memory copy: two concurrent kills would clobber
   * one another. `mutate` sees the FRESH durable value under the lock; the real store is the substrate
   * DocumentStore.update.
   */
  update(id: string, mutate: (current: KillState | undefined) => KillState): Promise<KillState>;
}

/** Injectable dependencies. */
export interface KillSwitchDeps {
  readonly config?: KillSwitchConfig;
  readonly store?: LatchStore;
  readonly publishKill?: (signal: KillSignal, opts?: { source?: string }) => void;
  readonly publish?: (input: EventInput<unknown>) => void;
  readonly now?: () => number;
  /** Warm the durable latch from the store at construction (default true; tests set false). */
  readonly subscribe?: boolean;
  /** H5: max age (ms) of the in-memory latch before isKilled re-reads the durable store, so a
   *  long-running loop SEES a kill engaged AFTER it started. Default 2000; 0 ⇒ re-read every check. */
  readonly reloadTtlMs?: number;
}

/** Build the kill-switch. Defaults wire the live substrate + seam. */
export function createKillSwitch(deps: KillSwitchDeps = {}): KillSwitch {
  const config = deps.config ?? killSwitchConfig;
  // H4: CROSS-PROCESS latch — the CLI (`ikbi kill`/`unkill`) and the running engine touch the same
  // durable latch from different processes, so it takes cross-process file locks (get + the update RMW).
  const store: LatchStore = deps.store ?? createDocumentStore<KillState>({ dir: config.latchDir, crossProcess: true });
  const doPublishKill = deps.publishKill ?? ((signal: KillSignal, opts?: { source?: string }) => void corePublishKill(signal, opts));
  const publish = deps.publish ?? ((input: EventInput<unknown>) => void coreEvents.publish(input));
  const now = deps.now ?? Date.now;

  const reloadTtlMs = deps.reloadTtlMs ?? 2000;
  let signals: KillSignal[] = [];
  let loaded = false;
  let lastLoadedAt = 0;
  let loadPromise: Promise<void> | undefined;

  async function ensureLoaded(): Promise<void> {
    // H5: the durable latch is the SOLE source of truth, so a long-running loop must SEE a kill
    // engaged AFTER it started — the in-memory copy is refreshed on a short TTL, not warmed ONCE at
    // boot and never re-read (which made `ikbi kill` a no-op against the very build you'd use it on).
    if (loaded && now() - lastLoadedAt < reloadTtlMs) return; // fresh enough
    if (loadPromise !== undefined) { await loadPromise; return; } // a read is already in flight
    loadPromise = (async () => {
      try {
        const s = await store.get(LATCH_ID);
        // A successful read returning undefined is a genuine "no latch" (not killed).
        signals = s !== undefined ? [...s.signals] : [];
      } catch (err) {
        // FAIL CLOSED (blocker 4): an UNREADABLE latch (store error / corruption) must
        // NOT be silently treated as "not killed" — that would let a killed engine
        // forget it was killed. Assume an engine-scope soft kill (prevent new work) +
        // emit a LOUD event, until an operator clears or a restart recovers the read.
        signals = [UNREADABLE_LATCH_KILL];
        emit(killswitchUnreadable, { why: err instanceof Error ? err.message : String(err) });
      }
      loaded = true;
      lastLoadedAt = now();
    })();
    try {
      await loadPromise;
    } finally {
      loadPromise = undefined; // clear so the NEXT stale check can trigger a fresh re-read
    }
  }

  function emit<P>(event: { create: (p: P, o?: { source?: string }) => EventInput<P> }, payload: P): void {
    publish(event.create(payload, { source: EVENT_SOURCE }));
  }

  // UNFORGEABLE LATCH (C3b): the module does NOT subscribe to raw inbound engine.kill
  // events to warm its latch — that was the forge vector (anything can publishKill
  // ungated). The obeyed latch is written ONLY by the authorized engage()/degrade()
  // path below. Here we merely warm from the DURABLE store on boot, so a persisted kill
  // is honored before the first operation (a raw event is observability, not a write path).
  const warmOnBoot = deps.subscribe ?? true;
  if (warmOnBoot) void ensureLoaded();

  async function engage(signal: KillSignal, identity: ValidatedIdentity): Promise<KillResult> {
    if (!isValidatedIdentity(identity)) {
      emit(killswitchRejected, { reason: signal.reason, scope: signal.scope, why: "no validated identity" });
      return { engaged: false, reason: "no validated identity" };
    }
    // AUTHORIZATION BY IMPACT (C3a): ANY kill that HALTS work requires an operator-tier
    // identity — regardless of `reason`. A non-operator can no longer engage a
    // policy/shutdown/degraded halt by choosing a non-"operator" reason string (that was
    // the bug: the gate keyed on reason, not impact). reason is audit metadata only.
    if (haltsWork(signal) && !isOperatorTier(identity)) {
      emit(killswitchRejected, { reason: signal.reason, scope: signal.scope, why: "a work-halting kill requires an operator-tier identity" });
      return { engaged: false, reason: "a work-halting kill requires an operator-tier identity" };
    }
    // H4 — atomic CROSS-PROCESS read-modify-write. `mutate` sees the FRESH durable signals under the
    // lock, so a concurrent engage in ANOTHER process (or the CLI) can never lose an update: we add our
    // signal to whatever is currently latched. This subsumes the old L4 "persist before in-memory push"
    // ordering — the durable store is still written first (it IS the write), and the in-memory copy is
    // synced FROM the persisted result afterwards, so a write failure throws before any memory mutation
    // and leaves memory == disk. Idempotent: an already-latched signal is a no-op-content rewrite.
    const key = signalKey(signal);
    const persisted = await store.update(LATCH_ID, (current) => {
      const currentSignals = current?.signals ?? [];
      const next = currentSignals.some((s) => signalKey(s) === key) ? currentSignals : [...currentSignals, signal];
      return { signals: next, updatedAt: now() };
    });
    signals = [...persisted.signals];
    loaded = true;
    lastLoadedAt = now();
    doPublishKill(signal, { source: EVENT_SOURCE }); // the seam event (now a real halt)
    emit(killswitchEngaged, { reason: signal.reason, mode: signal.mode, scope: signal.scope, ...(signal.target !== undefined ? { target: signal.target } : {}), ...(signal.note !== undefined ? { note: signal.note } : {}) });
    return { engaged: true };
  }

  async function kill(signal: KillSignal, identity: ValidatedIdentity): Promise<KillResult> {
    return engage(signal, identity);
  }

  /**
   * Engage a degraded soft-kill (stop new work, finish in-flight). A degraded kill HALTS
   * work, so it routes through engage()'s authorization-by-impact gate (FIX 5, routed A):
   * in v1 it is OPERATOR-GATED, identical to kill() — a non-operator, non-engine caller
   * cannot degrade (an engine-scope stop-new-work is a DoS surface). The deferred
   * auto-trigger (circuit-breaker / drift / resource pressure) is an engine-internal seam
   * that will call this through an engine-internal identity; that path is not built here.
   */
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
    // H4 — atomic cross-process RMW: read the CURRENT durable count under the lock (not a stale
    // in-memory copy) and clear it, so a clear can never race-lose against a concurrent engage.
    let clearedCount = 0;
    await store.update(LATCH_ID, (current) => {
      clearedCount = current?.signals.length ?? 0;
      return { signals: [], updatedAt: now() };
    });
    signals = [];
    loaded = true;
    lastLoadedAt = now();
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

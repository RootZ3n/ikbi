/**
 * ikbi kill-switch — its OWN lifecycle events (namespaced `killswitch.*`).
 *
 * The actual halt signal is the CORE seam's `engine.kill` (reserved bare namespace) —
 * this module re-publishes that via the seam's `publishKill`. These `killswitch.*`
 * events are the MODULE's audit trail: a kill engaged, a kill REJECTED (unauthorized —
 * the 3-eyes safety signal), a latch cleared. Payloads carry reason/mode/scope/target/
 * note — never identity tokens.
 *
 * (A `killswitch.obeyed` checkpoint-telemetry event is deferred — v1 checkpoints
 * surface a kill via their own worker.failed / batch.stopped events with a kill reason.)
 */

import { defineEvent } from "../../core/events/index.js";
import type { KillMode, KillReason, KillScope } from "../../core/kill-switch.js";

/** An authorized kill engaged (event published + latch set). */
export const killswitchEngaged = defineEvent<{ reason: KillReason; mode: KillMode; scope: KillScope; target?: string; note?: string }>("killswitch.engaged");

/** A kill was REJECTED — unauthorized (NOT published, NOT latched). The safety signal. */
export const killswitchRejected = defineEvent<{ reason: KillReason; scope: KillScope; why: string }>("killswitch.rejected");

/** The latch was cleared (un-killed) by an operator. */
export const killswitchCleared = defineEvent<{ clearedCount: number }>("killswitch.cleared");

/**
 * The durable latch could NOT be read (store error / corruption) — a LOUD fail-closed
 * signal. The module assumes an engine-scope soft kill until an operator clears or a
 * restart recovers the read. A killed engine must never silently forget it was killed.
 */
export const killswitchUnreadable = defineEvent<{ why: string }>("killswitch.unreadable");

/**
 * ikbi kill-switch SEAM (Step S) — graceful-degradation / emergency-halt.
 *
 * THE PROBLEM this solves: a kill-switch that worked by editing every module would
 * collide with every builder. Instead the halt signal rides the FROZEN event bus
 * as a well-known typed event, and in-flight operations check it the same way they
 * already check `identity.revalidate(...)` / `workspace.reclaim(...)` — a periodic,
 * cooperative check at safe points. This file builds the SEAM only (the event type
 * + the publish/subscribe + the "does this signal target me?" convention); the
 * graceful-degradation/kill-switch MODULE (a late leaf) implements the policy that
 * decides WHEN to publish and HOW hard to halt.
 *
 * It is built AGAINST the frozen events contract via `defineEvent` — the bus's own
 * extension mechanism — so it adds NO change to `core/events`. No version bump.
 *
 * THE CONVENTION for a long-running / side-effecting operation:
 *   1. subscribe once with `onKill(...)`, latching the latest applicable signal; OR
 *   2. at each safe checkpoint (between steps, before an irreversible action), test
 *      the latest signal with `killTargets(signal, ctx)` — exactly where you'd also
 *      call `identity.revalidate(...)`. If it targets you: stop cooperatively
 *      ("soft") or abort the current step ("hard"), record a receipt, release
 *      resources (`workspace.reclaim` etc.). The bus is transient — a halt that
 *      must survive a restart is the kill MODULE's durable concern, not the seam's.
 *
 * NOTE: events are at-most-once/transient (a slow subscriber can drop at the bound).
 * The seam is the live signal; the kill MODULE pairs it with a DURABLE latch
 * (substrate) so a missed event still halts. Not built here — seam only.
 */

import { defineEvent, events, type EventAttribution, type IkbiEvent, type Subscription } from "./events/index.js";

/** Why a halt was requested (audit + policy). */
export type KillReason =
  | "operator" // explicit operator command
  | "degraded" // graceful degradation (resource/health pressure)
  | "policy" // a governance/trust policy tripped
  | "shutdown"; // orderly process shutdown

/** How hard in-flight work should stop. */
export type KillMode =
  | "soft" // finish the current safe step, then stop; no NEW work
  | "hard"; // abort the current step as soon as a checkpoint is reached

/** What the halt applies to — engine-wide, or scoped to a subject. */
export type KillScope =
  | "engine" // everything
  | "agent" // all operations for one agentId (`target` = agentId)
  | "run" // one run/operation correlation (`target` = runId)
  | "operation"; // one specific operation (`target` = requestId)

/** The typed kill signal carried on the bus. */
export interface KillSignal {
  readonly reason: KillReason;
  readonly mode: KillMode;
  readonly scope: KillScope;
  /** The subject id when `scope` is narrower than "engine" (agentId / runId / requestId). */
  readonly target?: string;
  /** Human/audit note. */
  readonly note?: string;
}

/** The canonical kill event type (dotted namespace, like all engine events). */
export const KILL_EVENT_TYPE = "engine.kill";

/** The typed kill event — modules publish/subscribe this via the frozen bus. */
export const killEvent = defineEvent<KillSignal>(KILL_EVENT_TYPE);

/** Publish a kill signal onto the bus. Returns the stamped envelope (with `seq`). */
export function publishKill(
  signal: KillSignal,
  opts?: { source?: string; attribution?: EventAttribution },
): IkbiEvent<KillSignal> {
  return events.publish(killEvent.create(signal, { source: opts?.source ?? "kill-switch", ...opts }));
}

/** Subscribe to kill signals. The handler receives only `engine.kill` events. */
export function onKill(
  handler: (signal: KillSignal, event: IkbiEvent<KillSignal>) => void | Promise<void>,
  opts?: { label?: string },
): Subscription {
  return events.subscribe<KillSignal>(
    { types: [KILL_EVENT_TYPE], label: opts?.label ?? "kill-switch" },
    (event) => handler(event.payload, event),
  );
}

/** The minimal facts an in-flight op exposes so a kill signal can be matched to it. */
export interface KillTarget {
  /** The acting agent's id (`ctx.identity.identity.agentId`). */
  readonly agentId?: string;
  /** This operation's run/correlation id, if any. */
  readonly runId?: string;
  /** This operation's request id (`ctx.requestId`), if any. */
  readonly requestId?: string;
}

/**
 * THE IN-FLIGHT CHECK (convention): does `signal` apply to the operation described
 * by `target`? An engine-scoped signal targets everyone; a scoped signal targets
 * only the matching subject. An operation calls this at its safe checkpoints —
 * exactly where it would call `identity.revalidate(...)` — and halts if true.
 */
export function killTargets(signal: KillSignal, target: KillTarget): boolean {
  switch (signal.scope) {
    case "engine":
      return true;
    case "agent":
      return signal.target !== undefined && signal.target === target.agentId;
    case "run":
      return signal.target !== undefined && signal.target === target.runId;
    case "operation":
      return signal.target !== undefined && signal.target === target.requestId;
  }
}

/**
 * ikbi kill-switch — THE MODULE CONTRACT (versioned).
 *
 * The CONSUMER of the Step-S kill seam (`core/kill-switch.ts`), which had ZERO
 * consumers — a published `engine.kill` gated nothing. This module makes the kill
 * REAL: a durable authorization-gated latch + cooperative checkpoints the long-running
 * loops obey.
 *
 * THREE confirmed decisions:
 *   (1) COOPERATIVE-CHECKPOINT-STOP v1 — a kill (a) publishes the seam event,
 *       (b) sets a DURABLE "killed" latch (survives restart), (c) is OBEYED at natural
 *       checkpoints: worker-model checks between roles, batch-planner between subtask
 *       levels, and BOTH refuse to START new work when killed. "hard" stops at the next
 *       checkpoint; "soft" finishes the current safe step then stops. True mid-model-call
 *       abort is NOT v1 (it needs an AbortSignal threaded through OperationContext — a
 *       deferred frozen-core change). At role/level granularity, v1 hard ≈ soft.
 *   (2) OPERATOR/ENGINE-ONLY AUTHORIZATION — an "operator" kill MUST come from an
 *       operator-tier identity; a non-operator attempting one is REJECTED (not honored,
 *       not published). The raw core publishKill gates nothing; THIS module is the gate.
 *   (3) DEGRADED-SOFT-KILL now, auto-trigger as a SEAM — `degrade()` publishes a
 *       reason:"degraded" mode:"soft" kill (stop new work, finish in-flight). What
 *       DETECTS degradation (circuit-breaker/drift/resource pressure) and calls it is a
 *       deferred seam — a caller invokes `degrade()`.
 *
 * No frozen-core change (built on the existing kill seam + OperationContext as-is).
 *
 * CONTRACT_VERSION changelog (newest on top):
 *   1.0.0 — initial kill-switch contract: durable KillState latch, authorized
 *           kill/degrade/clear, the isKilled checkpoint query. Cooperative-checkpoint-stop.
 */

import type { KillSignal, KillTarget } from "../../core/kill-switch.js";

/** Semantic version of the kill-switch contract. Bump on breaking change. */
export const CONTRACT_VERSION = "1.0.0";

export type { KillSignal, KillTarget };

/** The durable latch persisted under the state root (survives restart). */
export interface KillState {
  /** The active kill signals (engine-scope or narrower). */
  readonly signals: readonly KillSignal[];
  readonly updatedAt: number;
}

/** The result of an authorized kill/degrade attempt. */
export interface KillResult {
  readonly engaged: boolean;
  /** Refusal reason when not engaged (e.g. unauthorized). */
  readonly reason?: string;
}

/** The result of a clear (un-kill) attempt. */
export interface ClearResult {
  readonly cleared: boolean;
  readonly reason?: string;
}

/** The answer a cooperative checkpoint gets. */
export interface KillCheck {
  readonly killed: boolean;
  readonly signal?: KillSignal;
}

/** A snapshot of the current kill state (for a status route/CLI). */
export interface KillStatus {
  readonly killed: boolean;
  readonly signals: readonly KillSignal[];
}

/** Options for `degrade()` (a degraded-soft-kill). */
export interface DegradeOptions {
  readonly scope?: KillSignal["scope"];
  readonly target?: string;
  readonly note?: string;
}

/**
 * The cooperative checkpoint query the long-running loops call — read-only. Given an
 * operation's {agentId, runId, requestId}, true when an active kill applies to it.
 */
export type KillCheckFn = (target: KillTarget) => Promise<KillCheck>;

/** The kill-switch surface. */
export interface KillSwitch {
  /** Authorize + engage a kill (publish the seam event + set the durable latch). */
  kill(signal: KillSignal, identity: import("../../core/identity/index.js").ValidatedIdentity): Promise<KillResult>;
  /** Engage a degraded soft-kill (Decision 3 — stop new work, finish in-flight). */
  degrade(opts: DegradeOptions, identity: import("../../core/identity/index.js").ValidatedIdentity): Promise<KillResult>;
  /** Clear the latch (operator-only — a persisted kill stays until explicitly cleared). */
  clear(identity: import("../../core/identity/index.js").ValidatedIdentity): Promise<ClearResult>;
  /** The checkpoint query (does an active kill target this operation?). */
  isKilled(target: KillTarget): Promise<KillCheck>;
  /** The current kill state. */
  status(): Promise<KillStatus>;
}

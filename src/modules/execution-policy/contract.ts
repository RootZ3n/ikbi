/**
 * execution-policy — NEUTRAL CONTRACT LAYER for gate-wall, governed-exec, and worker-model.
 *
 * This module exists to break the circular dependency:
 *   gate-wall ↔ governed-exec ↔ worker-model
 *
 * The dependency direction after this extraction:
 *   execution-policy  ← policy/contracts only (no runtime deps on the three modules)
 *   gate-wall         → execution-policy
 *   governed-exec     → execution-policy + gate-wall (runtime singleton only)
 *   worker-model      → execution-policy + gate-wall + governed-exec
 *
 * This file holds the shared TYPE contracts that all three modules reference.
 * It imports only from the frozen core — never from gate-wall, governed-exec, or worker-model.
 *
 * CONTRACT_VERSION: 1.0.0
 */

import type { AgentIdentity } from "../../core/identity/contract.js";
import type { AutonomyGrant } from "../../core/trust/contract.js";
import type { PromoteGovernance } from "../../core/workspace/contract.js";

// ── Re-exported from worker-model/contract.ts (type-only) ───────────────────
// These types are DEFINED in worker-model but USED by gate-wall for its action-
// tagged input. Importing them here (type-only) lets gate-wall depend on this
// neutral layer instead of reaching into worker-model directly.

import type { RoleResult, WorkerTask } from "../worker-model/contract.js";
export type { RoleResult, WorkerTask };

// ── Gate-wall types (moved from gate-wall/contract.ts) ──────────────────────

/**
 * A promote action — the worker-model orchestrator's workspace promote. Carries the
 * task + the role results so the audit records WHAT was promoted.
 */
export interface GateWallActionPromote {
  readonly kind: "promote";
  readonly task: WorkerTask;
  readonly results: readonly RoleResult[];
}

/**
 * An exec action — a governed shell/curl command (gated by governed-exec through
 * the gate-wall layer). The gate logs `command` + arg COUNT + `sudo`; the full
 * args are governed-exec's own receipt concern, NOT logged verbatim here.
 */
export interface GateWallActionExec {
  readonly kind: "exec";
  readonly command: string;
  readonly args: readonly string[];
  readonly sudo: boolean;
  readonly purpose?: string;
}

/**
 * The action being gated — a discriminated union on `kind`. Additive: a new action
 * kind extends this union without breaking the grant→governance evaluation, which is
 * action-agnostic. The action feeds the audit payload only.
 */
export type GateWallAction = GateWallActionPromote | GateWallActionExec;

/**
 * Input to a governance evaluation. `identity` is the agent the action is on behalf
 * of — carried so the gate decision is attributable on receipts/events. The decision
 * is a pure function of `grant`; `action` describes what is gated for the audit.
 */
export interface GateWallEvaluateInput {
  readonly grant: AutonomyGrant;
  readonly action: GateWallAction;
  readonly identity: AgentIdentity;
}

/** The gate-wall evaluator surface. Returns the frozen PromoteGovernance verdict. */
export interface GateWall {
  evaluate(input: GateWallEvaluateInput): Promise<PromoteGovernance>;
}

export type { PromoteGovernance };

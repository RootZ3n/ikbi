/**
 * ikbi gate-wall — THE MODULE CONTRACT (versioned).
 *
 * The gate-wall is the governance ENFORCEMENT seam: a deterministic policy
 * evaluator that turns an `AutonomyGrant` into a `PromoteGovernance` verdict. It is
 * THE enforcement layer — every governed action routes through it, not a parallel
 * gate (a bypass = an ungoverned action). It is NOT a human-approval queue (that is
 * a later P1 build) — this minimal build is a fail-closed policy gate.
 *
 * It reuses the frozen `PromoteGovernance` shape as its return type so the verdict
 * drops straight into `PromoteApproval.governance` — no adapter, no contract change.
 *
 * The evaluate INPUT is action-tagged (a `GateWallAction` discriminated union) so a
 * non-promote action (governed shell/curl) is gated by the SAME grant logic — the
 * action only describes WHAT is gated in the receipt/event audit; it never changes
 * the allow/deny decision (that stays a pure `grant` → governance evaluation).
 *
 * CONTRACT_VERSION changelog (newest on top):
 *   1.1.0 — additive: generalize GateWallEvaluateInput from promote-specific (inline
 *           task/results) to an action-tagged `GateWallAction` union (promote | exec)
 *           so non-promote actions gate through the same enforcement layer. The
 *           allow/deny logic is UNCHANGED (still driven by the autonomy grant); the
 *           action only feeds the audit payload. Backward-compatible minor bump.
 *   1.0.0 — initial gate-wall contract: GateWallEvaluateInput + the evaluator
 *           surface returning the frozen PromoteGovernance. Minimal policy: tiers
 *           that require operator approval are DENIED fail-closed until a human
 *           approval mechanism exists; non-approval tiers are allowed with audit.
 */

import type { AgentIdentity } from "../../core/identity/contract.js";
import type { AutonomyGrant } from "../../core/trust/contract.js";
import type { PromoteGovernance } from "../../core/workspace/contract.js";
import type { RoleResult, WorkerTask } from "../worker-model/contract.js";

/** Semantic version of the gate-wall contract. Bump on breaking change. */
export const CONTRACT_VERSION = "1.1.0";

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
 * An exec action — a governed shell/curl command (gated by governed-exec, next
 * build, through THIS layer). The gate logs `command` + arg COUNT + `sudo`; the full
 * args are governed-exec's own receipt concern, NOT logged verbatim here.
 */
export interface GateWallActionExec {
  readonly kind: "exec";
  /** The binary name (e.g. "curl", "apt-get"). */
  readonly command: string;
  /** The command arguments (logged by COUNT here, not verbatim). */
  readonly args: readonly string[];
  /** Whether the command runs under sudo. */
  readonly sudo: boolean;
  /** Optional human purpose for the audit trail. */
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
  /** The autonomy grant of the action's governance subject (the agent's tier grant). */
  readonly grant: AutonomyGrant;
  /** The action being gated (promote | exec). Feeds the audit payload only. */
  readonly action: GateWallAction;
  /** Attribution identity for the audit trail (receipt + events). */
  readonly identity: AgentIdentity;
}

/** The gate-wall evaluator surface. Returns the frozen PromoteGovernance verdict. */
export interface GateWall {
  evaluate(input: GateWallEvaluateInput): Promise<PromoteGovernance>;
}

export type { PromoteGovernance };

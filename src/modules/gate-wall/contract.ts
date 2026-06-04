/**
 * ikbi gate-wall — THE MODULE CONTRACT (versioned).
 *
 * The gate-wall is the governance ENFORCEMENT seam: a deterministic policy
 * evaluator that turns an `AutonomyGrant` into a `PromoteGovernance` verdict the
 * workspace `promote` requires. It is NOT a human-approval queue (that is a later
 * P1 build) — this minimal build is a fail-closed policy gate.
 *
 * It reuses the frozen `PromoteGovernance` shape as its return type so the verdict
 * drops straight into `PromoteApproval.governance` — no adapter, no contract change.
 *
 * CONTRACT_VERSION changelog (newest on top):
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
export const CONTRACT_VERSION = "1.0.0";

/**
 * Input to a governance evaluation. `identity` is the agent the promote is on
 * behalf of — carried so the gate decision is attributable on receipts/events.
 * (The `{ grant, task, results }` core is what the orchestrator computes per run.)
 */
export interface GateWallEvaluateInput {
  /** The autonomy grant of the run's governance subject (the parent's tier grant). */
  readonly grant: AutonomyGrant;
  readonly task: WorkerTask;
  readonly results: readonly RoleResult[];
  /** Attribution identity for the audit trail (receipt + events). */
  readonly identity: AgentIdentity;
}

/** The gate-wall evaluator surface. Returns the frozen PromoteGovernance verdict. */
export interface GateWall {
  evaluate(input: GateWallEvaluateInput): Promise<PromoteGovernance>;
}

export type { PromoteGovernance };

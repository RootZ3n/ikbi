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
 *
 * DEPENDENCY DIRECTION: the shared types (GateWall, GateWallAction, etc.) now live
 * in the neutral `execution-policy` module to break the circular dependency between
 * gate-wall, governed-exec, and worker-model. This file re-exports them for backward
 * compatibility — consumers of `gate-wall/contract` see no change.
 */

// Re-export the shared types from the neutral execution-policy module.
// This preserves backward compatibility: `import type { GateWall } from "../gate-wall/contract.js"`
// continues to work. The canonical definitions live in execution-policy/contract.ts.
export type {
  GateWall,
  GateWallAction,
  GateWallActionExec,
  GateWallActionPromote,
  GateWallEvaluateInput,
  PromoteGovernance,
  RoleResult,
  WorkerTask,
} from "../execution-policy/contract.js";

/** Semantic version of the gate-wall contract. Bump on breaking change. */
export const CONTRACT_VERSION = "1.1.0";

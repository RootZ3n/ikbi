/**
 * execution-policy — NEUTRAL POLICY + CONTRACT MODULE.
 *
 * Breaks the circular dependency between gate-wall, governed-exec, and worker-model.
 * All three import from THIS module instead of from each other.
 *
 * Dependency direction:
 *   execution-policy  → frozen core only (no runtime deps on the three modules)
 *   gate-wall         → execution-policy (contracts + risk)
 *   governed-exec     → execution-policy + gate-wall (runtime singleton)
 *   worker-model      → execution-policy + gate-wall + governed-exec
 */

export {
  type GateWall,
  type GateWallAction,
  type GateWallActionExec,
  type GateWallActionPromote,
  type GateWallEvaluateInput,
  type PromoteGovernance,
  type RoleResult,
  type WorkerTask,
} from "./contract.js";

export { commandPolicyDenyReason } from "./risk.js";

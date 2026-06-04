/**
 * ikbi gate-wall — module entrypoint.
 *
 * Pins the frozen-core contracts the gate-wall builds against (exact targets) so a
 * drift throws a clear ContractVersionError at load. Like worker-model, gate-wall
 * registers NO guard / side-effect — it is a pure consumer of the frozen core. The
 * operator wires it into the orchestrator (as the `gateWall` dep) in the post-merge
 * pass; this file does not touch the barrel.
 *
 * P1 minimal: a deterministic policy evaluator. The human-approval queue (the
 * mechanism that would let a requiresApproval tier promote) is a later P1 build.
 */

import { assertContractCompatible } from "../../core/contracts/index.js";

assertContractCompatible("trust", "1.0.0");
assertContractCompatible("workspace", "1.0.0");
assertContractCompatible("receipt", "1.0.0");
assertContractCompatible("events", "1.0.0");
assertContractCompatible("identity", "1.1.0");

export { createGateWall, gateWall, type GateWallDeps } from "./gate.js";
export {
  CONTRACT_VERSION,
  type GateWall,
  type GateWallAction,
  type GateWallActionExec,
  type GateWallActionPromote,
  type GateWallEvaluateInput,
  type PromoteGovernance,
} from "./contract.js";
export { gateWallConfig, loadGateWallConfig, type GateWallConfig } from "./config.js";
export {
  gateEvaluated,
  gateAllowed,
  gateDenied,
  type GateEventPayload,
} from "./events.js";

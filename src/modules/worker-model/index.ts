/**
 * ikbi worker-model substrate — module entrypoint.
 *
 * Pins every frozen-core contract this substrate builds against (exact targets) so
 * a drift throws a clear ContractVersionError at load. Unlike a floor, worker-model
 * registers NO guard / side-effect — it is a pure CONSUMER of the frozen core. The
 * operator wires it into the barrel in the post-merge pass (module plan ## 8); this
 * file does not touch the barrel.
 *
 * This pass ships the CONTRACT + ORCHESTRATOR; the five role bodies are stubbed and
 * land (with real review) in a follow-up. 3-eyes bar — not frozen until Codex.
 */

import { assertContractCompatible } from "../../core/contracts/index.js";

// Pin the eight frozen contracts the worker-model orchestrator builds against.
assertContractCompatible("provider", "1.1.0");
assertContractCompatible("injection", "1.0.0");
assertContractCompatible("identity", "1.1.0");
assertContractCompatible("trust", "1.0.0");
assertContractCompatible("workspace", "1.0.0");
assertContractCompatible("events", "1.0.0");
assertContractCompatible("receipt", "1.0.0");
assertContractCompatible("substrate", "1.0.0");

// Side-effect import: registers the `build` CLI command at load time (the modules
// barrel imports worker-model, so the command is live once ikbi starts).
import "./cli.js";

// --- public surface ---
export { createWorkerCli, productionRoleClaim, parseBuildArgs, type WorkerCliDeps } from "./cli.js";
export {
  CONTRACT_VERSION,
  WORKER_ROLES,
  isWorkerRole,
  toOutcomeStatus,
  WorkerError,
  type WorkerRole,
  type WorkerOutcome,
  type WorkerTask,
  type WorkerResult,
  type RoleResult,
  type RoleContext,
  type RoleEngine,
  type RoleFn,
} from "./contract.js";
export {
  createOrchestrator,
  orchestrator,
  runWorker,
  type OrchestratorDeps,
} from "./orchestrator.js";
export {
  workerModelConfig,
  loadWorkerModelConfig,
  DEFAULT_ROLE_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT_RUNS,
  type WorkerModelConfig,
} from "./config.js";
export {
  workerStarted,
  workerRoleDispatched,
  workerRoleCompleted,
  workerCompleted,
  workerFailed,
} from "./events.js";
export { scout } from "./scout.js";
export { builder } from "./builder.js";
export { critic } from "./critic.js";
export { verifier } from "./verifier.js";
export { integrator } from "./integrator.js";

/**
 * ikbi cognition-layer — module entrypoint.
 *
 * Pins the FROZEN-CORE contracts this module builds against (exact targets) so a
 * drift throws a clear ContractVersionError at load. It registers no named CLI command
 * and no load-time subscription. It IS, however, wired into the operator path: the CLI
 * imports `createCognitionRouter` directly (`src/cli/index.ts`) and uses it as the
 * bare-goal DEFAULT router — `ikbi <goal>` deliberates here, then auto-dispatches the
 * recommended command. So although it has no registration side-effect of its own, it is
 * a live entrypoint, not dormant.
 *
 * RECOMMENDS, NEVER INVOKES: it imports provider (invokeModel), injection, identity,
 * events (frozen core, pinned below), and the READ-ONLY module deps lab-context-memory
 * + drift-prevention. It imports NONE of the action modules — no worker-model,
 * batch-planner, agent-router, gate-wall, or governed-exec — so it cannot be tempted
 * to call them. The import-surface absence is the boundary (enforced by a test).
 */

import { assertContractCompatible } from "../../core/contracts/index.js";

assertContractCompatible("provider", "1.1.0");
assertContractCompatible("injection", "1.0.0");
assertContractCompatible("identity", "1.1.0");
assertContractCompatible("events", "1.0.0");

export { createCognitionLayer, cognitionLayer, parseDecision, type CognitionLayerDeps, type DriftReader, type LabMemoryReader, type NeutralizeFn, type ToUntrustedFn } from "./cognition.js";
export { createCognitionRouter, cognitionRouter, dispatchableArgv, parseRouterArgs, suggestedCommand, type CognitionRouterDeps } from "./cli.js";
export {
  CONTRACT_VERSION,
  CognitionError,
  type CognitionDecision,
  type CognitionInput,
  type CognitionLayer,
  type Decision,
  type RecommendableModule,
  type RecommendedNext,
} from "./contract.js";
export {
  cognitionLayerConfig,
  loadCognitionLayerConfig,
  COGNITION_MODEL,
  DEFAULT_MAX_MEMORY_ENTRIES,
  type CognitionLayerConfig,
} from "./config.js";
export { cognitionDecided } from "./events.js";

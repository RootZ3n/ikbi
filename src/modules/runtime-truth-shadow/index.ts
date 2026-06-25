/**
 * ikbi runtime-truth-shadow - module entrypoint.
 *
 * Pins the FROZEN-CORE contract it builds against (events) so drift throws at load. It registers no
 * CLI command and no load-time subscription; it runs ON DEMAND from the cognition layer in shadow
 * mode only, so it needs no modules-barrel entry.
 *
 * READ-ONLY + NO ACTION + NO CROSS-REPO DEP: it depends on Truth Firewall through a LOCAL PORT
 * (`RuntimeTruthReaderPort`) only - it imports no Truth Firewall code, writes nothing, and never
 * approves/installs/enforces/executes. The import-surface absence is the boundary (proven by test).
 */

import { assertContractCompatible } from "../../core/contracts/index.js";

assertContractCompatible("events", "1.0.0");

export {
  CONTRACT_VERSION,
  type RuntimeTruthMode,
  type RuntimeTruthSummary,
  type RuntimeTruthReaderPort,
  type ShadowDecisionRef,
  type RuntimeTruthShadowRecord,
} from "./contract.js";
export { runtimeTruthShadowObserved } from "./events.js";
export {
  RUNTIME_TRUTH_ENV,
  SHADOW_DEFAULT_AGENTS,
  parseRuntimeTruthMode,
  resolveRuntimeTruthMode,
} from "./config.js";
export { runRuntimeTruthShadow, type ShadowRunArgs } from "./shadow.js";

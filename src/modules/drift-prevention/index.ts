/**
 * ikbi drift-prevention — module entrypoint.
 *
 * Pins the FROZEN-CORE contracts this module builds against (exact targets) so a
 * drift throws a clear ContractVersionError at load. It registers NO guard / side-
 * effect and runs ON DEMAND (`check()`); it does not subscribe at load and has no CLI
 * command, so it needs no modules-barrel entry.
 *
 * READ-ONLY + NO ACTION: reads lab-context-memory ("pattern" baselines) + receipts
 * (recent outcomes) and writes/mutates NEITHER; it takes no trust/gate/promote action.
 * Hence NO gate-wall pin and NO trust dep — the import-surface absence is the proof.
 *
 * MODULE DEPS (read-only): `lab-context-memory` (pattern baselines). frozen-core pins
 * below are `receipt` (recent outcomes) + `events` (drift signals).
 */

import { assertContractCompatible } from "../../core/contracts/index.js";

assertContractCompatible("receipt", "1.0.0");
assertContractCompatible("events", "1.0.0");

export { createDriftPrevention, driftPrevention, computeDrift, reportOnly, type DriftPreventionDeps, type LabMemoryReader, type ReceiptReader } from "./drift.js";
export {
  CONTRACT_VERSION,
  type DriftAction,
  type DriftCheckOptions,
  type DriftPolicy,
  type DriftPrevention,
  type DriftReport,
  type DriftSeverity,
} from "./contract.js";
export {
  driftPreventionConfig,
  loadDriftPreventionConfig,
  DEFAULT_DRIFT_THRESHOLD,
  DEFAULT_MIN_SAMPLE_SIZE,
  DEFAULT_RECENT_WINDOW,
  type DriftPreventionConfig,
} from "./config.js";
export { driftChecked, driftDetected } from "./events.js";

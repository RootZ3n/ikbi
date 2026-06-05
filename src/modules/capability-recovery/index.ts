/**
 * ikbi capability-recovery — module entrypoint.
 *
 * Pins the FROZEN-CORE contracts this module builds against (exact targets) so a
 * drift throws a clear ContractVersionError at load. It runs ON DEMAND (`assess()`) and
 * registers the operator-facing `ikbi recover <capability>` DIAGNOSTIC command (the
 * module's barrel entry); it is ALSO a library surface for the future agent-runtime /
 * Peh coordinator to call when it detects a broken capability.
 *
 * RECOMMENDS, NEVER INVOKES: it imports provider (invokeModel), injection, identity,
 * receipt, events (frozen core, pinned below), and the READ-ONLY module deps
 * lab-context-memory + drift-prevention. It imports NONE of the repair modules —
 * no worker-model, governed-exec, dependency-install, or gate-wall (the `recover`
 * command DIAGNOSES + prints, it does not dispatch the repair) — so it cannot be tempted
 * to call them. The import-surface absence is the boundary (enforced by a test).
 */

import { assertContractCompatible } from "../../core/contracts/index.js";

assertContractCompatible("provider", "1.1.0");
assertContractCompatible("injection", "1.0.0");
assertContractCompatible("identity", "1.1.0");
assertContractCompatible("receipt", "1.0.0");
assertContractCompatible("events", "1.0.0");

// Side-effect import: registers the `recover` operator diagnostic command.
import "./cli.js";

export { createCapabilityRecovery, capabilityRecovery, parseRecoveryPlan, type CapabilityRecoveryDeps, type DriftReader, type LabMemoryReader, type NeutralizeFn, type ReceiptReader, type ToUntrustedFn } from "./recovery.js";
export {
  CONTRACT_VERSION,
  CapabilityRecoveryError,
  type CapabilityRecovery,
  type CapabilityRecoveryInput,
  type CapabilityRecoveryPlan,
  type CapabilityStatus,
  type CauseClass,
  type LastKnownGood,
  type RecommendedRepair,
  type RepairModule,
} from "./contract.js";
export {
  capabilityRecoveryConfig,
  loadCapabilityRecoveryConfig,
  RECOVERY_MODEL,
  DEFAULT_MAX_MEMORY_ENTRIES,
  DEFAULT_MAX_RECEIPTS,
  type CapabilityRecoveryConfig,
} from "./config.js";
export { recoveryAssessed } from "./events.js";
export { createRecoverCli, parseRecoverArgs, type RecoverCliDeps } from "./cli.js";

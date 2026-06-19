/**
 * ikbi self-repair — module entrypoint.
 *
 * Pins the FROZEN-CORE contracts this module builds against (substrate for the atomic
 * work-order writes + cross-process lock, events for the workspace manager it reads) so
 * a drift throws a clear ContractVersionError at load.
 *
 * The module is LIBRARY-ONLY at import: it registers no CLI command and binds no route
 * (no active work at import — matching the barrel's contract). Its operator surface is
 * `ikbi doctor --self-repair`, wired in `src/cli/index.ts`, which calls `runSelfRepair`.
 */

import { assertContractCompatible } from "../../core/contracts/index.js";

assertContractCompatible("substrate", "1.0.0");
assertContractCompatible("events", "1.0.0");

export {
  CONTRACT_VERSION,
  type CheckOutcome,
  type CheckResult,
  type HealthProbeResult,
  type MonitorCheck,
  type MonitorContext,
  type MonitorOptions,
  type MonitorPorts,
  type MonitorReport,
  type Severity,
  type TestRunResult,
  type WorkOrder,
  type WorkOrderCategory,
  type WorkOrderNote,
  type WorkOrderStatus,
} from "./contract.js";

export {
  DEFAULT_HEALTH_URL,
  DEFAULT_REQUIRED_ENV,
  DEFAULT_WORK_ORDER_DIR,
  loadSelfRepairConfig,
  monitorOptions,
  selfRepairConfig,
  type SelfRepairConfig,
} from "./config.js";

export {
  defaultChecks,
  healthCheck,
  liveMonitorPorts,
  parseTestFailures,
  runMonitor,
  runSelfRepair,
  serviceDependenciesCheck,
  sourceKey,
  testSuiteCheck,
  toWorkOrder,
  workspaceHealthCheck,
} from "./monitor.js";

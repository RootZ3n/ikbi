/**
 * ikbi lab-context-memory — module entrypoint.
 *
 * Pins the FROZEN-CORE contracts this module builds against (exact targets) so a
 * drift throws a clear ContractVersionError at load. It registers NO guard / side-
 * effect — a pure consumer. The operator wires it into an entrypoint (route/CLI) in
 * the later barrel-wiring pass; this file does NOT touch `src/modules/index.ts`.
 *
 * NOT a security boundary (2-eyes) — there is no gate-wall dependency; this is shared
 * lab memory, not an enforcement layer.
 *
 * NOTE: `identity` is pinned here for ATTRIBUTION (every entry/projection is agent-
 * attributed) — the plan's original dep row for this module omitted it; recorded as a
 * minor visibility note (like dependency-install's `events`).
 */

import { assertContractCompatible } from "../../core/contracts/index.js";

assertContractCompatible("receipt", "1.0.0");
assertContractCompatible("substrate", "1.0.0");
assertContractCompatible("events", "1.0.0");
assertContractCompatible("identity", "1.1.0"); // attribution (beyond the plan's original dep row)

export { createLabMemory, labMemory, labMemoryId, type LabMemoryDeps, type MemoryStore } from "./memory.js";
export {
  CONTRACT_VERSION,
  LabMemoryError,
  type LabMemory,
  type LabMemoryErrorKind,
  type MemoryEntry,
  type MemoryEntryInput,
  type MemoryKind,
  type MemoryQuery,
  type ProjectFromReceiptsOptions,
} from "./contract.js";
export {
  labContextMemoryConfig,
  loadLabContextMemoryConfig,
  DEFAULT_MEMORY_DIR,
  DEFAULT_MAX_RECEIPTS_PER_PROJECTION,
  type LabContextMemoryConfig,
} from "./config.js";
export {
  labmemRecorded,
  labmemProjected,
  labmemQueried,
  type LabMemEventPayload,
} from "./events.js";

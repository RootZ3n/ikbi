/**
 * ikbi self-observation — module entrypoint.
 *
 * Status: DORMANT — This module is built but not yet wired into production.
 * It will be activated when ikbi needs self-monitoring capabilities (e.g.,
 * runtime introspection, event-ring snapshots for debugging, or health
 * dashboards). Do not delete.
 *
 * Pins the FROZEN-CORE contracts this module builds against (exact targets) so a
 * drift throws a clear ContractVersionError at load. It registers NO guard / side-
 * effect and executes NOTHING — a passive observer (2-eyes). The status route that
 * returns `snapshot()` is mounted in the later barrel-wiring pass; this file does NOT
 * touch `src/modules/index.ts`.
 *
 * NO action-module deps and NO gate-wall: the observer only subscribes + reads.
 *
 * NOTE: `identity` is pinned for the agentId carried on observed events + the
 * observer's own lifecycle attribution — beyond the plan's original dep row for this
 * module; recorded as a minor additive visibility note (like lab-context-memory).
 *
 * @status dormant (library-only)
 * DORMANT: the `selfObservation` singleton is constructed at load, but NOTHING in
 * production calls `start()` or `snapshot()` and no HTTP route exposes it yet. It is a
 * passive LIBRARY surface (a redacted event-ring for introspection) awaiting a status
 * route / consumer. Until then it is inert — it neither subscribes nor reads unless a
 * caller starts it. See MODULE_CENSUS.md.
 */

import { assertContractCompatible } from "../../core/contracts/index.js";

assertContractCompatible("events", "1.0.0");
assertContractCompatible("receipt", "1.0.0");
assertContractCompatible("substrate", "1.0.0");
assertContractCompatible("identity", "1.1.0"); // attribution agentId (beyond the plan's original dep row)

export { createSelfObservation, selfObservation, type ReceiptReader, type SelfObservationDeps, type SnapshotStore } from "./observer.js";
export {
  CONTRACT_VERSION,
  type ObservationSnapshot,
  type ObservedEvent,
  type SelfObservation,
  type SubscriptionHealth,
} from "./contract.js";
export {
  selfObservationConfig,
  loadSelfObservationConfig,
  DEFAULT_RECENT_EVENTS_MAX,
  DEFAULT_SNAPSHOT_DIR,
  type SelfObservationConfig,
} from "./config.js";
export {
  selfobsStarted,
  selfobsSnapshot,
  type SelfObsEventPayload,
} from "./events.js";

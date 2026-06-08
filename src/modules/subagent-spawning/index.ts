/**
 * ikbi subagent-spawning — module entrypoint.
 *
 * Pins the FROZEN-CORE contracts this module builds against (exact targets) so a
 * drift throws a clear ContractVersionError at load. Like gate-wall / worker-model,
 * it registers NO guard / side-effect — it is a pure consumer. The operator wires
 * the spawner into an entrypoint (route/CLI) in the later barrel-wiring pass; this
 * file does NOT touch `src/modules/index.ts`.
 *
 * NOTE: `worker-model` is the module's primary dependency but is a MODULE contract,
 * not one of the frozen-core contracts in `CONTRACT_VERSIONS`, so it cannot be
 * pinned here — only the frozen deps it transits (workspace, identity, events) are.
 *
 * @status dormant (library-only)
 * DORMANT: a tested LIBRARY surface (`subagentSpawner`) for deriving child identities,
 * with NO live caller yet. It is INTENTIONALLY SEPARATE from the builder's `delegate_task`
 * tool, which runs its own in-builder sub-loop (`worker-model/builder-tools/delegate.ts`)
 * and does NOT use this module — the two are deliberately not merged. This module awaits a
 * future orchestrator/runtime consumer. See MODULE_CENSUS.md.
 */

import { assertContractCompatible } from "../../core/contracts/index.js";

assertContractCompatible("workspace", "1.0.0");
assertContractCompatible("identity", "1.1.0");
assertContractCompatible("events", "1.0.0");

export { createSubagentSpawner, subagentSpawner, type SubagentSpawnerDeps } from "./spawn.js";
export {
  CONTRACT_VERSION,
  SpawnError,
  type ChildIdentitySummary,
  type SpawnErrorKind,
  type SpawnRequest,
  type SpawnResult,
  type SubagentSpawner,
} from "./contract.js";
export { subagentSpawningConfig, loadSubagentSpawningConfig, type SubagentSpawningConfig } from "./config.js";
export {
  spawnRequested,
  spawnClamped,
  spawnDenied,
  spawnCompleted,
  type SpawnEventPayload,
} from "./events.js";

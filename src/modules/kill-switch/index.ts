/**
 * ikbi kill-switch — module entrypoint.
 *
 * Pins the FROZEN-CORE contracts this module builds against (exact targets) so a
 * drift throws a clear ContractVersionError at load. It consumes the Step-S kill SEAM
 * (`core/kill-switch.ts`: publishKill / onKill / killTargets) — NOT a frozen contract,
 * so it is not pinned; the seam is built on the frozen events bus.
 *
 * The modules barrel imports this file at engine start so the durable latch is read on
 * boot (a persisted kill is honored before the first operation) and the seam
 * subscription is live. It registers the `kill` / `unkill` / `kill-status` CLI commands.
 */

import { assertContractCompatible } from "../../core/contracts/index.js";

assertContractCompatible("events", "1.0.0");
assertContractCompatible("substrate", "1.0.0");
assertContractCompatible("identity", "1.1.0");
assertContractCompatible("trust", "1.0.0");

// Side-effect import: registers the kill / unkill / kill-status CLI commands.
import "./cli.js";

export { createKillSwitch, killSwitch, type KillSwitchDeps, type LatchStore } from "./killswitch.js";
export { createKillCli, parseKillArgs, type KillCliDeps } from "./cli.js";
export {
  CONTRACT_VERSION,
  type ClearResult,
  type DegradeOptions,
  type KillCheck,
  type KillCheckFn,
  type KillResult,
  type KillSignal,
  type KillState,
  type KillStatus,
  type KillSwitch,
  type KillTarget,
} from "./contract.js";
export { killSwitchConfig, loadKillSwitchConfig, DEFAULT_LATCH_DIR, LATCH_ID, type KillSwitchConfig } from "./config.js";
export { killswitchEngaged, killswitchRejected, killswitchCleared } from "./events.js";

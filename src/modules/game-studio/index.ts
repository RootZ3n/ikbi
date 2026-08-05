/**
 * ikbi game-studio — module entrypoint.
 *
 * GS-A pins the frozen-core contracts it builds against and registers the
 * `game-studio` CLI command. It performs no filesystem scanning at import time.
 */

import { assertContractCompatible } from "../../core/contracts/index.js";

assertContractCompatible("events", "1.0.0");
assertContractCompatible("substrate", "1.0.0");

// Side-effect import: registers the game-studio CLI command.
import "./cli.js";

export { createGameStudioCli, gameStudioStatus, type GameStudioCliDeps } from "./cli.js";
export { gameStudioConfig, loadGameStudioConfig, DEFAULT_GODOT_PATH, type GameStudioConfig } from "./config.js";
export {
  CONTRACT_VERSION,
  type BrokenReferenceIndicator,
  type ExportPresetInventoryItem,
  type GameStudioStatus,
  type GodotAutoload,
  type GodotInputAction,
  type GodotProjectInspection,
  type GodotProjectSummary,
  type GodotScalar,
  type GodotValue,
  type SceneInventoryItem,
  type ScriptInventoryItem,
} from "./contract.js";
export { GAME_STUDIO_INSPECTED_EVENT } from "./events.js";
export { inspectGodotProject } from "./project-inspector.js";

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
export {
  gameStudioConfig,
  loadGameStudioConfig,
  DEFAULT_ABONULLI_BASE_URL,
  DEFAULT_GODOT_PATH,
  type GameStudioConfig,
} from "./config.js";
export {
  AbonulliClient,
  AbonulliHttpError,
  type AbonulliAnimationJob,
  type AbonulliBeat,
  type AbonulliClientOptions,
  type AbonulliExportArtifact,
  type AbonulliExportRequestResult,
  type AbonulliExportStatus,
  type AbonulliHealth,
  type AbonulliProject,
  type AbonulliSequence,
  type AbonulliShot,
} from "./abonulli-client.js";
export {
  readAndValidateAnimationRequestContract,
  validateAnimationRequestContract,
  validateAnimationResponseContract,
  type AnimationCollisionSuggestion,
  type AnimationContractValidationResult,
  type AnimationEventMarker,
  type AnimationFrameReference,
  type AnimationFrameTiming,
  type AnimationOutputFormat,
  type AnimationRequestContract,
  type AnimationResponseContract,
  type AnimationReviewStatus,
} from "./animation-contracts.js";
export {
  CONTRACT_VERSION,
  type BrokenReferenceIndicator,
  type AnimationPlayerIndicator,
  type ContractValidationResult,
  type ExportPresetInventoryItem,
  type GameBible,
  type GameBibleAssets,
  type GameBibleGap,
  type GameBibleScene,
  type GameBibleSystems,
  type GameFeatureAcceptanceTest,
  type GameFeatureContract,
  type GameFeatureGodotRequirements,
  type GameStudioStatus,
  type GodotAutoload,
  type GodotInputAction,
  type GodotProjectInspection,
  type GodotProjectSummary,
  type GodotScalar,
  type GodotValue,
  type InputUsageIndicator,
  type SceneInventoryItem,
  type ScriptInventoryItem,
  type SignalIndicator,
  type StateMachineIndicator,
} from "./contract.js";
export { GAME_STUDIO_INSPECTED_EVENT } from "./events.js";
export {
  GAME_FEATURE_CONTRACT_SCHEMA,
  readAndValidateGameFeatureContract,
  validateGameFeatureContract,
} from "./feature-contracts.js";
export { generateGameBible, renderGameBibleMarkdown } from "./game-bible.js";
export { inspectGodotProject } from "./project-inspector.js";
export {
  WORM_DEPLOYMENT_BACKFIRE_BEATS,
  WORM_DEPLOYMENT_BACKFIRE_SCENE,
  WORM_DEPLOYMENT_BACKFIRE_SCRIPT,
  renderSliceReport,
  runGameStudioSlice,
  type ProcessResult,
  type SliceDeps,
  type SliceGodotRunEvidence,
  type SliceImplementationContract,
  type SliceRunReport,
} from "./slice.js";

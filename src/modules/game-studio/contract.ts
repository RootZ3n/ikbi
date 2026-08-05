/**
 * ikbi game-studio — module contract.
 *
 * The module is intentionally read-only through GS-B: project inspection, Game
 * Bible generation, and feature-contract validation derive evidence from files
 * without mutating Godot projects.
 */

/** Semantic version of the game-studio contract. Bump on breaking change. */
export const CONTRACT_VERSION = "0.1.0";

export interface GodotProjectSummary {
  readonly path: string;
  readonly exists: boolean;
  readonly configVersion?: number;
  readonly name?: string;
  readonly mainScene?: string;
  readonly features: readonly string[];
  readonly autoloads: readonly GodotAutoload[];
  readonly inputMap: readonly GodotInputAction[];
  readonly display: Readonly<Record<string, GodotScalar>>;
}

export interface GodotAutoload {
  readonly name: string;
  readonly path: string;
  readonly singleton: boolean;
}

export interface GodotInputAction {
  readonly name: string;
  readonly value: GodotValue;
}

export type GodotScalar = string | number | boolean;
export type GodotValue = GodotScalar | readonly string[];

export interface SceneInventoryItem {
  readonly path: string;
  readonly nodeCount: number;
  readonly extResourceCount: number;
  readonly referencedPaths: readonly string[];
}

export interface ScriptInventoryItem {
  readonly path: string;
  readonly lineCount: number;
  readonly className?: string;
  readonly extendsName?: string;
}

export interface ExportPresetInventoryItem {
  readonly index: number;
  readonly name?: string;
  readonly platform?: string;
  readonly runnable?: boolean;
  readonly exportPath?: string;
}

export interface BrokenReferenceIndicator {
  readonly source: string;
  readonly referencedPath: string;
  readonly reason: "missing-resource";
}

export interface GodotProjectInspection {
  readonly module: "game-studio";
  readonly contractVersion: string;
  readonly inspectedAt: string;
  readonly repoPath: string;
  readonly project: GodotProjectSummary;
  readonly scenes: readonly SceneInventoryItem[];
  readonly scripts: readonly ScriptInventoryItem[];
  readonly resources: readonly string[];
  readonly exportPresets: readonly ExportPresetInventoryItem[];
  readonly tests: readonly string[];
  readonly brokenReferences: readonly BrokenReferenceIndicator[];
}

export interface GameStudioStatus {
  readonly module: "game-studio";
  readonly contractVersion: string;
  readonly healthy: boolean;
  readonly godotPath: string;
}

export interface GameBible {
  readonly module: "game-studio";
  readonly contractVersion: string;
  readonly generatedAt: string;
  readonly repoPath: string;
  readonly project: GodotProjectSummary;
  readonly sceneInventory: readonly GameBibleScene[];
  readonly scripts: readonly ScriptInventoryItem[];
  readonly systems: GameBibleSystems;
  readonly assets: GameBibleAssets;
  readonly tests: readonly string[];
  readonly gapAnalysis: readonly GameBibleGap[];
}

export interface GameBibleScene extends SceneInventoryItem {
  readonly rootNodeName?: string;
  readonly rootNodeType?: string;
  readonly nodeTypes: Readonly<Record<string, number>>;
  readonly scriptPaths: readonly string[];
  readonly animationPlayers: readonly string[];
}

export interface GameBibleSystems {
  readonly autoloads: readonly GodotAutoload[];
  readonly stateMachines: readonly StateMachineIndicator[];
  readonly inputActions: readonly GodotInputAction[];
  readonly inputUsage: readonly InputUsageIndicator[];
  readonly signals: readonly SignalIndicator[];
  readonly animationPlayers: readonly AnimationPlayerIndicator[];
}

export interface StateMachineIndicator {
  readonly source: string;
  readonly evidence: readonly string[];
}

export interface InputUsageIndicator {
  readonly action: string;
  readonly sources: readonly string[];
}

export interface SignalIndicator {
  readonly source: string;
  readonly name: string;
  readonly kind: "declared" | "emitted" | "connected";
}

export interface AnimationPlayerIndicator {
  readonly scene: string;
  readonly nodeName: string;
}

export interface GameBibleAssets {
  readonly total: number;
  readonly byType: Readonly<Record<string, number>>;
  readonly paths: readonly string[];
}

export interface GameBibleGap {
  readonly severity: "info" | "warning" | "error";
  readonly area: "project" | "scene" | "script" | "asset" | "test" | "system";
  readonly message: string;
  readonly evidence: readonly string[];
}

export interface GameFeatureContract {
  readonly id: string;
  readonly title?: string;
  readonly player_experience: readonly string[];
  readonly godot_requirements: GameFeatureGodotRequirements;
  readonly acceptance_tests: readonly GameFeatureAcceptanceTest[];
}

export interface GameFeatureGodotRequirements {
  readonly scene_type?: string;
  readonly signals?: readonly string[];
  readonly persistence_key?: string;
  readonly required_assets?: readonly string[];
  readonly input_actions?: readonly string[];
  readonly scripts?: readonly string[];
}

export interface GameFeatureAcceptanceTest {
  readonly name: string;
  readonly steps: readonly string[];
  readonly expected: string;
}

export interface ContractValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

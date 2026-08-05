/**
 * ikbi game-studio — module contract.
 *
 * GS-A is intentionally read-only: a module skeleton, CLI surface, and Godot
 * project inspector. Later phases can add game-bible, feature-contracts,
 * playtest, exporters, and UI contracts without changing this initial surface.
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

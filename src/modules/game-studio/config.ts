/**
 * ikbi game-studio — module-owned config slice.
 *
 *   IKBI_GAME_STUDIO_GODOT_PATH  Godot executable path/name for future run/export
 *                                phases. GS-A only reports this value; the inspector
 *                                never executes it.
 */

import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("game-studio");

export const DEFAULT_GODOT_PATH = "godot";

export interface GameStudioConfig {
  readonly godotPath: string;
}

export function loadGameStudioConfig(reader = env): GameStudioConfig {
  return Object.freeze({
    godotPath: reader.str("GODOT_PATH", DEFAULT_GODOT_PATH),
  });
}

export const gameStudioConfig: GameStudioConfig = loadGameStudioConfig();

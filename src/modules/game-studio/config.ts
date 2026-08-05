/**
 * ikbi game-studio — module-owned config slice.
 *
 *   IKBI_GAME_STUDIO_GODOT_PATH          Godot executable path/name for future run/export
 *                                        phases. The inspector never executes it.
 *   IKBI_GAME_STUDIO_ABONULLI_BASE_URL   Abonulli API base URL for animation requests.
 */

import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("game-studio");

export const DEFAULT_GODOT_PATH = "godot";
export const DEFAULT_ABONULLI_BASE_URL = "http://127.0.0.1:8000";

export interface GameStudioConfig {
  readonly godotPath: string;
  readonly abonulliBaseUrl: string;
}

export function loadGameStudioConfig(reader = env): GameStudioConfig {
  return Object.freeze({
    godotPath: reader.str("GODOT_PATH", DEFAULT_GODOT_PATH),
    abonulliBaseUrl: reader.str("ABONULLI_BASE_URL", DEFAULT_ABONULLI_BASE_URL),
  });
}

export const gameStudioConfig: GameStudioConfig = loadGameStudioConfig();

/**
 * ikbi game-studio — module-owned config slice.
 *
 *   IKBI_GAME_STUDIO_GODOT_PATH          Godot executable path/name for future run/export
 *                                        phases. The inspector never executes it.
 *   IKBI_GAME_STUDIO_ABONULLI_BASE_URL   Abonulli API base URL for animation requests.
 *   IKBI_GAME_STUDIO_SCREENSHOT_PATH     Where the headless run writes its PNG. Absent ⇒ a durable
 *                                        per-run file under ikbi's state root. NEVER a temp
 *                                        directory: the report names this path and a reader goes
 *                                        and looks at it, so it has to still be there.
 */

import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("game-studio");

export const DEFAULT_GODOT_PATH = "godot";
export const DEFAULT_ABONULLI_BASE_URL = "http://127.0.0.1:8000";

export interface GameStudioConfig {
  readonly godotPath: string;
  readonly abonulliBaseUrl: string;
  /** Operator override for the screenshot destination. Absent ⇒ the state-root default. */
  readonly screenshotPath: string | undefined;
}

export function loadGameStudioConfig(reader = env): GameStudioConfig {
  return Object.freeze({
    godotPath: reader.str("GODOT_PATH", DEFAULT_GODOT_PATH),
    abonulliBaseUrl: reader.str("ABONULLI_BASE_URL", DEFAULT_ABONULLI_BASE_URL),
    screenshotPath: (() => {
      const raw = reader.str("SCREENSHOT_PATH", "").trim();
      return raw.length > 0 ? raw : undefined;
    })(),
  });
}

export const gameStudioConfig: GameStudioConfig = loadGameStudioConfig();

/**
 * ikbi worker-model — config-driven role model ids.
 *
 * The model-driven roles (scout, builder → DRIVER tier; critic → CRITIC tier) resolve
 * their logical roster model id from config (`config.provider.defaultModels`, fed by
 * IKBI_MODEL_DRIVER / IKBI_MODEL_CRITIC) instead of a hardcoded constant. The config
 * defaults equal the historical constants ("mimo-v2.5" / "mimo-v2.5-pro"), so default
 * behavior is identical — but an operator can repoint the roles at a different model
 * without aliasing it in the roster.
 *
 * The id is a LOGICAL roster name (resolved downstream by providers.json) — this only
 * changes WHICH id the role passes, never the roster resolution or the provider contract.
 *
 * `cfg` is injectable for tests (build a custom config via `loadConfig({...})`); it
 * defaults to the process-wide config singleton, matching how other config is read.
 */

import { config, type IkbiConfig } from "../../core/config.js";

/** The DRIVER-tier model id (scout + builder). */
export function driverModel(cfg: IkbiConfig = config): string {
  return cfg.provider.defaultModels.driver;
}

/** The CRITIC-tier model id (critic). */
export function criticModel(cfg: IkbiConfig = config): string {
  return cfg.provider.defaultModels.critic;
}

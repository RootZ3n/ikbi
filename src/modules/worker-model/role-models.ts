/**
 * ikbi worker-model — config-driven role model ids.
 *
 * Each model-driven role resolves its logical roster model id from config
 * (`config.provider.defaultModels`) instead of a hardcoded constant:
 *   - scout  → driver  (IKBI_MODEL_DRIVER)
 *   - builder → builder (IKBI_MODEL_BUILDER, falls through to driver when unset)
 *   - critic → critic  (IKBI_MODEL_CRITIC)
 * The config defaults equal the historical constants, so default behavior is identical —
 * but an operator can repoint a role at a different model without aliasing it in the roster.
 * `competitiveBuilderModels` is the optional head-to-head list (IKBI_COMPETITIVE_MODELS)
 * competitive mode races one candidate per listed model.
 *
 * The id is a LOGICAL roster name (resolved downstream by providers.json) — this only
 * changes WHICH id the role passes, never the roster resolution or the provider contract.
 *
 * `cfg` is injectable for tests (build a custom config via `loadConfig({...})`); it
 * defaults to the process-wide config singleton, matching how other config is read.
 */

import { config, type IkbiConfig } from "../../core/config.js";

/** The DRIVER-tier model id (scout). */
export function driverModel(cfg: IkbiConfig = config): string {
  return cfg.provider.defaultModels.driver;
}

/** The BUILDER model id (defaults to the driver when IKBI_MODEL_BUILDER is unset). */
export function builderModel(cfg: IkbiConfig = config): string {
  return cfg.provider.defaultModels.builder;
}

/** The CRITIC-tier model id (critic). */
export function criticModel(cfg: IkbiConfig = config): string {
  return cfg.provider.defaultModels.critic;
}

/**
 * The REFUTER-tier model id. The refuter's adversarial semantic spec-match reuses the
 * CRITIC model id (both are strict, low-temperature judgment roles); resolving it through
 * its own seam lets an operator repoint the refuter independently later without a roster alias.
 */
export function refuterModel(cfg: IkbiConfig = config): string {
  return cfg.provider.defaultModels.critic;
}

/** The head-to-head competitive model list (IKBI_COMPETITIVE_MODELS), or undefined if unset. */
export function competitiveBuilderModels(cfg: IkbiConfig = config): readonly string[] | undefined {
  return cfg.provider.defaultModels.competitiveModels;
}

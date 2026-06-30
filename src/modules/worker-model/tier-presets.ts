/**
 * ikbi worker-model — BUILD TIER PRESETS (`ikbi build --tier <name>`).
 *
 * A tier is a one-flag preset that pins the builder + critic models for a run AND decides
 * whether the orchestrator's auto-escalation (the cheap → mid retry, see orchestrator.ts'
 * BUILD-MODE ESCALATION RETRY block) is allowed to fire. The three presets:
 *
 *   --tier cheap     builder deepseek-v4-flash · critic deepseek-v4-pro · escalation ON
 *                    The cheap tier is the design point of ikbi: a weak builder backed by
 *                    evidence-based verification and an automatic escalation to a stronger
 *                    model when it fails. `fallbackModel` aims the escalation at the pro model.
 *   --tier mid       builder glm-5.2     · critic minimax-m3 · escalation OFF
 *   --tier frontier  builder sonnet-4.6  · critic gpt-5.5     · escalation OFF
 *
 * Mid and frontier run a single, capable builder and FAIL CLOSED if it can't satisfy the
 * pipeline — they never SILENTLY swap in a different (and differently-priced) model behind the
 * operator's back. Escalation is a cheap-tier affordance, not a universal default.
 *
 * The preset only chooses WHICH model ids each role passes; the ids are LOGICAL roster names
 * resolved downstream by providers.json (all six are mapped in state/providers.json). This
 * module never resolves a provider or makes a model call — it is a pure lookup.
 *
 * Presets are explicit, not env-driven: `--tier` is meant to be a stable, documented contract
 * an operator can rely on. A run can still override a single role with `--fallback-model` (the
 * escalation target) without abandoning the tier.
 */

/** The selectable build tiers. */
export type BuildTier = "cheap" | "mid" | "frontier";

/** A resolved tier preset: the role models + whether auto-escalation is permitted. */
export interface TierPreset {
  readonly tier: BuildTier;
  /** Model id for the builder role. */
  readonly builderModel: string;
  /** Model id for the critic role. */
  readonly criticModel: string;
  /** Whether the orchestrator may auto-escalate a failed builder to a stronger model. */
  readonly escalation: boolean;
  /**
   * When escalation is ON, the model the failed builder escalates TO. Absent for tiers with
   * escalation OFF. An explicit `--fallback-model` overrides this.
   */
  readonly fallbackModel?: string;
}

/** The canonical, documented tier presets. */
export const TIER_PRESETS: Readonly<Record<BuildTier, TierPreset>> = Object.freeze({
  cheap: Object.freeze({
    tier: "cheap",
    builderModel: "deepseek-v4-flash",
    criticModel: "deepseek-v4-pro",
    escalation: true,
    fallbackModel: "mimo-v2.5-pro",
  }),
  mid: Object.freeze({
    tier: "mid",
    builderModel: "glm-5.2",
    criticModel: "minimax-m3",
    escalation: false,
  }),
  frontier: Object.freeze({
    tier: "frontier",
    builderModel: "sonnet-4.6",
    criticModel: "gpt-5.5",
    escalation: false,
  }),
});

/** The valid tier names, in cheapest-first order (for help text + validation messages). */
export const BUILD_TIERS: readonly BuildTier[] = Object.freeze(["cheap", "mid", "frontier"]);

/** True when `raw` names a known build tier. */
export function isBuildTier(raw: string): raw is BuildTier {
  return raw === "cheap" || raw === "mid" || raw === "frontier";
}

/** Resolve a tier name to its preset, or undefined when `raw` is not a known tier. */
export function resolveTierPreset(raw: string): TierPreset | undefined {
  return isBuildTier(raw) ? TIER_PRESETS[raw] : undefined;
}

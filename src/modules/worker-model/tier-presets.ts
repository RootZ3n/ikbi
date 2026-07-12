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
  /**
   * CANDIDATE TOURNAMENT models. When present (cheap tier), the build races these models
   * INDEPENDENTLY, the deterministic-judge scores every verified candidate, the winner's diff is
   * replayed into a clean shadow workspace + re-verified, and only then does the critic/adjudication
   * promote path run. This is how the cheap tier engages the FULL system (tournament + judge +
   * shadow verification) rather than a lone builder — a weak candidate that over-produces or drifts
   * from the goal loses to a tighter one on the judge's objective score. Absent ⇒ single-builder path.
   */
  readonly candidates?: readonly string[];
  /**
   * MIXTURE OF EXPERTS: when true (cheap tier), the build runs as a coordinated 4-model pool —
   * each sub-task RENTS the cheapest-sufficient expert by difficulty (see expert-rental.ts) rather
   * than pinning one fixed builder. The tier's `builderModel` becomes the typical/floor expert the
   * rental resolves to for mechanical work; harder sub-tasks rent up to the mid roster. mid/frontier
   * leave this unset — they run a single, explicitly-chosen capable builder.
   */
  readonly moe?: boolean;
}

/** The canonical, documented tier presets. */
export const TIER_PRESETS: Readonly<Record<BuildTier, TierPreset>> = Object.freeze({
  cheap: Object.freeze({
    tier: "cheap",
    builderModel: "deepseek-v4-flash",
    criticModel: "deepseek-v4-pro",
    escalation: true,
    fallbackModel: "mimo-v2.5-pro",
    // The cheap tier is a 4-model MIXTURE OF EXPERTS: a coordinator rents the cheapest-sufficient
    // expert per sub-task (worker roster for mechanical work, mid roster for reasoning), all
    // collaborating on ONE workspace. NOT a candidate tournament that races and discards losers
    // (`candidates` left unset — tournament stays an explicit IKBI_CANDIDATE_MODELS opt-in), and
    // NOT a lone builder with an escalation ladder. `builderModel` above is the typical/floor expert.
    moe: true,
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

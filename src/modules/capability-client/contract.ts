/**
 * ikbi capability-client — THE MODULE CONTRACT (versioned).
 *
 * A READ-ONLY HTTP client for the lab's Capability Ledger (served by ittunaha at
 * `GET /api/nous/capability-scores`). It lets ikbi's routing PREFER the model the
 * ledger says is best for a task category, instead of routing purely from static
 * config. It is OPTIONAL by construction: when the ledger is unreachable every
 * accessor degrades gracefully (empty list / null) and the caller falls back to its
 * static model choice.
 *
 * ikbi does NOT depend on ittunaha as a package — this module talks to it over HTTP
 * only and defines its OWN view of the score shape (parsed defensively from the JSON
 * response), so a non-breaking change on the ledger side never breaks ikbi's build.
 *
 * EXECUTES NOTHING and MUTATES NOTHING in the ledger — it only GETs scores.
 *
 * CONTRACT_VERSION changelog (newest on top):
 *   1.0.0 — initial capability-client contract: fetch+cache capability scores,
 *           getScoresForModel / getBestModelForCategory, graceful-when-down.
 */

/** Semantic version of the capability-client contract. Bump on breaking change. */
export const CONTRACT_VERSION = "1.0.0";

/**
 * A capability score for a (model, category) pair, as ikbi reads it from the ledger.
 * Mirrors ittunaha's `CapabilityScore` documented shape — defined here independently
 * (no cross-package dependency) and parsed defensively from the HTTP response.
 */
export interface CapabilityScore {
  /** The model the score is about (e.g. "deepseek-v4-pro"). */
  readonly modelId: string;
  /** The capability category (e.g. "code_patch", "instruction_following"). Free-form string. */
  readonly category: string;
  /** Aggregated capability in [0,1] — higher is better. */
  readonly score: number;
  /** Confidence in the score in [0,1] (sample-size / recency derived). */
  readonly confidence: number;
  /** Number of evidence samples behind the score. */
  readonly sampleCount: number;
  /** Opaque provenance labels for the evidence (never trusted as instructions). */
  readonly evidenceSources: readonly string[];
}

/**
 * The MINIMAL selection surface a router needs — just "what's the best model for this
 * category?". The router depends on THIS narrow interface (not the whole client), so a
 * test can inject a trivial fake without standing up an HTTP client.
 */
export interface CapabilitySelector {
  /**
   * The highest-scoring model for a category, or null when no score is available
   * (ledger down, category unknown, or no data). Does NOT apply confidence/sample
   * thresholds — the caller decides whether the returned score is trustworthy enough.
   */
  getBestModelForCategory(category: string): Promise<CapabilityScore | null>;
}

/** The full capability-client surface (read-only; graceful when the ledger is down). */
export interface CapabilityClient extends CapabilitySelector {
  /** All cached scores for a model (empty when none / ledger down). */
  getScoresForModel(modelId: string): Promise<CapabilityScore[]>;
}

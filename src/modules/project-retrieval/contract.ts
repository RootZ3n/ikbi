/**
 * ikbi project-retrieval — contract types.
 *
 * DETERMINISTIC, model-free relevance retrieval over the project-index. Given a goal + optional
 * seeds + a byte budget, it returns a ranked, reason-tagged set of context files (with a "why
 * selected" note per file) — the replacement for scout's blind 40-file traversal sample.
 *
 * @status dormant (library-only); scout consumes it ONLY behind IKBI_RETRIEVAL=index.
 */

import type { ReasonTag } from "../project-index/index.js";

/** Retrieval reasons: the project-index graph reasons PLUS retrieval-level selection reasons. */
export type RetrievalReason =
  | ReasonTag // imported-by-seed | imports-seed | test-of-seed | same-package | name-match | seed
  | "goal-path-match" // a path/filename named in the goal
  | "goal-name-match" // basename stem matches a goal term
  | "project-rules" // CLAUDE.md / AGENTS.md
  | "package-manifest"; // package.json / tsconfig.json for a relevant package

export interface RetrievalRequest {
  /** Repo to retrieve over (the index is built/refreshed for it). */
  readonly repoPath: string;
  /** The build/repair goal text — seeds are mined from it. */
  readonly goal: string;
  /** Optional explicit seed paths or terms (augment the goal-mined seeds). */
  readonly seeds?: readonly string[];
  /** Total selection budget in bytes (per-file cost is min(size, perFileCapBytes)). */
  readonly budgetBytes?: number;
  /** Per-file cost cap used for budget accounting (mirrors how the consumer truncates each file). */
  readonly perFileCapBytes?: number;
  /** Hard cap on the number of files returned. */
  readonly maxFiles?: number;
}

/** One selected context file. */
export interface SelectedFile {
  /** Repo-relative POSIX path. */
  readonly path: string;
  /** File size in bytes (from the index). */
  readonly bytes: number;
  /** Relevance score (sum of reason weights). */
  readonly score: number;
  readonly reasons: readonly RetrievalReason[];
  /** Human-readable "why selected" receipt. */
  readonly why: string;
}

export interface RetrievalResult {
  /** Always "index" — this module IS the index-backed path; the caller owns any legacy fallback. */
  readonly mode: "index";
  /** Ranked selection (project-rules first, then by score), trimmed to the budget. */
  readonly files: readonly SelectedFile[];
  /** The resolved seed files the selection expanded from. */
  readonly seeds: readonly string[];
  /** Sum of per-file budget cost of the selection. */
  readonly totalBytes: number;
  /** True when files were dropped to stay within budget / maxFiles. */
  readonly truncatedByBudget: boolean;
  /** True when the retrieved context is NOT trustworthy as exhaustive (incomplete index, no seeds
   *  on a large repo, or tiny coverage) — the caller must require full verification, not assume enough. */
  readonly lowConfidence: boolean;
  /** Why confidence is low (present only when lowConfidence). */
  readonly lowConfidenceReason?: string;
  /** Decision trail (overall "why"): seeds found, expansion, rules, budget outcome. */
  readonly receipts: readonly string[];
}

export interface ProjectRetrievalApi {
  retrieve(req: RetrievalRequest): Promise<RetrievalResult>;
}

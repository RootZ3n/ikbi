/**
 * ikbi deterministic-judge — THE MODULE CONTRACT (versioned).
 *
 * An OBJECTIVE, REPRODUCIBLE judge that picks the best of N build candidates with
 * NO model call. This is the mechanism that makes cheap models trustworthy: a test
 * suite + objective signals decide the winner, never an LLM opinion. It is a PURE
 * function of its inputs — no model, network, fs, or workspace access — so the SAME
 * candidates always yield the SAME verdict.
 *
 * TWO LAYERS, in order (design derived from the proven Luak judging pattern — the
 * STRUCTURE is carried, the code is a clean ikbi rebuild):
 *   LAYER 1 — OVERRIDES (hard-fail, checked FIRST, before any scoring): a candidate
 *     that trips ANY override is REJECTED outright, regardless of what it would
 *     score. Overrides are a first-class, pluggable list — not hardcoded ifs.
 *   LAYER 2 — WEIGHTED SCORE (only for candidates that survived all overrides): a
 *     weighted sum of normalized 0..1 signal scores. Ranks the survivors.
 * Then: winner = highest composite among survivors; explicit deterministic tie-break;
 * if NO candidate survives → fail-closed (winner null), promote nothing.
 *
 * The judge scores ALREADY-CAPTURED objective facts (a BuildCandidate) — it does NOT
 * run tests or reach into workspaces itself. Engine-generic: it scores any candidates.
 *
 * No frozen-core change.
 *
 * CONTRACT_VERSION changelog (newest on top):
 *   1.0.0 — initial deterministic-judge contract: BuildCandidate + JudgeResult and
 *           the pluggable override/family tables. Two-layer override-then-weighted,
 *           explicit deterministic tie-break, fail-closed no-pass. No model call.
 */

/** Semantic version of the deterministic-judge contract. Bump on breaking change. */
export const CONTRACT_VERSION = "1.0.0";

/**
 * The objective, already-captured result of ONE build attempt. The orchestrator /
 * verifier produce these facts; the judge only scores them (pure).
 */
export interface BuildCandidate {
  /** Which workspace this build ran in (the candidate's stable id). */
  readonly workspaceId: string;
  /** Verifier `tsc --noEmit` exit 0. */
  readonly typecheckPass: boolean;
  /** Verifier `pnpm test` exit 0. */
  readonly testsPass: boolean;
  /** Parsed test tallies, when the verifier output yielded them. */
  readonly testCount?: { readonly passed: number; readonly total: number };
  /** Builder tool-call rounds used. */
  readonly toolRounds: number;
  /** The configured tool-round ceiling (to normalize efficiency). */
  readonly maxToolRounds: number;
  /** How many tool calls the builder attempted that were rejected (out-of-policy). */
  readonly rejectedToolCalls: number;
  /** How many files the builder wrote. */
  readonly filesWritten: number;
  /** Lines changed (from the workspace diff), when available. */
  readonly diffLines?: number;
  /** Why the builder loop stopped ("stop" | "max_iterations" | "timeout" | "length"). */
  readonly stopReason: string;
}

/** A hard-fail override: a candidate tripping it is disqualified BEFORE scoring. */
export interface JudgeOverride {
  readonly id: string;
  readonly label: string;
  /** True ⇒ this candidate is disqualified outright. */
  disqualifies(candidate: BuildCandidate): boolean;
  /** Human/audit reason (only read when `disqualifies` is true). */
  reason(candidate: BuildCandidate): string;
}

/** A weighted signal family scored among survivors. */
export interface JudgeFamily {
  readonly id: string;
  readonly label: string;
  /** Weight in the composite (the family set's weights sum to 1.0). */
  readonly weight: number;
  /** Normalized score in [0,1] (higher = better). */
  score(candidate: BuildCandidate): number;
}

/** Per-candidate outcome in the ranking (full transparency for the audit trail). */
export interface CandidateVerdict {
  readonly workspaceId: string;
  readonly disqualified: boolean;
  /** Set when disqualified — which override + why. */
  readonly overrideReason?: string;
  /** Composite score in [0,1] (survivors only). */
  readonly composite?: number;
  /** Per-family normalized scores (survivors only). */
  readonly familyScores?: Readonly<Record<string, number>>;
}

/** The judge verdict. `winner` is null when every candidate is disqualified. */
export interface JudgeResult {
  readonly winner: { readonly workspaceId: string; readonly composite: number } | null;
  /** True when ALL candidates tripped an override (fail-closed — promote nothing). */
  readonly rejectedAll: boolean;
  /** Human reason on a no-pass / empty input. */
  readonly reason?: string;
  /** Every candidate's outcome, ranked best-first (survivors) then disqualified. */
  readonly ranking: readonly CandidateVerdict[];
}

/** The deterministic-judge surface. */
export interface DeterministicJudge {
  /** Score N candidates: overrides → weighted survivors → winner (or null). Pure. */
  judge(candidates: readonly BuildCandidate[]): JudgeResult;
}

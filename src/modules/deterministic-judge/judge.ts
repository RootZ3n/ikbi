/**
 * ikbi deterministic-judge — the pure two-layer judge (overrides → weighted score).
 *
 * PURE: `judge()` reads only its candidate inputs + config. NO model call, NO
 * network, NO fs, NO workspace access. Identical inputs ⇒ identical verdict.
 *
 * LAYER 1 (overrides) runs FIRST: any candidate tripping an override is disqualified
 * before scoring — a hard-fail can NEVER be outscored (the Luak rule). LAYER 2
 * (weighted families) ranks the survivors. Winner = best composite, broken by an
 * EXPLICIT deterministic tie-break. No survivor ⇒ fail-closed (winner null).
 */

import { events as coreEvents } from "../../core/events/index.js";
import type { EventInput } from "../../core/events/index.js";
import {
  deterministicJudgeConfig,
  FAMILY_WEIGHTS,
  TIE_EPSILON,
  type DeterministicJudgeConfig,
} from "./config.js";
import { judgeEvaluated, type JudgeEventPayload } from "./events.js";
import type {
  BuildCandidate,
  CandidateVerdict,
  DeterministicJudge,
  JudgeFamily,
  JudgeOverride,
  JudgeResult,
} from "./contract.js";

const EVENT_SOURCE = "deterministic-judge";

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** The tests-family score (also the primary tie-breaker). Survivors already passed the gate. */
function testsScore(c: BuildCandidate): number {
  if (c.testCount !== undefined && c.testCount.total > 0) return clamp01(c.testCount.passed / c.testCount.total);
  return 1.0; // a survivor passed the tests-gate; no parsed count ⇒ full marks
}

/**
 * The DEFAULT hard-fail overrides (LAYER 1). A pluggable table — extend by passing
 * `overrides: [...defaultOverrides(), myOverride]` to the factory. Order is the
 * check order; the FIRST tripped override is the reported reason.
 */
export function defaultOverrides(): JudgeOverride[] {
  return [
    {
      id: "typecheck",
      label: "typecheck",
      disqualifies: (c) => c.typecheckPass === false,
      reason: () => "typecheck failed (tsc --noEmit non-zero) — a build that does not compile cannot win",
    },
    {
      id: "tests",
      label: "tests",
      disqualifies: (c) => c.testsPass === false,
      reason: () => "tests failed (pnpm test non-zero) — failing tests are worthless",
    },
    {
      id: "rejected-tool-calls",
      label: "rejected-tool-calls",
      disqualifies: (c) => c.rejectedToolCalls > 0,
      reason: (c) => `${c.rejectedToolCalls} rejected tool call(s) — attempted out-of-policy action`,
    },
  ];
}

/**
 * The DEFAULT weighted families (LAYER 2). Weights are fixed constants summing to
 * 1.0. A pluggable table — extend/replace via the factory.
 */
export function defaultFamilies(config: DeterministicJudgeConfig): JudgeFamily[] {
  return [
    { id: "tests", label: "tests", weight: FAMILY_WEIGHTS.tests, score: testsScore },
    {
      id: "efficiency",
      label: "efficiency",
      weight: FAMILY_WEIGHTS.efficiency,
      score: (c) => 1 - clamp01(c.toolRounds / (c.maxToolRounds > 0 ? c.maxToolRounds : 1)),
    },
    {
      id: "diff",
      label: "diff",
      weight: FAMILY_WEIGHTS.diff,
      // Unknown diff is NEUTRAL (0.5) — a missing diff neither punishes nor rewards.
      score: (c) => (c.diffLines !== undefined ? 1 - clamp01(c.diffLines / config.maxDiffLines) : 0.5),
    },
    {
      id: "files",
      label: "files",
      weight: FAMILY_WEIGHTS.files,
      score: (c) => 1 - clamp01(c.filesWritten / config.maxFiles),
    },
    {
      id: "convergence",
      label: "convergence",
      weight: FAMILY_WEIGHTS.convergence,
      score: (c) => (c.stopReason === "stop" ? 1.0 : c.stopReason === "max_iterations" ? 0.4 : 0.0),
    },
  ];
}

/** Injectable dependencies. The judge needs no live singletons beyond an event sink. */
export interface DeterministicJudgeDeps {
  readonly config?: DeterministicJudgeConfig;
  /** Override the override table (extend via `[...defaultOverrides(), x]`). */
  readonly overrides?: readonly JudgeOverride[];
  /** Override the family table (extend via `[...defaultFamilies(cfg), x]`). */
  readonly families?: readonly JudgeFamily[];
  readonly publish?: (input: EventInput<JudgeEventPayload>) => void;
}

/** A fully-evaluated survivor (carries the tie-break keys). */
interface Scored {
  readonly c: BuildCandidate;
  readonly composite: number;
  readonly familyScores: Record<string, number>;
  readonly testsScore: number;
}

/** Build a deterministic judge. Defaults wire the standard overrides + families. */
export function createDeterministicJudge(deps: DeterministicJudgeDeps = {}): DeterministicJudge {
  const config = deps.config ?? deterministicJudgeConfig;
  const overrides = deps.overrides ?? defaultOverrides();
  const families = deps.families ?? defaultFamilies(config);
  const publish = deps.publish ?? ((input: EventInput<JudgeEventPayload>) => void coreEvents.publish(input));

  /** Returns true when `a` ranks STRICTLY better than `b` (the deterministic order). */
  function better(a: Scored, b: Scored): boolean {
    if (Math.abs(a.composite - b.composite) > TIE_EPSILON) return a.composite > b.composite;
    // Tie-break, in order: tests score (desc) → toolRounds (asc) → diffLines (asc) →
    // workspaceId (lexically smallest). The last guarantees a stable, identical winner.
    if (a.testsScore !== b.testsScore) return a.testsScore > b.testsScore;
    if (a.c.toolRounds !== b.c.toolRounds) return a.c.toolRounds < b.c.toolRounds;
    const ad = a.c.diffLines ?? Number.POSITIVE_INFINITY;
    const bd = b.c.diffLines ?? Number.POSITIVE_INFINITY;
    if (ad !== bd) return ad < bd;
    return a.c.workspaceId < b.c.workspaceId;
  }

  function judge(candidates: readonly BuildCandidate[]): JudgeResult {
    const survivors: Scored[] = [];
    const disqualified: CandidateVerdict[] = [];

    for (const c of candidates) {
      // LAYER 1 — overrides FIRST. The first tripped override is the reason.
      const trip = overrides.find((o) => o.disqualifies(c));
      if (trip !== undefined) {
        disqualified.push({ workspaceId: c.workspaceId, disqualified: true, overrideReason: `${trip.label}: ${trip.reason(c)}` });
        continue;
      }
      // LAYER 2 — weighted composite among survivors.
      const familyScores: Record<string, number> = {};
      let composite = 0;
      for (const f of families) {
        const s = clamp01(f.score(c));
        familyScores[f.id] = s;
        composite += f.weight * s;
      }
      survivors.push({ c, composite, familyScores, testsScore: testsScore(c) });
    }

    // Rank survivors best-first (deterministic), then disqualified by workspaceId.
    const rankedSurvivors = [...survivors].sort((x, y) => (better(x, y) ? -1 : better(y, x) ? 1 : 0));
    const disqualifiedSorted = [...disqualified].sort((x, y) => (x.workspaceId < y.workspaceId ? -1 : x.workspaceId > y.workspaceId ? 1 : 0));

    const ranking: CandidateVerdict[] = [
      ...rankedSurvivors.map((s) => ({ workspaceId: s.c.workspaceId, disqualified: false, composite: s.composite, familyScores: { ...s.familyScores } })),
      ...disqualifiedSorted,
    ];

    let result: JudgeResult;
    if (survivors.length === 0) {
      result = {
        winner: null,
        rejectedAll: true,
        reason: candidates.length === 0 ? "no candidates to judge" : `all ${candidates.length} candidate(s) disqualified`,
        ranking,
      };
    } else {
      const top = rankedSurvivors[0]!;
      result = { winner: { workspaceId: top.c.workspaceId, composite: top.composite }, rejectedAll: false, ranking };
    }

    publish(judgeEvaluated.create({ candidateCount: candidates.length, winnerWorkspaceId: result.winner?.workspaceId ?? null, rejectedAll: result.rejectedAll }, { source: EVENT_SOURCE }));
    return result;
  }

  return { judge };
}

/** The default process-wide deterministic judge. */
export const deterministicJudge: DeterministicJudge = createDeterministicJudge();

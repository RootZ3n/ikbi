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
 *
 * ADMISSIBILITY (Codex C3): the overrides include a test-evidence gate — only a candidate with a
 * REAL executed suite is admissible; zero/unverified/absent evidence is disqualified, not down-ranked.
 * The judge RANKS admissible candidates; it does NOT grant promotability. Its `winner` is a ranking,
 * never a promote authorization — the winner still passes through the adjudication core (executed +
 * tree-bound) and the hash-bound promote gate before anything lands.
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

/**
 * Tests-family confidence for a NON-executed test signal (Finding D). A survivor that did not
 * run a real test suite still survives the gate (it didn't FAIL), but it must NOT earn the same
 * tests-confidence as a real executed suite. Distinct, deterministic, strictly below 1.0:
 *   unverified (passed, no count — e.g. `echo done`)  > absent (no test check, only custom checks)
 *   > zero (a runner that executed zero tests). All below a real "executed" suite's count ratio.
 */
const TEST_EVIDENCE_SCORE: Readonly<Record<"zero" | "unverified" | "absent", number>> = Object.freeze({
  unverified: 0.5,
  absent: 0.35,
  zero: 0.1,
});

/** The tests-family score (also the primary tie-breaker). Survivors already passed the gate. */
function testsScore(c: BuildCandidate): number {
  // Finding D: when execution evidence is present, it decides confidence — a real executed suite
  // (count ratio) ranks strictly above zero-test / unparseable / no-test-check signals.
  if (c.testEvidence !== undefined && c.testEvidence !== "executed") {
    return TEST_EVIDENCE_SCORE[c.testEvidence];
  }
  if (c.testCount !== undefined && c.testCount.total > 0) return clamp01(c.testCount.passed / c.testCount.total);
  // Back-compat: no evidence + no parsed count ⇒ full marks (a survivor passed the tests-gate).
  // With evidence "executed" but no count this also yields 1.0 (a runner that ran but we trust the pass).
  return 1.0;
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
      // C3 — ADMISSIBILITY: only a REAL executed suite can win. A candidate whose tests did not
      // actually run (a runner that executed ZERO tests / a pass with no parseable count / no test
      // check at all) has NOT earned promotable confidence, so it is DISQUALIFIED outright — never
      // merely down-ranked. This is what stops a competitive/tournament shootout from crowning a
      // vacuous-green candidate over one with real executed evidence (the judge ranks only admissible
      // candidates; it never launders non-executed work into a promotable winner). `undefined`
      // testEvidence (a legacy candidate predating evidence capture) is left to the prior
      // testCount-driven scoring — back-compat, unchanged. Mirrors the adjudication core's I6 gate.
      id: "test-evidence",
      label: "test-evidence",
      disqualifies: (c) => c.testEvidence === "zero" || c.testEvidence === "unverified" || c.testEvidence === "absent",
      reason: (c) => `test evidence "${c.testEvidence}" is not an executed suite — only a real executed test run is admissible (no vacuous-green winner)`,
    },
    // NB: rejected (PREVENTED) tool calls are NOT a disqualifier. Judge by effect, not intent — a
    // rejected call was BLOCKED by the governor (no effect), so it is a recorded warning + a mild
    // RANKING penalty (see the `better` tie-break: fewer rejected calls wins a tie), not grounds to
    // discard a candidate the verifier passed. Discarding a verified-green candidate over a prevented
    // attempt measures obedience, not engineering — and would let a flukier-but-timid candidate beat a
    // stronger one that merely improvised a blocked command. Only EFFECTIVE breaches (control failures
    // that landed) would disqualify, and those never appear as a rejected tool call.
    {
      id: "no-work",
      label: "no-work",
      // A candidate that wrote 0 files AND produced 0 (or unknown) diff did NO work. Without this it
      // would MAX the files+diff families (0/max ⇒ score 1.0) and — on a repo that is already green —
      // inherit testsPass/typecheckPass from the untouched base, letting a do-nothing candidate OUTSCORE
      // and DISCARD candidates with real, verified changes. A shootout must never crown a no-op.
      disqualifies: (c) => c.filesWritten === 0 && (c.diffLines ?? 0) === 0,
      reason: () => "no work produced (0 files written, 0 diff) — a do-nothing candidate cannot win",
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
    // A candidate with FEWER prevented (rejected) tool calls wins a tie — the "additive taint" ranking
    // signal (cleaner conduct is preferred), without disqualifying a verified candidate that improvised
    // a blocked command.
    if (a.c.rejectedToolCalls !== b.c.rejectedToolCalls) return a.c.rejectedToolCalls < b.c.rejectedToolCalls;
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

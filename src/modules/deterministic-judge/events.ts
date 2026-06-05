/**
 * ikbi deterministic-judge — its events (namespaced `judge.*` per module plan ## 8).
 *
 * Published with `source: "deterministic-judge"`. Payload carries COUNTS + the winner
 * id only — never the full per-candidate scores/detail (the JudgeResult.ranking is the
 * place for that; the orchestrator records it on the receipt).
 */

import { defineEvent } from "../../core/events/index.js";

/** Payload for a judged evaluation. */
export interface JudgeEventPayload {
  /** How many candidates were judged. */
  readonly candidateCount: number;
  /** The winning workspace id, or null when all candidates were disqualified. */
  readonly winnerWorkspaceId: string | null;
  /** True when every candidate tripped an override (fail-closed). */
  readonly rejectedAll: boolean;
}

/** Emitted once per `judge()` call. */
export const judgeEvaluated = defineEvent<JudgeEventPayload>("judge.evaluated");

/**
 * ikbi recovery — runRecovery: the executed loop.
 *
 * Turns the pure decideRecovery() policy into a run: starting from the original failed build,
 * it repeatedly asks for the next action and enacts it through injected EXECUTORS (a build
 * attempt on a chosen pool model, or a frontier consult), accumulating the attempt history,
 * until decideRecovery() terminates (recovered / exhausted / needs-authorization).
 *
 * TRUST DEFERRAL (the fix for premature demotion): the loop produces ONE terminal verdict for
 * the whole recovery. The caller (orchestrator) feeds the trust signal exactly once, from
 * `result.terminal` — never per intermediate attempt. So a recovery that takes four tries and
 * succeeds is one success and zero failures; the "3 consecutive failures" demotion can't fire
 * mid-recovery. The driver itself touches no trust state — it stays pure of side effects beyond
 * the executors it's given.
 */

import { decideRecovery } from "./policy.js";
import type { LuakLeaderboardEntry, RosterModel } from "../model-router/index.js";
import type { ModelTier, RecoveryAttempt, RecoveryTerminal } from "./contract.js";

/** The frontier consult is recorded under this synthetic model id in the attempt history. */
export const CONSULT_MODEL_ID = "frontier:consult";

export interface RecoveryExecutors {
  /** Run a build attempt on (tier, model). Resolve `green: true` when the verification ladder passes. */
  readonly attempt: (target: { readonly tier: ModelTier; readonly model: string }) => Promise<{ readonly green: boolean }>;
  /** Run the frontier consult (only called when authorized). Resolve `green: true` when it recovered. */
  readonly consult: () => Promise<{ readonly green: boolean }>;
}

export interface RecoveryDriverInput {
  /** The original failed build that opened recovery (tier+model of the first attempt). */
  readonly seed: { readonly tier: ModelTier; readonly model: string };
  readonly tierRosters: Readonly<Record<ModelTier, readonly RosterModel[]>>;
  readonly leaderboard?: readonly LuakLeaderboardEntry[];
  readonly autoCeiling?: ModelTier;
  readonly frontierAuthorized?: boolean;
  readonly startTier?: ModelTier;
  /** Hard safety cap on total attempts (defaults to the pool size + frontier + slack). */
  readonly maxAttempts?: number;
}

export interface RecoveryResult {
  /** The single terminal verdict — the caller feeds trust from THIS, once. */
  readonly terminal: RecoveryTerminal;
  /** Full attempt history in order (seed first). */
  readonly attempts: readonly RecoveryAttempt[];
  /** What resolved it, when recovered. */
  readonly recoveredBy?: { readonly tier: ModelTier; readonly model: string };
  readonly reason: string;
}

function defaultCap(input: RecoveryDriverInput): number {
  const tiers = Object.values(input.tierRosters);
  const total = tiers.reduce((n, roster) => n + roster.length, 0);
  return total + 2; // every pool/frontier model once + a little slack
}

export async function runRecovery(input: RecoveryDriverInput, executors: RecoveryExecutors): Promise<RecoveryResult> {
  const attempts: RecoveryAttempt[] = [{ tier: input.seed.tier, model: input.seed.model, outcome: "fail" }];
  const cap = input.maxAttempts ?? defaultCap(input);

  for (let step = 0; step < cap; step += 1) {
    const action = decideRecovery({
      attempts,
      tierRosters: input.tierRosters,
      ...(input.leaderboard !== undefined ? { leaderboard: input.leaderboard } : {}),
      ...(input.autoCeiling !== undefined ? { autoCeiling: input.autoCeiling } : {}),
      ...(input.frontierAuthorized !== undefined ? { frontierAuthorized: input.frontierAuthorized } : {}),
      ...(input.startTier !== undefined ? { startTier: input.startTier } : {})
    });

    if (action.kind === "terminate") {
      const recovered = action.terminal === "recovered" ? lastGreen(attempts) : undefined;
      return {
        terminal: action.terminal,
        attempts,
        ...(recovered !== undefined ? { recoveredBy: recovered } : {}),
        reason: action.reason
      };
    }

    if (action.kind === "consult") {
      const { green } = await executors.consult();
      attempts.push({ tier: "frontier", model: CONSULT_MODEL_ID, outcome: green ? "green" : "fail" });
      continue;
    }

    // action.kind === "attempt"
    const { green } = await executors.attempt({ tier: action.tier, model: action.model });
    attempts.push({ tier: action.tier, model: action.model, outcome: green ? "green" : "fail" });
  }

  // Hit the safety cap without a terminal decision — treat as exhausted (defensive; shouldn't happen).
  return { terminal: "exhausted", attempts, reason: `recovery hit the ${cap}-attempt safety cap` };
}

function lastGreen(attempts: readonly RecoveryAttempt[]): { tier: ModelTier; model: string } | undefined {
  const g = attempts[attempts.length - 1];
  return g?.outcome === "green" ? { tier: g.tier, model: g.model } : undefined;
}

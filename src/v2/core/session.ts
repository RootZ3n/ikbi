/**
 * ikbi v2 — THE BUILD SESSION CONTROLLER (V2-012).
 *
 * ONE operator `ikbi v2 build` is ONE BuildSession. A session owns an ordered, append-only
 * ledger of one OR MORE ATTEMPTS. Each attempt is a COMPLETE canonical run — its own RunId, its
 * own source snapshot, its own full evidence chain — executed by the unchanged single-attempt
 * spine (`runV2Build`). The session composes attempts; it never reaches inside a run to recapture
 * or reuse evidence.
 *
 * RECOVERY IS THE ONLY RETRY. After each attempt the session asks the ONE recovery authority
 * (`decideRecovery`) whether a fresh attempt is lawful. If — and only if — it authorizes one, the
 * session makes a NEW attempt with a NEW RunId and a NEW source snapshot. No candidate,
 * verification, critic, disposition, promotion, observation or mutation crosses the boundary.
 *
 * POLICY FREEZE. The session freezes operator configuration at its start: it loads the
 * `ConfigurationSource` ONCE and hands every attempt the SAME frozen configuration. A later
 * automatic attempt resolves roles again through the canonical resolver, but against the same
 * normalized policy — it never re-reads the active profile, `IKBI_MODEL_*`, or operator config.
 */

import { createIdFactory, type V2BuildSessionId, type V2IdFactory } from "./identity.js";
import type { ConfigurationSource, ConfigurationInputs } from "./config.js";
import type { V2TaskRequest } from "./contract.js";
import type { RunTerminalOutcome, V2RunResult } from "./result.js";
import { runV2Build, type V2RunDeps } from "./run.js";
import {
  attemptRecordOf,
  classifyAttempt,
  decideRecovery,
  recoveryDecisionRecordOf,
  DEFAULT_RECOVERY_POLICY,
  type AttemptMode,
  type AttemptRecord,
  type RecoveryDecisionRecord,
  type RecoveryPolicy,
} from "./recovery.js";
import { buildRepairBrief, summarizeRepairBrief, type RepairBrief, type RepairBriefSummary } from "./repair.js";
import {
  SessionCostController,
  DEFAULT_COST_BUDGET_POLICY,
  V2_SHIPPED_PRICING,
  type BuildSessionCostSummary,
  type CostBudgetPolicy,
  type PricingCatalog,
} from "./cost.js";

/** A hard ceiling on session attempts, independent of any policy value, as a loop guard. */
export const SESSION_ATTEMPT_HARD_CAP = 8;

/** The session-level account. Per-attempt receipts are preserved; this adds session provenance. */
export interface V2BuildSessionReceipt {
  readonly buildSessionId: V2BuildSessionId;
  readonly recoveryPolicyId: string;
  /** Every attempt, in order, referencing its canonical evidence ids. Never flattened away. */
  readonly attempts: readonly AttemptRecord[];
  /** Every recovery decision, in order. */
  readonly recoveryDecisions: readonly RecoveryDecisionRecord[];
  /** Every repair brief the session extracted, in order — bounded evidence, no bodies. */
  readonly repairBriefs: readonly RepairBriefSummary[];
  readonly finalAttemptRunId: string;
  readonly finalOutcome: RunTerminalOutcome;
  /** Present only when a publication actually landed on the final attempt. */
  readonly acceptedPromotionId?: string;
  /** Aggregates — WITH per-attempt attribution retained in `attempts`. */
  readonly totalAttempts: number;
  readonly totalInvocations: number;
  /** True when the final attempt landed but its post-CAS bookkeeping did not finish. */
  readonly reconciliationRequired: boolean;
  /**
   * THE canonical cost account of the whole session (V2-014). Derived by construction from the
   * per-invocation cost ledger — every InvocationId counted exactly once, unknown usage/price
   * kept explicitly unknown, and `sum(attempt known) == session known`. Spans every attempt,
   * including recovery and semantic repair: no attempt reset the budget or erased earlier spend.
   */
  readonly cost: BuildSessionCostSummary;
  readonly startedAt: number;
  readonly endedAt: number;
}

/** What a session returns to any caller. The full per-attempt results are retained. */
export interface V2BuildSessionResult {
  readonly buildSessionId: V2BuildSessionId;
  readonly goal: string;
  readonly repoPath: string;
  /** THE session outcome — the final attempt's terminal outcome. Never overwrites an attempt. */
  readonly outcome: RunTerminalOutcome;
  /** Every attempt's complete result, in order. */
  readonly attempts: readonly V2RunResult[];
  readonly ledger: readonly AttemptRecord[];
  readonly recoveryDecisions: readonly RecoveryDecisionRecord[];
  /** Every repair brief extracted during the session, in order. */
  readonly repairBriefs: readonly RepairBrief[];
  readonly receipt: V2BuildSessionReceipt;
}

/** Session-level dependencies: the per-attempt run deps, plus the frozen recovery policy. */
export interface V2BuildSessionDeps extends V2RunDeps {
  /** The frozen recovery policy the controller applies. Defaults to the safe development policy. */
  readonly recoveryPolicy?: RecoveryPolicy;
  /**
   * The session COST BUDGET policy (V2-014). Frozen at session start; every attempt spends the
   * same wallet under it. Defaults to `DEFAULT_COST_BUDGET_POLICY` (no ceiling — the operator
   * opts into a limit; a default cap would be a hidden authority).
   */
  readonly costBudgetPolicy?: CostBudgetPolicy;
  /**
   * The PRICING CATALOG frozen for this session. Defaults to the shipped local catalog. A rate
   * cannot change mid-session — the same catalog id prices every attempt, including retries.
   */
  readonly pricingCatalog?: PricingCatalog;
  /** Mints the ONE session identity. Injected for hermetic tests. */
  readonly sessionId?: V2BuildSessionId;
  /**
   * Builds a FRESH id factory for attempt N (1-based), so every attempt gets a fresh RunId. The
   * default is a random-token factory per attempt; tests inject a deterministic one.
   */
  readonly attemptIdFactory?: (attemptNumber: number) => V2IdFactory;
}

/**
 * Freeze the operator configuration at session start: load it ONCE and return a source that
 * replays the same load for every attempt. This is the structural half of "automatic recovery
 * never silently changes operator configuration" — a later attempt cannot re-read a profile or
 * an env var, because the source it is handed no longer touches them.
 */
function freezeConfiguration(loaded: ConfigurationInputs): ConfigurationSource {
  return { load: async () => loaded };
}

/**
 * THE session controller. Runs the first attempt, then — guided solely by `decideRecovery` —
 * runs at most `policy.maxAttempts` attempts, each a fresh run over a fresh source snapshot.
 */
export async function executeV2BuildSession(request: V2TaskRequest, deps: V2BuildSessionDeps): Promise<V2BuildSessionResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const policy = deps.recoveryPolicy ?? DEFAULT_RECOVERY_POLICY;
  const sessionIds = createIdFactory();
  const buildSessionId = deps.sessionId ?? sessionIds.mint("session");
  const attemptIdFactory = deps.attemptIdFactory ?? (() => createIdFactory());

  // POLICY FREEZE — load configuration exactly once, then replay it to every attempt.
  const frozenLoad = await deps.configuration.load(request.profile !== undefined ? { profileOverride: request.profile } : {});
  const frozenConfiguration = freezeConfiguration(frozenLoad);

  // COST + BUDGET FREEZE (V2-014). One controller spans the ENTIRE session — every attempt,
  // including recovery and semantic repair, charges this one wallet, so no attempt resets the
  // budget or erases earlier spend. The pricing catalog and budget policy are frozen here,
  // alongside the configuration, and never re-read between attempts.
  const pricingCatalog = deps.pricingCatalog ?? V2_SHIPPED_PRICING;
  const costBudgetPolicy = deps.costBudgetPolicy ?? DEFAULT_COST_BUDGET_POLICY;
  const costController = new SessionCostController({ buildSessionId, catalog: pricingCatalog, policy: costBudgetPolicy });

  const attempts: V2RunResult[] = [];
  const ledger: AttemptRecord[] = [];
  const recoveryDecisions: RecoveryDecisionRecord[] = [];
  const repairBriefs: RepairBrief[] = [];

  let attemptNumber = 0;
  // The bound is the policy's, clamped by the independent hard cap so a misconfigured policy can
  // never loop forever.
  const cap = Math.min(policy.maxAttempts, SESSION_ATTEMPT_HARD_CAP);
  let reconciliationRequired = false;

  // SEMANTIC-REPAIR LINEAGE. `currentBrief` is the bounded historical evidence the NEXT attempt
  // should learn from; `nextMode` records why the next attempt is being made. An environmental
  // retry that interrupts a repair lineage KEEPS the same brief (the historical evidence is
  // unchanged) — evidence reuse is not authority reuse. `semanticRepairsSoFar` bounds how many
  // repair attempts one failure lineage may spend.
  let currentBrief: RepairBrief | undefined;
  let nextMode: AttemptMode = "initial";
  let semanticRepairsSoFar = 0;

  while (attemptNumber < cap) {
    attemptNumber += 1;
    const attemptMode = nextMode;
    const briefForThisAttempt = currentBrief;
    const attemptIds = attemptIdFactory(attemptNumber);
    // A FRESH run: its own id factory (fresh RunId), the FROZEN configuration, the ONE session
    // cost guard, everything else exactly the single-attempt deps. The run captures its OWN
    // source snapshot. When a repair brief is present it is handed to the run as ADVISORY,
    // untrusted historical context — never as authority, and carrying NO workspace pointer.
    const result = await runV2Build(request, {
      ...deps,
      ids: attemptIds,
      configuration: frozenConfiguration,
      admission: costController,
      ...(briefForThisAttempt !== undefined ? { repairBrief: briefForThisAttempt } : {}),
    });
    attempts.push(result);
    // Reconcile this attempt's cost: charge any records the live path did not (idempotent), and
    // count calls that reached the wire, failed, and left no usage (real, cost unknown).
    costController.reconcileAttempt({
      runId: result.runId,
      attemptNumber,
      records: result.invocations,
      totalInvocationCount: result.receipt.evidence.invocations,
    });

    const trigger = classifyAttempt(result);
    ledger.push(
      attemptRecordOf({
        buildSessionId,
        attemptNumber,
        result,
        trigger,
        mode: attemptMode,
        ...(briefForThisAttempt !== undefined ? { repairBriefId: briefForThisAttempt.repairBriefId, sourceAttemptRunId: briefForThisAttempt.sourceAttemptRunId } : {}),
      }),
    );

    const decision = decideRecovery({ attemptNumber, result, policy, semanticRepairsSoFar });
    recoveryDecisions.push(
      recoveryDecisionRecordOf({
        buildSessionId,
        recoveryPolicyId: policy.policyId,
        attemptNumber,
        completedRunId: result.runId,
        decision,
        decidedAt: now(),
      }),
    );

    if (decision.kind === "reconciliation_required") reconciliationRequired = true;

    // The ONLY thing that makes a second attempt is an explicit retry authorization.
    if (!decision.authorizesNewAttempt) break;

    if (decision.mode === "semantic_repair" && decision.repairTrigger !== undefined) {
      // Extract a bounded, neutralized brief from THIS failed attempt; the next attempt learns
      // from it. If extraction fails (no defect evidence), fall back to an evidence-free retry.
      const brief = buildRepairBrief({ buildSessionId, result, trigger: decision.repairTrigger });
      if (brief !== undefined) {
        currentBrief = brief;
        repairBriefs.push(brief);
        semanticRepairsSoFar += 1;
        nextMode = "semantic_repair";
      } else {
        nextMode = "environmental_retry";
      }
    } else {
      // An environmental retry KEEPS the existing brief (lineage) but does not itself repair.
      nextMode = "environmental_retry";
    }
  }

  const final = attempts[attempts.length - 1]!;
  const endedAt = now();
  const acceptedPromotionId = final.outcome.kind === "accepted" ? final.receipt.promotion?.promotionId : undefined;

  // THE canonical session cost account — derived by construction from the per-invocation ledger.
  const cost = costController.sessionSummary();

  const receipt: V2BuildSessionReceipt = {
    buildSessionId,
    recoveryPolicyId: policy.policyId,
    attempts: ledger,
    recoveryDecisions,
    repairBriefs: repairBriefs.map(summarizeRepairBrief),
    finalAttemptRunId: final.runId,
    finalOutcome: final.outcome,
    totalAttempts: attempts.length,
    // Counted from the cost ledger's dedup'd invocation total — the SAME source as the cost
    // summary, so the invocation count and the cost can never disagree.
    totalInvocations: cost.totalInvocations,
    reconciliationRequired,
    cost,
    startedAt,
    endedAt,
    ...(acceptedPromotionId !== undefined ? { acceptedPromotionId } : {}),
  };

  return {
    buildSessionId,
    goal: final.goal,
    repoPath: final.repoPath,
    outcome: final.outcome,
    attempts,
    ledger,
    recoveryDecisions,
    repairBriefs,
    receipt,
  };
}

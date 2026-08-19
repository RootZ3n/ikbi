/**
 * ikbi v2 — THE CANONICAL RECOVERY CONTROLLER (V2-012).
 *
 * ONE authority decides, after a COMPLETE attempt, whether a fresh attempt is lawful. No other
 * component may retry: the builder cannot re-run the run, the verifier cannot re-run the
 * builder, the critic cannot start a fixer, promotion cannot recapture/republish, and the
 * transport does not fall back. Only `decideRecovery` authorizes a NEW attempt.
 *
 * ATTEMPTS, NOT RECAPTURES. `ONE RUN = ONE SOURCE SNAPSHOT` is preserved. A recovery that needs
 * a fresh repository state does NOT recapture inside the same RunId — it starts a NEW attempt
 * with a NEW RunId and a NEW SourceSnapshot, under one BuildSession. No candidate, verification,
 * critic, disposition, promotion, observation or mutation from a prior attempt crosses the
 * boundary.
 *
 * SCOPE. This slice does bounded automatic FRESH-ATTEMPT retry for genuinely environmental
 * conditions (moved target, CAS conflict, candidate drift, verification timeout/infrastructure
 * failure, transient provider failure). It does NOT do semantic repair: a verification FAIL or a
 * critic DEFECTS_FOUND is a COMPLETED ADVERSE JUDGMENT, never an infrastructure retry. No
 * fixer, no critic-fix loop, no model escalation, no provider fallback, no profile switch.
 *
 * PURITY. Everything here is pure and total: the same attempt outcome under the same policy
 * yields the same decision. No I/O, no clock, no model.
 */

import {
  contentDigest,
  type V2BuildSessionId,
  type V2RecoveryDecisionId,
  type V2RecoveryPolicyDigest,
  type V2RunId,
} from "./identity.js";
import type { V2RunResult } from "./result.js";

// ---------------------------------------------------------------------------
// Policy — the explicit, content-addressed rules
// ---------------------------------------------------------------------------

/**
 * THE recovery policy. Small and closed: which ENVIRONMENTAL conditions may be auto-retried
 * with a fresh attempt, and how many attempts a session may make in total. Adverse JUDGMENTS
 * (verification fail, critic defects) are never in scope, so there is no flag that could turn
 * one into a retry.
 */
export interface RecoveryPolicy {
  readonly policyId: V2RecoveryPolicyDigest;
  /** Total attempts a session may make (initial + automatic retries + repairs). Default 2. */
  readonly maxAttempts: number;
  // ── environmental retry (V2-012) — a fresh attempt over a transient/infra fault ──
  readonly retryOnVerificationTimeout: boolean;
  readonly retryOnVerificationInfrastructureFailure: boolean;
  readonly retryOnCandidateDrift: boolean;
  readonly retryOnTargetMoved: boolean;
  readonly retryOnCasConflict: boolean;
  /** Only honoured for failures the taxonomy marks genuinely transient (timeout / 5xx / rate-limit). */
  readonly retryOnTransientProviderFailure: boolean;
  // ── semantic repair (V2-013) — a fresh attempt that LEARNS from a concrete failure ──
  /** A deterministic verification FAIL may authorize ONE semantic-repair attempt. */
  readonly retryOnVerificationFailureForRepair: boolean;
  /** A concrete critic DEFECTS_FOUND may authorize ONE semantic-repair attempt. */
  readonly retryOnCriticDefectsForRepair: boolean;
  /** How many semantic-repair attempts a single failure lineage may spend. Default 1. */
  readonly maxSemanticRepairAttempts: number;
}

export type RecoveryPolicyInput = Omit<RecoveryPolicy, "policyId">;

/**
 * The conservative development default: one automatic recovery attempt for environmental faults,
 * AND — with the default budget — one semantic-repair attempt for a concrete adverse judgment.
 */
export const DEFAULT_RECOVERY_POLICY_INPUT: RecoveryPolicyInput = {
  maxAttempts: 2,
  retryOnVerificationTimeout: true,
  retryOnVerificationInfrastructureFailure: true,
  retryOnCandidateDrift: true,
  retryOnTargetMoved: true,
  retryOnCasConflict: true,
  retryOnTransientProviderFailure: true,
  retryOnVerificationFailureForRepair: true,
  retryOnCriticDefectsForRepair: true,
  maxSemanticRepairAttempts: 1,
};

export function recoveryPolicyDigest(input: RecoveryPolicyInput): V2RecoveryPolicyDigest {
  return contentDigest("recovery_policy", {
    maxAttempts: input.maxAttempts,
    retryOnVerificationTimeout: input.retryOnVerificationTimeout,
    retryOnVerificationInfrastructureFailure: input.retryOnVerificationInfrastructureFailure,
    retryOnCandidateDrift: input.retryOnCandidateDrift,
    retryOnTargetMoved: input.retryOnTargetMoved,
    retryOnCasConflict: input.retryOnCasConflict,
    retryOnTransientProviderFailure: input.retryOnTransientProviderFailure,
    retryOnVerificationFailureForRepair: input.retryOnVerificationFailureForRepair,
    retryOnCriticDefectsForRepair: input.retryOnCriticDefectsForRepair,
    maxSemanticRepairAttempts: input.maxSemanticRepairAttempts,
  });
}

export function buildRecoveryPolicy(overrides: Partial<RecoveryPolicyInput> = {}): RecoveryPolicy {
  const input: RecoveryPolicyInput = { ...DEFAULT_RECOVERY_POLICY_INPUT, ...overrides };
  return { policyId: recoveryPolicyDigest(input), ...input };
}

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = buildRecoveryPolicy();

// ---------------------------------------------------------------------------
// Attempt classification — what a completed attempt's outcome MEANS to recovery
// ---------------------------------------------------------------------------

/**
 * The closed set of conditions a completed attempt can present to recovery. Derived purely
 * from the attempt's terminal outcome + its receipt — never from a lower subsystem's opinion.
 */
export type RecoveryTrigger =
  // terminal successes
  | "accepted" // a clean publication landed
  | "accepted_degraded" // the ref moved but post-CAS bookkeeping did not finish
  // environmental — a FRESH attempt may help (policy-gated)
  | "target_moved" // stale target OR CAS conflict — re-capture against the new base
  | "candidate_drift" // the workspace tree / check-mutation / subject moved
  | "verification_timeout"
  | "verification_infrastructure_failure"
  | "provider_transient" // transport timeout / 5xx / rate limit
  // operator-only — a fresh attempt over the same condition changes nothing
  | "dirty_source" // clean-ref CAS cannot publish a dirty source snapshot
  | "operator_required" // dirty target worktree, or a policy operator-hold
  // completed adverse JUDGMENTS — never an ENVIRONMENTAL retry. `verification_failed` and
  // `critic_defects` are CONCRETE (they carry defect evidence) and MAY authorize ONE
  // semantic-REPAIR attempt (V2-013). `critic_indeterminate` and `no_checks` are NOT concrete
  // defects — there is nothing to repair — so they only ever stop.
  | "verification_failed"
  | "critic_defects"
  | "critic_indeterminate"
  | "no_checks"
  | "governance_withheld"
  // hard stops
  | "build_failed" // the builder could not produce a candidate (e.g. turn limit)
  | "provider_permanent" // credential missing / served-identity mismatch / unsupported
  | "wiring_defect"; // an engine/config defect — not the operator's build

/** The transient provider failure codes the taxonomy genuinely supports as environmental. */
const TRANSIENT_PROVIDER_CODES: ReadonlySet<string> = new Set([
  "invocation.transport_timeout",
  "invocation.transport_failure",
  "invocation.provider_rate_limited",
]);

/**
 * Classify a COMPLETED attempt's result into exactly one recovery trigger. Pure: it reads the
 * terminal outcome, the promotion summary (degraded), the disposition summary (which quarantine
 * reason) and the structured failure — nothing a subsystem asserted separately.
 */
export function classifyAttempt(result: V2RunResult): RecoveryTrigger {
  const outcome = result.outcome;
  switch (outcome.kind) {
    case "accepted":
      return result.receipt.promotion?.degraded === true ? "accepted_degraded" : "accepted";
    case "withheld":
      switch (outcome.reason) {
        case "target_moved":
          return "target_moved";
        case "unsupported_publication":
          return "dirty_source";
        case "operator":
          return "operator_required";
        case "governance":
        case "dry_run":
          return "governance_withheld";
        case "policy": {
          // The disposition's primary reason names the concrete adverse judgment. Only
          // `critic_defects` carries repairable evidence; indeterminate and no_checks do not.
          const reason = result.receipt.disposition?.primaryReason;
          if (reason === "critic_defects") return "critic_defects";
          if (reason === "critic_indeterminate") return "critic_indeterminate";
          if (reason === "no_checks") return "no_checks";
          return "governance_withheld";
        }
        case "awaiting_promotion":
        default:
          return "governance_withheld";
      }
    case "rejected":
      return "verification_failed";
    case "quarantined": {
      // A quarantine is either verification-incomplete (timeout/infra) or a drift/mutation of
      // the candidate/subject. The disposition's primary reason distinguishes them when it was
      // recorded; a subject-drift quarantine (no disposition) is a candidate drift.
      const reason = result.receipt.disposition?.primaryReason;
      if (reason === "verification_timeout") return "verification_timeout";
      if (reason === "verification_infrastructure_failure") return "verification_infrastructure_failure";
      return "candidate_drift";
    }
    case "failed": {
      const f = outcome.failure;
      if (f.category === "provider") {
        // V2-013 (V2-012 audit cutover): the CLOSED transient-code set is the SOLE authority.
        // The former `|| f.retryable` fallback is removed — a provider failure is transient iff
        // its code is one we explicitly recognize as environmental, never because a boolean was
        // set somewhere upstream.
        return TRANSIENT_PROVIDER_CODES.has(f.code) ? "provider_transient" : "provider_permanent";
      }
      if (f.category === "build") return "build_failed";
      // internal / promotion(wrong_evidence) / not_implemented / context / resolution / task /
      // preflight / mutation / workspace — engine or configuration defects, not retryable.
      return "wiring_defect";
    }
  }
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * THE closed recovery vocabulary. `retry_fresh_attempt` is the ONLY decision that authorizes a
 * new attempt. Everything else stops the session; the stop flavour mirrors the attempt outcome
 * for provenance. `reconciliation_required` is a landed-but-degraded publication (the ref moved
 * — never re-published). `require_operator` is a condition a human must resolve or an exhausted
 * retry budget.
 */
export type RecoveryDecisionKind =
  | "stop_accepted"
  | "stop_withheld"
  | "stop_rejected"
  | "stop_quarantined"
  | "stop_failed"
  | "retry_fresh_attempt"
  | "require_operator"
  | "reconciliation_required";

export const RECOVERY_DECISION_KINDS: readonly RecoveryDecisionKind[] = [
  "stop_accepted",
  "stop_withheld",
  "stop_rejected",
  "stop_quarantined",
  "stop_failed",
  "retry_fresh_attempt",
  "require_operator",
  "reconciliation_required",
] as const;

/** A machine-readable reason for the decision. Closed set. */
export type RecoveryReason =
  | "clean_publication"
  | "landed_degraded_reconcile"
  | "environmental_retry"
  | "semantic_repair"
  | "retry_budget_exhausted"
  | "repair_budget_exhausted"
  | "retry_disabled_by_policy"
  | "repair_disabled_by_policy"
  | "operator_must_resolve"
  | "adverse_verification"
  | "adverse_semantic"
  | "governance_hold"
  | "build_did_not_complete"
  | "provider_unrecoverable"
  | "engine_defect";

/**
 * How a fresh attempt relates to the one before it. `environmental` re-runs after a transient
 * fault (no evidence carried); `semantic_repair` carries a bounded RepairBrief describing the
 * concrete failure the new attempt should learn from.
 */
export type RetryMode = "environmental" | "semantic_repair";

/** Which concrete adverse judgment a semantic repair addresses (mirrors repair.ts). */
export type RepairTriggerKind = "verification_failure" | "critic_defects";

export interface RecoveryDecision {
  readonly kind: RecoveryDecisionKind;
  readonly trigger: RecoveryTrigger;
  readonly reason: RecoveryReason;
  /** Present only for `retry_fresh_attempt`: the ordinal of the attempt to make next. */
  readonly nextAttemptNumber?: number;
  /** Present only for `retry_fresh_attempt`: environmental vs semantic repair. */
  readonly mode?: RetryMode;
  /** Present only for a semantic-repair retry: which concrete judgment to build a brief from. */
  readonly repairTrigger?: RepairTriggerKind;
  /** Does this decision authorize a NEW attempt? Derived from the kind — never set independently. */
  readonly authorizesNewAttempt: boolean;
}

/** Which policy flag gates each environmental trigger. */
function environmentalRetryAllowed(trigger: RecoveryTrigger, policy: RecoveryPolicy): boolean | undefined {
  switch (trigger) {
    case "target_moved":
      // Stale target and CAS conflict both arrive here; either flag permits the fresh attempt.
      return policy.retryOnTargetMoved || policy.retryOnCasConflict;
    case "candidate_drift":
      return policy.retryOnCandidateDrift;
    case "verification_timeout":
      return policy.retryOnVerificationTimeout;
    case "verification_infrastructure_failure":
      return policy.retryOnVerificationInfrastructureFailure;
    case "provider_transient":
      return policy.retryOnTransientProviderFailure;
    default:
      return undefined; // not an environmental trigger
  }
}

/**
 * THE recovery decision. Pure and total. Given a completed attempt's ordinal (1-based), its
 * result, and the frozen policy, it returns the ONE lawful next step.
 *
 * A retry is authorized ONLY for an environmental trigger, ONLY when its policy flag is set, and
 * ONLY while the attempt budget remains. An exhausted budget or a disabled flag becomes
 * `require_operator`, never a silent stop that hides a recoverable condition.
 */
export function decideRecovery(input: {
  readonly attemptNumber: number;
  readonly result: V2RunResult;
  readonly policy: RecoveryPolicy;
  /** How many SEMANTIC-repair attempts this failure lineage has already spent. Default 0. */
  readonly semanticRepairsSoFar?: number;
}): RecoveryDecision {
  const trigger = classifyAttempt(input.result);
  const repairsSoFar = input.semanticRepairsSoFar ?? 0;
  const derive = (kind: RecoveryDecisionKind, reason: RecoveryReason, extra: { nextAttemptNumber?: number; mode?: RetryMode; repairTrigger?: RepairTriggerKind } = {}): RecoveryDecision => ({
    kind,
    trigger,
    reason,
    ...(extra.nextAttemptNumber !== undefined ? { nextAttemptNumber: extra.nextAttemptNumber } : {}),
    ...(extra.mode !== undefined ? { mode: extra.mode } : {}),
    ...(extra.repairTrigger !== undefined ? { repairTrigger: extra.repairTrigger } : {}),
    authorizesNewAttempt: kind === "retry_fresh_attempt",
  });

  /**
   * A concrete adverse judgment MAY authorize ONE semantic-repair attempt: only when the policy
   * flag is set, the semantic-repair budget remains, and the hard attempt budget remains.
   * Otherwise it STOPS adverse — never a silent loop.
   */
  const repairOrStop = (allowed: boolean, repairTrigger: RepairTriggerKind, stopKind: RecoveryDecisionKind): RecoveryDecision => {
    if (!allowed) return derive(stopKind, "repair_disabled_by_policy");
    if (repairsSoFar >= input.policy.maxSemanticRepairAttempts) return derive(stopKind, "repair_budget_exhausted");
    if (input.attemptNumber >= input.policy.maxAttempts) return derive(stopKind, "retry_budget_exhausted");
    return derive("retry_fresh_attempt", "semantic_repair", { nextAttemptNumber: input.attemptNumber + 1, mode: "semantic_repair", repairTrigger });
  };

  switch (trigger) {
    case "accepted":
      return derive("stop_accepted", "clean_publication");
    case "accepted_degraded":
      // The ref ALREADY moved — never re-publish. Reconciliation may repair worktree/journal.
      return derive("reconciliation_required", "landed_degraded_reconcile");
    case "verification_failed":
      // A deterministic FAIL is concrete — it may earn ONE semantic-repair attempt.
      return repairOrStop(input.policy.retryOnVerificationFailureForRepair, "verification_failure", "stop_rejected");
    case "critic_defects":
      // Concrete critic defects — they may earn ONE semantic-repair attempt.
      return repairOrStop(input.policy.retryOnCriticDefectsForRepair, "critic_defects", "stop_withheld");
    case "critic_indeterminate":
    case "no_checks":
      // Neither is a concrete defect — there is nothing to repair. Disposition governed the stop.
      return derive("stop_withheld", "adverse_semantic");
    case "governance_withheld":
      return derive("stop_withheld", "governance_hold");
    case "dirty_source":
    case "operator_required":
      return derive("require_operator", "operator_must_resolve");
    case "build_failed":
      return derive("stop_failed", "build_did_not_complete");
    case "provider_permanent":
      return derive("require_operator", "provider_unrecoverable");
    case "wiring_defect":
      return derive("stop_failed", "engine_defect");
    // environmental — policy + budget gated
    case "target_moved":
    case "candidate_drift":
    case "verification_timeout":
    case "verification_infrastructure_failure":
    case "provider_transient": {
      const allowed = environmentalRetryAllowed(trigger, input.policy) === true;
      if (!allowed) return derive("require_operator", "retry_disabled_by_policy");
      if (input.attemptNumber >= input.policy.maxAttempts) return derive("require_operator", "retry_budget_exhausted");
      return derive("retry_fresh_attempt", "environmental_retry", { nextAttemptNumber: input.attemptNumber + 1, mode: "environmental" });
    }
  }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * THE immutable account of one attempt within a session. It REFERENCES the attempt's canonical
 * evidence ids — it never duplicates the receipt. `recoveryTrigger` is how recovery read the
 * attempt's outcome; a recovery decision record links it to what happened next.
 */
export type AttemptMode = "initial" | "environmental_retry" | "semantic_repair";

export interface AttemptRecord {
  readonly buildSessionId: V2BuildSessionId;
  readonly attemptNumber: number;
  readonly runId: V2RunId;
  /** Why THIS attempt was made: the first, an environmental retry, or a semantic repair. */
  readonly mode: AttemptMode;
  /** For a repair attempt: the brief it carried, and the prior run it addresses. */
  readonly repairBriefId?: string;
  readonly sourceAttemptRunId?: string;
  readonly sourceSnapshotId?: string;
  readonly outcomeKind: string;
  readonly trigger: RecoveryTrigger;
  readonly candidateId?: string;
  readonly verificationId?: string;
  readonly criticId?: string;
  readonly dispositionId?: string;
  readonly promotionId?: string;
  readonly startedAt: number;
  readonly endedAt: number;
}

/** Project an attempt result + its trigger into an immutable, id-referencing record. */
export function attemptRecordOf(input: {
  readonly buildSessionId: V2BuildSessionId;
  readonly attemptNumber: number;
  readonly result: V2RunResult;
  readonly trigger: RecoveryTrigger;
  readonly mode: AttemptMode;
  readonly repairBriefId?: string;
  readonly sourceAttemptRunId?: string;
}): AttemptRecord {
  const r = input.result;
  return {
    buildSessionId: input.buildSessionId,
    attemptNumber: input.attemptNumber,
    runId: r.runId,
    mode: input.mode,
    outcomeKind: r.outcome.kind,
    trigger: input.trigger,
    ...(input.repairBriefId !== undefined ? { repairBriefId: input.repairBriefId } : {}),
    ...(input.sourceAttemptRunId !== undefined ? { sourceAttemptRunId: input.sourceAttemptRunId } : {}),
    startedAt: r.receipt.startedAt,
    endedAt: r.receipt.endedAt,
    ...(r.receipt.sourceSnapshot !== undefined ? { sourceSnapshotId: r.receipt.sourceSnapshot.snapshotId } : {}),
    ...(r.receipt.candidate !== undefined ? { candidateId: r.receipt.candidate.candidateId } : {}),
    ...(r.receipt.verification !== undefined ? { verificationId: r.receipt.verification.verificationId } : {}),
    ...(r.receipt.critic !== undefined ? { criticId: r.receipt.critic.criticId } : {}),
    ...(r.receipt.disposition !== undefined ? { dispositionId: r.receipt.disposition.dispositionId } : {}),
    ...(r.receipt.promotion !== undefined ? { promotionId: r.receipt.promotion.promotionId } : {}),
  };
}

/** THE immutable account of one recovery decision, content-addressed over its semantics. */
export interface RecoveryDecisionRecord {
  readonly decisionId: V2RecoveryDecisionId;
  readonly buildSessionId: V2BuildSessionId;
  readonly recoveryPolicyId: V2RecoveryPolicyDigest;
  readonly attemptNumber: number;
  readonly completedRunId: V2RunId;
  readonly trigger: RecoveryTrigger;
  readonly kind: RecoveryDecisionKind;
  readonly reason: RecoveryReason;
  readonly nextAttemptNumber?: number;
  /** Environmental vs semantic-repair, for a retry decision. Absent when no new attempt follows. */
  readonly mode?: RetryMode;
  /** The concrete judgment a semantic repair addresses. Present only for a semantic-repair retry. */
  readonly repairTrigger?: RepairTriggerKind;
  readonly authorizesNewAttempt: boolean;
  readonly decidedAt: number;
}

/** Content address of a recovery decision: the exact attempt, policy and decision. */
export function recoveryDecisionDigest(input: {
  readonly buildSessionId: V2BuildSessionId;
  readonly recoveryPolicyId: V2RecoveryPolicyDigest;
  readonly attemptNumber: number;
  readonly completedRunId: V2RunId;
  readonly trigger: RecoveryTrigger;
  readonly kind: RecoveryDecisionKind;
  readonly reason: RecoveryReason;
}): V2RecoveryDecisionId {
  return contentDigest("recovery_decision", {
    buildSessionId: input.buildSessionId,
    recoveryPolicyId: input.recoveryPolicyId,
    attemptNumber: input.attemptNumber,
    completedRunId: input.completedRunId,
    trigger: input.trigger,
    kind: input.kind,
    reason: input.reason,
  });
}

export function recoveryDecisionRecordOf(input: {
  readonly buildSessionId: V2BuildSessionId;
  readonly recoveryPolicyId: V2RecoveryPolicyDigest;
  readonly attemptNumber: number;
  readonly completedRunId: V2RunId;
  readonly decision: RecoveryDecision;
  readonly decidedAt: number;
}): RecoveryDecisionRecord {
  return {
    decisionId: recoveryDecisionDigest({
      buildSessionId: input.buildSessionId,
      recoveryPolicyId: input.recoveryPolicyId,
      attemptNumber: input.attemptNumber,
      completedRunId: input.completedRunId,
      trigger: input.decision.trigger,
      kind: input.decision.kind,
      reason: input.decision.reason,
    }),
    buildSessionId: input.buildSessionId,
    recoveryPolicyId: input.recoveryPolicyId,
    attemptNumber: input.attemptNumber,
    completedRunId: input.completedRunId,
    trigger: input.decision.trigger,
    kind: input.decision.kind,
    reason: input.decision.reason,
    authorizesNewAttempt: input.decision.authorizesNewAttempt,
    decidedAt: input.decidedAt,
    ...(input.decision.nextAttemptNumber !== undefined ? { nextAttemptNumber: input.decision.nextAttemptNumber } : {}),
    ...(input.decision.mode !== undefined ? { mode: input.decision.mode } : {}),
    ...(input.decision.repairTrigger !== undefined ? { repairTrigger: input.decision.repairTrigger } : {}),
  };
}

// ---------------------------------------------------------------------------
// Crash reconciliation — git state is authoritative, journal is corroboration
// ---------------------------------------------------------------------------

/**
 * The deterministic landing classification of a (possibly interrupted) publication. It reads
 * only git-derived facts + an OPTIONAL journal; it NEVER requires a journal to exist, and it
 * NEVER infers "nothing landed" merely because the journal is absent. No mutation.
 */
export type PublicationLanding = "not_landed" | "landed_exact" | "landed_degraded" | "ambiguous";

export function classifyPublicationLanding(input: {
  /** The tree the candidate would land. */
  readonly candidateTree: string;
  /** The tree the target ref currently points at (git-derived). */
  readonly targetTree: string;
  /** The commit the target ref currently points at (git-derived). */
  readonly targetHead: string;
  /** The authorized base the CAS would move FROM, when known. */
  readonly beforeRef?: string;
  /** The commit the CAS would move TO, when known (from a result or journal). */
  readonly afterRef?: string;
}): PublicationLanding {
  // The candidate tree IS authoritative on the target — the exact bytes landed.
  if (input.targetTree === input.candidateTree) return "landed_exact";
  // The ref moved to the intended commit, but its tree is not the candidate tree — a degraded
  // landing (the ref moved; something is off). Git state wins over any journal text.
  if (input.afterRef !== undefined && input.targetHead === input.afterRef) return "landed_degraded";
  // The ref is still at the authorized base — nothing moved.
  if (input.beforeRef !== undefined && input.targetHead === input.beforeRef) return "not_landed";
  // The ref is somewhere else entirely (a third party moved it) — we cannot claim either way.
  return "ambiguous";
}

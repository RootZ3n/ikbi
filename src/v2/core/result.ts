/**
 * ikbi v2 — TERMINAL OUTCOMES, THE RUN RECEIPT, AND THE RUN RESULT.
 *
 * A v2 run ends in exactly ONE outcome object. The states that made v1's status
 * hard to trust — `success: true` next to `promotion: false` next to
 * `verification: "failed"` — are not merely discouraged here, they are
 * UNREPRESENTABLE: each outcome is a distinct variant carrying only the evidence it
 * is entitled to, and the lifecycle refuses to accept a variant whose evidence it
 * never saw recorded (see lifecycle.ts `terminalize`).
 *
 * THE FIVE OUTCOMES (named after v1's hard-won distinctions, which were right):
 *
 *   accepted     work was verified good and PROMOTED. The only outcome that may
 *                claim the repository changed.
 *   withheld     work was verified good and deliberately NOT promoted (a gate, a
 *                policy, an operator). v1's adjudication core calls this "retain"
 *                and is emphatic that it is NOT a failure — green work is never
 *                laundered into "the builder failed". v2 keeps that distinction.
 *   rejected     work was produced but is not verified-good (red checks, no work,
 *                vacuous green). v1's "discard".
 *   quarantined  the run was stopped and its state is being PRESERVED for a human
 *                or a forensic pass. Nothing promoted, nothing thrown away.
 *   failed       the run could not complete. Carries a structured RunFailure.
 *
 * THE RECEIPT is produced BY terminalization and derives every truth claim from the
 * lifecycle's own journal and evidence ledger. It is not assembled from what a
 * caller believes happened. That is why `providerInvoked`, `candidatesCreated`,
 * `verificationsPerformed`, `promoted` and `repositoryMutated` cannot be optimistic:
 * there is no code path that sets them, only a path that COUNTS them.
 */

import type { RunFailure } from "./failure.js";
import type { LifecycleStage, LifecycleTransition, RunLedgerView } from "./lifecycle.js";
import type {
  V2CandidateId,
  V2PolicyDigest,
  V2PromotionId,
  V2ReceiptId,
  V2RunId,
  V2TaskId,
  V2VerificationId,
} from "./identity.js";
import type { RuntimeModelPolicy } from "./config.js";

/** Why verified-good work was withheld instead of promoted. Closed set. */
export type WithheldReason = "governance" | "operator" | "policy" | "dry_run";

/** Why produced work was rejected. Closed set (mirrors v1's DiscardReason vocabulary). */
export type RejectedReason = "verification_red" | "no_work" | "vacuous_green" | "unresolvable" | "aborted";

/** Why a run was quarantined. Closed set. */
export type QuarantineReason = "safety_forensics" | "operator_hold" | "adjudication_incomplete";

/**
 * THE authoritative end state of a run. Exactly one of these, exactly once.
 * Note what `accepted` requires and what the negative outcomes deliberately cannot
 * carry: a `failed` run has no candidate/verification/promotion fields at all, so it
 * has no vocabulary in which to imply work landed.
 */
export type RunTerminalOutcome =
  | {
      readonly kind: "accepted";
      readonly candidateId: V2CandidateId;
      readonly verificationId: V2VerificationId;
      readonly promotionId: V2PromotionId;
    }
  | {
      readonly kind: "withheld";
      readonly candidateId: V2CandidateId;
      readonly verificationId: V2VerificationId;
      readonly reason: WithheldReason;
    }
  | { readonly kind: "rejected"; readonly reason: RejectedReason; readonly candidateId?: V2CandidateId }
  | { readonly kind: "quarantined"; readonly reason: QuarantineReason; readonly detail: string }
  | { readonly kind: "failed"; readonly failure: RunFailure };

/** The outcome kinds, for exhaustive iteration in tests and renderers. */
export const RUN_TERMINAL_KINDS = ["accepted", "withheld", "rejected", "quarantined", "failed"] as const;

/** Did the repository change as a result of this run? True for exactly one outcome. */
export function outcomeChangedRepository(outcome: RunTerminalOutcome): boolean {
  return outcome.kind === "accepted";
}

/**
 * Process exit code for an outcome. `withheld` is 0 because withholding verified
 * work is a correct, intended result — not an error the operator must chase.
 */
export function exitCodeForOutcome(outcome: RunTerminalOutcome): number {
  switch (outcome.kind) {
    case "accepted":
    case "withheld":
      return 0;
    case "rejected":
      return 1;
    case "quarantined":
      return 2;
    case "failed":
      return 1;
  }
}

/** One-line operator rendering of an outcome. */
export function formatOutcome(outcome: RunTerminalOutcome): string {
  switch (outcome.kind) {
    case "accepted":
      return `accepted — promoted (${outcome.promotionId})`;
    case "withheld":
      return `withheld — verified work retained, not promoted (${outcome.reason})`;
    case "rejected":
      return `rejected — ${outcome.reason}`;
    case "quarantined":
      return `quarantined — ${outcome.reason}: ${outcome.detail}`;
    case "failed":
      return `failed — [${outcome.failure.category}] ${outcome.failure.message}`;
  }
}

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

/**
 * The truth block. Every field is COUNTED from the lifecycle ledger, never asserted.
 * A stage that did not run cannot contribute to it, so a skeleton run reports
 * zeroes and falses — which is the entire point of shipping this in slice 001.
 */
export interface RunEvidenceSummary {
  /** True only when preflight actually built and recorded a runtime model policy. */
  readonly configurationResolved: boolean;
  readonly providerInvoked: boolean;
  readonly invocations: number;
  readonly candidatesCreated: number;
  readonly verificationsPerformed: number;
  readonly promotionsAttempted: number;
  readonly promoted: boolean;
  readonly repositoryMutated: boolean;
}

/**
 * The configuration a run actually used, as a receipt-safe summary.
 *
 * Present only when preflight really resolved one. Everything here is a digest, a
 * name or a count — never an endpoint credential and never a raw parameter value.
 */
export interface RunConfigurationSummary {
  readonly policyId: V2PolicyDigest;
  readonly inventoryDigest: string;
  /** The active profile's name, or null when the operator selected none. */
  readonly profile: string | null;
  readonly profileSource: string;
  readonly providersConfigured: number;
  readonly modelsInvocable: number;
  readonly rolesResolved: number;
  readonly unsatisfiableRequiredRoles: readonly string[];
}

/** Summarize a policy for a receipt. Derived from the policy — nothing is asserted. */
export function summarizeConfiguration(policy: RuntimeModelPolicy): RunConfigurationSummary {
  return {
    policyId: policy.policyId,
    inventoryDigest: policy.inventory.digest,
    profile: policy.profile?.name ?? null,
    profileSource: policy.profileSource,
    providersConfigured: policy.inventory.providersConfigured,
    modelsInvocable: policy.inventory.modelsInvocable,
    rolesResolved: policy.rolePreferences.length,
    unsatisfiableRequiredRoles: policy.unsatisfiableRequiredRoles,
  };
}

/** The durable account of ONE run: where it went, what it produced, how it ended. */
export interface V2RunReceipt {
  readonly receiptId: V2ReceiptId;
  readonly taskId: V2TaskId;
  readonly runId: V2RunId;
  readonly outcome: RunTerminalOutcome;
  readonly stagesEntered: readonly LifecycleStage[];
  readonly evidence: RunEvidenceSummary;
  /** Absent when the run ended before configuration was established. */
  readonly configuration?: RunConfigurationSummary;
  readonly startedAt: number;
  readonly endedAt: number;
}

/**
 * Count what a run actually produced. `promoted`/`repositoryMutated` are true only
 * when the run BOTH recorded a promotion AND terminalized as accepted — a recorded
 * promotion attempt that did not become the terminal outcome never reads as landed.
 */
export function summarizeEvidence(ledger: RunLedgerView, outcome: RunTerminalOutcome): RunEvidenceSummary {
  const accepted = outcome.kind === "accepted";
  return {
    configurationResolved: ledger.configurations.length > 0,
    providerInvoked: ledger.invocations.length > 0,
    invocations: ledger.invocations.length,
    candidatesCreated: ledger.candidates.length,
    verificationsPerformed: ledger.verifications.length,
    promotionsAttempted: ledger.promotions.length,
    promoted: accepted && ledger.promotions.length > 0,
    repositoryMutated: accepted && ledger.promotions.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Run result
// ---------------------------------------------------------------------------

/** What the canonical run function returns to any caller (CLI, server, REPL, tests). */
export interface V2RunResult {
  readonly taskId: V2TaskId;
  readonly runId: V2RunId;
  readonly goal: string;
  readonly repoPath: string;
  readonly outcome: RunTerminalOutcome;
  /**
   * THE normalized configuration this run resolved — the single input a future model
   * resolver receives. Absent when the run failed before configuration was built.
   */
  readonly policy?: RuntimeModelPolicy;
  /** Every transition the run made, in order. The run's own account of itself. */
  readonly journal: readonly LifecycleTransition[];
  readonly receipt: V2RunReceipt;
}

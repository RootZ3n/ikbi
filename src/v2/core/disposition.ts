/**
 * ikbi v2 — THE CANONICAL DISPOSITION / ADJUDICATION AUTHORITY (V2-010).
 *
 * ONE authority answers ONE question:
 *
 *   "Given THIS exact candidate, THIS exact VerificationRecord, THIS exact CriticRecord,
 *    and THIS explicit policy — what is the lawful disposition of the candidate?"
 *
 * It consumes evidence and produces one authoritative decision. It does NOT mutate, repair,
 * invoke a model, re-run verification, re-run the critic, promote, choose a provider, or
 * choose a model. `eligibleForPromotion=true` is an AUTHORIZATION FACT — never a promotion.
 * The mechanical publication is a LATER authority (V2-012). Whether to repair/retry is a
 * LATER authority (V2-011). This module decides what SHOULD happen next; it never does it.
 *
 * THE LOAD-BEARING INVARIANT: no single evidence source overrides another. A happy critic
 * cannot turn a red deterministic verification green; a passing verifier cannot erase a
 * concrete critic defect. Deterministic verification is evaluated FIRST and outranks the
 * semantic judgment — exactly the v1 adjudication-core posture, rebuilt with v2 identities.
 *
 * PURITY. `adjudicate` is pure and total: same evidence + same policy ⇒ same decision, no
 * I/O, no clock, no model. `judgeDisposition` wraps it with an injected tree re-probe (the
 * only I/O, mirroring the critic's drift check) because disposition is a fresh authority
 * boundary and must not adjudicate over a workspace that moved since the critic looked.
 */

import {
  contentDigest,
  type V2CandidateId,
  type V2CriticId,
  type V2DispositionId,
  type V2DispositionPolicyDigest,
  type V2RunId,
  type V2SnapshotDigest,
  type V2TaskId,
  type V2VerificationId,
} from "./identity.js";
import type { CandidateRecord } from "./candidate.js";
import type { VerificationRecord, VerificationVerdict } from "./verification.js";
import type { CriticRecord, CriticVerdict } from "./critic.js";
import { runFailure, type RunFailure } from "./failure.js";

// ---------------------------------------------------------------------------
// Policy — the explicit rules, content-addressed
// ---------------------------------------------------------------------------

/**
 * THE explicit disposition policy. Small and closed on purpose: it models exactly the
 * knobs this slice needs, not every future governance rule. Every field is a NAMED policy
 * fact, never a fallback for missing evidence.
 *
 * The two base requirements (`requireVerificationPass`, `requireCriticSatisfied`) describe
 * the safe default posture and are documented for auditability; the base matrix already
 * enforces "deterministic red always blocks" and "a concrete defect always withholds", so
 * relaxing them is not offered here — there is no safe override that lets a red verifier or
 * a defect promote, and inventing one only to exercise a test would be a hole.
 *
 * The knobs that DO vary the decision — and therefore the disposition IDENTITY — are the
 * two permissions: `allowNoChecks` (a repository with no verifiable checks may still be
 * eligible when the operator has explicitly said so) and `allowIndeterminateCritic` (an
 * unproven semantic judgment may still be eligible under explicit permission).
 */
export interface DispositionPolicy {
  readonly policyId: V2DispositionPolicyDigest;
  /** Deterministic verification must PASS to be eligible. Always true in this slice (documented, not overridable). */
  readonly requireVerificationPass: boolean;
  /** The critic must be SATISFIED to be eligible. Always true in this slice (documented, not overridable). */
  readonly requireCriticSatisfied: boolean;
  /** A NO_CHECKS candidate may be considered eligible (given a satisfied critic) rather than withheld. */
  readonly allowNoChecks: boolean;
  /** An INDETERMINATE critic (on a passing verification) may be considered eligible rather than withheld. */
  readonly allowIndeterminateCritic: boolean;
  /** Autonomous eligibility is permitted at all. When false, an otherwise-eligible candidate is withheld for the operator. */
  readonly autonomousPromotionAllowed: boolean;
  /** An infrastructure-failure verification is a recovery/operator condition (quarantine), not an ordinary defect. */
  readonly quarantineOnInfrastructureFailure: boolean;
}

/** The normalized policy inputs (everything but the derived identity). */
export type DispositionPolicyInput = Omit<DispositionPolicy, "policyId">;

/** The SAFE default posture: nothing lands without deterministic pass AND a satisfied critic. */
export const DEFAULT_DISPOSITION_POLICY_INPUT: DispositionPolicyInput = {
  requireVerificationPass: true,
  requireCriticSatisfied: true,
  allowNoChecks: false,
  allowIndeterminateCritic: false,
  autonomousPromotionAllowed: true,
  quarantineOnInfrastructureFailure: true,
};

/** Content address of a policy — the normalized rules, nothing else. */
export function dispositionPolicyDigest(input: DispositionPolicyInput): V2DispositionPolicyDigest {
  return contentDigest("disposition_policy", {
    requireVerificationPass: input.requireVerificationPass,
    requireCriticSatisfied: input.requireCriticSatisfied,
    allowNoChecks: input.allowNoChecks,
    allowIndeterminateCritic: input.allowIndeterminateCritic,
    autonomousPromotionAllowed: input.autonomousPromotionAllowed,
    quarantineOnInfrastructureFailure: input.quarantineOnInfrastructureFailure,
  });
}

/** Normalize partial overrides onto the safe defaults and content-address the result. */
export function buildDispositionPolicy(overrides: Partial<DispositionPolicyInput> = {}): DispositionPolicy {
  const input: DispositionPolicyInput = { ...DEFAULT_DISPOSITION_POLICY_INPUT, ...overrides };
  return { policyId: dispositionPolicyDigest(input), ...input };
}

/** The canonical safe policy, ready to use. */
export const DEFAULT_DISPOSITION_POLICY: DispositionPolicy = buildDispositionPolicy();

// ---------------------------------------------------------------------------
// Decision vocabulary
// ---------------------------------------------------------------------------

/**
 * THE lawful dispositions. `acceptable_for_promotion` AUTHORIZES eligibility — it does not
 * promote. `withhold` keeps verified work but does not publish it. `reject` refuses work
 * that is not verified-good (deterministic red). `quarantine` isolates a candidate whose
 * evidence is incomplete or whose tree is suspect — a recovery/operator condition.
 */
export type DispositionDecision =
  | "acceptable_for_promotion"
  | "withhold"
  | "reject"
  | "quarantine";

export const DISPOSITION_DECISIONS: readonly DispositionDecision[] = [
  "acceptable_for_promotion",
  "withhold",
  "reject",
  "quarantine",
] as const;

/**
 * Machine-readable reasons. Closed set — no free-text disposition. A decision names ONE
 * primary reason and may carry supporting reasons (e.g. a red verification whose critic
 * also found defects).
 */
export type DispositionReason =
  | "acceptable"
  | "verification_failed"
  | "critic_defects"
  | "critic_indeterminate"
  | "no_checks"
  | "verification_timeout"
  | "verification_infrastructure_failure"
  | "candidate_drift"
  | "check_mutated_candidate"
  | "policy_requires_operator";

export const DISPOSITION_REASONS: readonly DispositionReason[] = [
  "acceptable",
  "verification_failed",
  "critic_defects",
  "critic_indeterminate",
  "no_checks",
  "verification_timeout",
  "verification_infrastructure_failure",
  "candidate_drift",
  "check_mutated_candidate",
  "policy_requires_operator",
] as const;

// ---------------------------------------------------------------------------
// Subject — the immutable adjudication input, bound to exact evidence
// ---------------------------------------------------------------------------

/**
 * THE immutable subject an adjudication is authorized to decide. It binds every id the
 * decision rests on so a disposition can never be silently computed over mismatched
 * evidence. Building it is not the same as validating it — `validateDispositionSubject`
 * proves the three evidence records actually cohere.
 */
export interface DispositionSubject {
  readonly runId: V2RunId;
  readonly taskId: V2TaskId;
  readonly sourceSnapshotId: V2SnapshotDigest;
  readonly candidateId: V2CandidateId;
  readonly candidateTreeId: string;
  readonly verificationId: V2VerificationId;
  readonly criticId: V2CriticId;
  readonly policyId: V2DispositionPolicyDigest;
}

/** Assemble the subject from the exact bound records. Pure. */
export function dispositionSubjectOf(input: {
  readonly taskId: V2TaskId;
  readonly candidate: CandidateRecord;
  readonly verification: VerificationRecord;
  readonly critic: CriticRecord;
  readonly policyId: V2DispositionPolicyDigest;
}): DispositionSubject {
  return {
    runId: input.candidate.runId,
    taskId: input.taskId,
    sourceSnapshotId: input.candidate.sourceSnapshotId,
    candidateId: input.candidate.candidateId,
    candidateTreeId: input.candidate.tree.treeId,
    verificationId: input.verification.verificationId,
    criticId: input.critic.criticId,
    policyId: input.policyId,
  };
}

/**
 * Prove the subject and its three evidence records COHERE — same run, same candidate, same
 * tree, and each downstream record pointing at the one before it. Any mismatch is a wiring
 * defect, not an adjudicable candidate: it returns the reason so the caller fails the run
 * rather than deciding over stale or foreign evidence. PURE — no I/O.
 */
export function validateDispositionSubject(input: {
  readonly subject: DispositionSubject;
  readonly candidate: CandidateRecord;
  readonly verification: VerificationRecord;
  readonly critic: CriticRecord;
}): { readonly ok: true } | { readonly ok: false; readonly problem: string } {
  const { subject, candidate, verification, critic } = input;
  const bad = (problem: string) => ({ ok: false as const, problem });

  if (subject.candidateId !== candidate.candidateId) return bad(`subject names candidate ${subject.candidateId}, not ${candidate.candidateId}`);
  if (subject.candidateTreeId !== candidate.tree.treeId) return bad(`subject tree ${subject.candidateTreeId} is not the candidate tree ${candidate.tree.treeId}`);
  if (subject.runId !== candidate.runId) return bad(`subject run ${subject.runId} is not the candidate run ${candidate.runId}`);
  if (subject.sourceSnapshotId !== candidate.sourceSnapshotId) return bad(`subject snapshot ${subject.sourceSnapshotId} is not the candidate snapshot ${candidate.sourceSnapshotId}`);

  if (verification.candidateId !== candidate.candidateId) return bad(`verification judged candidate ${verification.candidateId}, not ${candidate.candidateId}`);
  if (verification.candidateTreeId !== candidate.tree.treeId) return bad(`verification judged tree ${verification.candidateTreeId}, not the candidate tree ${candidate.tree.treeId}`);
  if (verification.runId !== candidate.runId) return bad(`verification belongs to run ${verification.runId}, not ${candidate.runId}`);
  if (subject.verificationId !== verification.verificationId) return bad(`subject names verification ${subject.verificationId}, not ${verification.verificationId}`);

  if (critic.candidateId !== candidate.candidateId) return bad(`critic judged candidate ${critic.candidateId}, not ${candidate.candidateId}`);
  if (critic.candidateTreeId !== candidate.tree.treeId) return bad(`critic judged tree ${critic.candidateTreeId}, not the candidate tree ${candidate.tree.treeId}`);
  if (critic.verificationId !== verification.verificationId) return bad(`critic rests on verification ${critic.verificationId}, not ${verification.verificationId}`);
  if (critic.runId !== candidate.runId) return bad(`critic belongs to run ${critic.runId}, not ${candidate.runId}`);
  if (subject.criticId !== critic.criticId) return bad(`subject names critic ${subject.criticId}, not ${critic.criticId}`);

  return { ok: true };
}

// ---------------------------------------------------------------------------
// The pure decision
// ---------------------------------------------------------------------------

/** One decision plus the reasons that produced it. */
export interface AdjudicationOutcome {
  readonly decision: DispositionDecision;
  readonly primaryReason: DispositionReason;
  readonly supportingReasons: readonly DispositionReason[];
}

/**
 * THE combined-evidence matrix. Pure, total, no I/O, no model.
 *
 * Ordering (deterministic verification FIRST — it outranks the semantic judgment):
 *
 *   candidate_drift              → quarantine (tree the verifier saw was not the candidate)
 *   workspace_mutated_by_checks  → quarantine (the checks changed the tree)
 *   infrastructure_failure       → quarantine (a check could not run; recovery/operator)
 *   timeout                      → quarantine (evidence incomplete; recovery/operator)
 *   fail                         → REJECT (deterministic red is never overridden by a happy critic)
 *   no_checks                    → withhold (no deterministic evidence) UNLESS policy.allowNoChecks,
 *                                  in which case the critic gate decides
 *   pass                         → the critic gate decides:
 *                                    satisfied      → acceptable_for_promotion
 *                                    defects_found  → withhold (green work is never discarded — v1 I1)
 *                                    indeterminate  → withhold UNLESS policy.allowIndeterminateCritic
 *
 * Two evidence sources, neither able to override the other: a red verifier blocks whatever
 * the critic said; a concrete defect withholds whatever the verifier said.
 */
export function adjudicate(input: {
  readonly verificationVerdict: VerificationVerdict;
  readonly criticVerdict: CriticVerdict;
  readonly policy: DispositionPolicy;
}): AdjudicationOutcome {
  const { verificationVerdict, criticVerdict, policy } = input;
  const supporting: DispositionReason[] = [];
  // A concrete critic defect is always worth recording as a supporting reason, even when a
  // deterministic verdict is the primary reason — the receipt then shows the full picture.
  if (criticVerdict === "defects_found") supporting.push("critic_defects");

  switch (verificationVerdict) {
    case "candidate_drift":
      return { decision: "quarantine", primaryReason: "candidate_drift", supportingReasons: supporting };
    case "workspace_mutated_by_checks":
      return { decision: "quarantine", primaryReason: "check_mutated_candidate", supportingReasons: supporting };
    case "infrastructure_failure":
      return { decision: "quarantine", primaryReason: "verification_infrastructure_failure", supportingReasons: supporting };
    case "timeout":
      return { decision: "quarantine", primaryReason: "verification_timeout", supportingReasons: supporting };
    case "fail":
      // Deterministic red. The critic cannot override it — REJECT regardless of the verdict.
      return { decision: "reject", primaryReason: "verification_failed", supportingReasons: supporting };
    case "no_checks":
      if (!policy.allowNoChecks) {
        return { decision: "withhold", primaryReason: "no_checks", supportingReasons: supporting };
      }
      // Policy explicitly accepts no-checks: fall through to the critic gate as if passed.
      return criticGate(criticVerdict, policy, ["no_checks", ...supporting]);
    case "pass":
      return criticGate(criticVerdict, policy, supporting);
  }
}

/** The critic half of the matrix — reached only when deterministic evidence is acceptable. */
function criticGate(
  criticVerdict: CriticVerdict,
  policy: DispositionPolicy,
  supporting: readonly DispositionReason[],
): AdjudicationOutcome {
  switch (criticVerdict) {
    case "satisfied":
      // Deterministic evidence acceptable AND semantic evidence supports acceptance.
      if (!policy.autonomousPromotionAllowed) {
        return { decision: "withhold", primaryReason: "policy_requires_operator", supportingReasons: supporting };
      }
      return { decision: "acceptable_for_promotion", primaryReason: "acceptable", supportingReasons: supporting };
    case "defects_found":
      // Green on merit, but a concrete semantic defect. Green work is WITHHELD, never
      // discarded (v1 invariant I1). `critic_defects` is already in `supporting`; promote it
      // to primary and drop the duplicate.
      return { decision: "withhold", primaryReason: "critic_defects", supportingReasons: supporting.filter((r) => r !== "critic_defects") };
    case "indeterminate":
      if (policy.allowIndeterminateCritic && policy.autonomousPromotionAllowed) {
        return { decision: "acceptable_for_promotion", primaryReason: "acceptable", supportingReasons: ["critic_indeterminate", ...supporting] };
      }
      return { decision: "withhold", primaryReason: "critic_indeterminate", supportingReasons: supporting };
  }
}

// ---------------------------------------------------------------------------
// Derived flags — one canonical decision, no boolean soup
// ---------------------------------------------------------------------------

/** The three secondary facts, DERIVED from the decision — never independently writable. */
export interface DispositionFlags {
  readonly eligibleForPromotion: boolean;
  readonly requiresRecovery: boolean;
  readonly requiresOperator: boolean;
}

/**
 * Derive the secondary flags from the ONE canonical decision + primary reason. There is no
 * public way to set them independently, so an impossible combination (e.g. eligible AND
 * requiresRecovery) cannot be constructed.
 */
export function deriveDispositionFlags(decision: DispositionDecision, primaryReason: DispositionReason): DispositionFlags {
  return {
    // Eligibility is EXCLUSIVELY the acceptable_for_promotion decision. Nothing else authorizes it.
    eligibleForPromotion: decision === "acceptable_for_promotion",
    // A quarantine on incomplete/transient evidence is a recovery condition; a suspect tree is too.
    requiresRecovery:
      decision === "quarantine" &&
      (primaryReason === "verification_timeout" ||
        primaryReason === "verification_infrastructure_failure" ||
        primaryReason === "candidate_drift" ||
        primaryReason === "check_mutated_candidate"),
    // Only an explicit operator-hold policy asks for a human. The default policy never does.
    requiresOperator: decision === "withhold" && primaryReason === "policy_requires_operator",
  };
}

// ---------------------------------------------------------------------------
// Record + identity
// ---------------------------------------------------------------------------

/** THE immutable account of one lawful disposition, bound to the exact evidence it judged. */
export interface DispositionRecord {
  readonly dispositionId: V2DispositionId;
  readonly runId: V2RunId;
  readonly taskId: V2TaskId;
  readonly candidateId: V2CandidateId;
  readonly candidateTreeId: string;
  readonly verificationId: V2VerificationId;
  readonly verificationVerdict: VerificationVerdict;
  readonly criticId: V2CriticId;
  readonly criticVerdict: CriticVerdict;
  readonly policyId: V2DispositionPolicyDigest;
  readonly decision: DispositionDecision;
  readonly primaryReason: DispositionReason;
  readonly supportingReasons: readonly DispositionReason[];
  readonly eligibleForPromotion: boolean;
  readonly requiresRecovery: boolean;
  readonly requiresOperator: boolean;
}

/**
 * Content address of a disposition: the exact evidence (candidate/tree/verification/critic),
 * the policy, the decision, and the reasons. EXCLUDES the run, the clock, and any incidental
 * logging — same evidence + same policy + same decision ⇒ same id.
 */
export function dispositionDigest(input: {
  readonly candidateId: V2CandidateId;
  readonly candidateTreeId: string;
  readonly verificationId: V2VerificationId;
  readonly criticId: V2CriticId;
  readonly policyId: V2DispositionPolicyDigest;
  readonly decision: DispositionDecision;
  readonly primaryReason: DispositionReason;
  readonly supportingReasons: readonly DispositionReason[];
}): V2DispositionId {
  return contentDigest("disposition", {
    candidateId: input.candidateId,
    candidateTreeId: input.candidateTreeId,
    verificationId: input.verificationId,
    criticId: input.criticId,
    policyId: input.policyId,
    decision: input.decision,
    primaryReason: input.primaryReason,
    supportingReasons: input.supportingReasons,
  });
}

/**
 * Build the record from the pure decision + the bound evidence. The three flags are DERIVED
 * here (never accepted as input), so the record cannot carry a flag that contradicts its
 * decision.
 */
export function buildDispositionRecord(input: {
  readonly runId: V2RunId;
  readonly taskId: V2TaskId;
  readonly candidate: CandidateRecord;
  readonly verification: VerificationRecord;
  readonly critic: CriticRecord;
  readonly policyId: V2DispositionPolicyDigest;
  readonly outcome: AdjudicationOutcome;
}): DispositionRecord {
  const { outcome } = input;
  const flags = deriveDispositionFlags(outcome.decision, outcome.primaryReason);
  return {
    dispositionId: dispositionDigest({
      candidateId: input.candidate.candidateId,
      candidateTreeId: input.candidate.tree.treeId,
      verificationId: input.verification.verificationId,
      criticId: input.critic.criticId,
      policyId: input.policyId,
      decision: outcome.decision,
      primaryReason: outcome.primaryReason,
      supportingReasons: outcome.supportingReasons,
    }),
    runId: input.runId,
    taskId: input.taskId,
    candidateId: input.candidate.candidateId,
    candidateTreeId: input.candidate.tree.treeId,
    verificationId: input.verification.verificationId,
    verificationVerdict: input.verification.verdict,
    criticId: input.critic.criticId,
    criticVerdict: input.critic.verdict,
    policyId: input.policyId,
    decision: outcome.decision,
    primaryReason: outcome.primaryReason,
    supportingReasons: outcome.supportingReasons,
    ...flags,
  };
}

// ---------------------------------------------------------------------------
// Failures + the wrapped authority
// ---------------------------------------------------------------------------

export const V2_DISPOSITION_FAILURE_CODES = {
  /** The evidence records do not cohere — a wiring defect, not an adjudicable candidate. */
  subjectMismatch: "disposition.subject_mismatch",
  /** The retained workspace tree moved since the critic looked — the evidence is stale. */
  subjectDrift: "disposition.subject_drift",
} as const;

/** A disposition-authority failure. Category `internal`: a coherence break is an engine defect. */
export function dispositionFailure(code: string, message: string, detail?: Readonly<Record<string, string | number | boolean>>): RunFailure {
  return runFailure({
    category: "internal",
    code,
    message,
    stage: "disposition",
    retryable: false,
    ...(detail !== undefined ? { detail } : {}),
  });
}

/** The result of asking the authority to dispose of a candidate. */
export type DispositionResult =
  | { readonly ok: true; readonly record: DispositionRecord }
  // A coherence break — the run fails (this is an engine defect, not a candidate outcome).
  | { readonly ok: false; readonly kind: "mismatch"; readonly failure: RunFailure }
  // The tree moved since the critic looked — the candidate is quarantined over a stale subject.
  | { readonly ok: false; readonly kind: "drift"; readonly detail: string; readonly currentTree: string };

/**
 * THE disposition authority. Validates the subject (mismatch ⇒ run fails), re-probes the
 * workspace tree (drift ⇒ quarantine over a stale subject — no ordinary decision), then
 * adjudicates the combined evidence under the policy and builds the record.
 *
 * The ONLY I/O is `probeTree` — a fresh authority boundary re-reads the tree rather than
 * trusting the critic's earlier probe. No model, no mutation, no promotion, no recovery.
 */
export async function judgeDisposition(input: {
  readonly runId: V2RunId;
  readonly taskId: V2TaskId;
  readonly candidate: CandidateRecord;
  readonly verification: VerificationRecord;
  readonly critic: CriticRecord;
  readonly policy: DispositionPolicy;
  readonly workspacePath: string;
  readonly probeTree: (path: string) => Promise<string>;
}): Promise<DispositionResult> {
  const subject = dispositionSubjectOf({
    taskId: input.taskId,
    candidate: input.candidate,
    verification: input.verification,
    critic: input.critic,
    policyId: input.policy.policyId,
  });

  const coherent = validateDispositionSubject({
    subject,
    candidate: input.candidate,
    verification: input.verification,
    critic: input.critic,
  });
  if (!coherent.ok) {
    return {
      ok: false,
      kind: "mismatch",
      failure: dispositionFailure(V2_DISPOSITION_FAILURE_CODES.subjectMismatch, `refusing to adjudicate: ${coherent.problem}`, {
        candidateId: input.candidate.candidateId,
      }),
    };
  }

  // FRESH BOUNDARY RE-PROBE. The critic rechecked the tree before its call, but disposition
  // is a separate authority: re-read the workspace now. A tree that moved since the critic
  // looked is a stale subject — quarantine it, do NOT adjudicate over it, and do NOT
  // auto-reverify (that is verification's job, not ours).
  let currentTree: string;
  try {
    currentTree = await input.probeTree(input.workspacePath);
  } catch (err) {
    return {
      ok: false,
      kind: "drift",
      detail: `cannot read the candidate workspace: ${err instanceof Error ? err.message : String(err)}`,
      currentTree: "",
    };
  }
  if (currentTree !== input.candidate.tree.treeId) {
    return {
      ok: false,
      kind: "drift",
      detail: `the retained workspace tree ${currentTree} no longer matches the candidate tree ${input.candidate.tree.treeId}`,
      currentTree,
    };
  }
  // A verification that ended on a different tree than the candidate is also stale evidence.
  if (input.verification.treeAfterChecks !== input.candidate.tree.treeId) {
    return {
      ok: false,
      kind: "drift",
      detail: `verification ended on tree ${input.verification.treeAfterChecks}, not the candidate tree ${input.candidate.tree.treeId}`,
      currentTree,
    };
  }

  const outcome = adjudicate({
    verificationVerdict: input.verification.verdict,
    criticVerdict: input.critic.verdict,
    policy: input.policy,
  });

  return {
    ok: true,
    record: buildDispositionRecord({
      runId: input.runId,
      taskId: input.taskId,
      candidate: input.candidate,
      verification: input.verification,
      critic: input.critic,
      policyId: input.policy.policyId,
      outcome,
    }),
  };
}

// ---------------------------------------------------------------------------
// Receipt projection
// ---------------------------------------------------------------------------

/** The receipt/audit projection of a disposition — ids, verdicts, decision, reasons. No bodies. */
export interface RunDispositionSummary {
  readonly dispositionId: V2DispositionId;
  readonly candidateId: V2CandidateId;
  readonly candidateTreeId: string;
  readonly verificationId: V2VerificationId;
  readonly verificationVerdict: VerificationVerdict;
  readonly criticId: V2CriticId;
  readonly criticVerdict: CriticVerdict;
  readonly policyId: V2DispositionPolicyDigest;
  readonly decision: DispositionDecision;
  readonly primaryReason: DispositionReason;
  readonly supportingReasons: readonly DispositionReason[];
  readonly eligibleForPromotion: boolean;
  readonly requiresRecovery: boolean;
  readonly requiresOperator: boolean;
}

export function summarizeDisposition(record: DispositionRecord): RunDispositionSummary {
  return {
    dispositionId: record.dispositionId,
    candidateId: record.candidateId,
    candidateTreeId: record.candidateTreeId,
    verificationId: record.verificationId,
    verificationVerdict: record.verificationVerdict,
    criticId: record.criticId,
    criticVerdict: record.criticVerdict,
    policyId: record.policyId,
    decision: record.decision,
    primaryReason: record.primaryReason,
    supportingReasons: record.supportingReasons,
    eligibleForPromotion: record.eligibleForPromotion,
    requiresRecovery: record.requiresRecovery,
    requiresOperator: record.requiresOperator,
  };
}

/**
 * ikbi v2 — THE CANONICAL PROMOTION / PUBLICATION AUTHORITY (V2-011).
 *
 * ONE authority mechanically publishes an ALREADY-AUTHORIZED candidate. It does NOT
 * re-adjudicate. Its only question is:
 *
 *   "Given an already-authorized DispositionRecord, can THIS exact candidate be mechanically
 *    published to the authorized target WITHOUT changing the meaning of what was verified?"
 *
 * It may NOT reinterpret verification or the critic, change policy, call a model, repair,
 * mutate the candidate, re-run checks, choose a provider, broaden scope, or silently
 * integrate a different tree. Disposition decides WHETHER publication is authorized;
 * promotion decides whether that authorization can be mechanically PERFORMED exactly.
 *
 * PUBLICATION SEMANTICS — CLEAN-REF CAS ONLY (V2-011 decision).
 *   The candidate tree is committed on the authorized base commit and the target branch ref
 *   is moved by a compare-and-swap. This lands EXACTLY `candidate.tree.treeId` — no merge, no
 *   approximate diff. It is offered ONLY for a CLEAN source snapshot: a dirty operator
 *   checkout means the candidate tree also contains the operator's pre-existing uncommitted
 *   work, and folding that into an ikbi-authored commit as a side effect of promotion is
 *   forbidden. A dirty snapshot is REFUSED (nothing touched) and stays WITHHELD; an explicit
 *   dirty-worktree publication mechanism is a later slice.
 *
 * NO AUTO-MERGE. v2 has verified the candidate against exactly ONE source snapshot. If the
 * live target ref moved since capture, a merge would produce a NEW integrated tree that was
 * never verified or criticized — so promotion REFUSES a moved target. Re-capture, rebuild and
 * re-verify are recovery's job, not promotion's.
 *
 * PURITY OF DECISION. This module makes every refusal decision itself; the injected
 * `PromotionTarget` seam only READS git facts and performs the ONE atomic publish. No model,
 * no mutation of the candidate, no verification, no repair.
 */

import {
  contentDigest,
  type V2CandidateId,
  type V2CriticId,
  type V2DispositionId,
  type V2DispositionPolicyDigest,
  type V2PromotionId,
  type V2RunId,
  type V2SnapshotDigest,
  type V2TaskId,
  type V2VerificationId,
} from "./identity.js";
import type { CandidateRecord } from "./candidate.js";
import type { VerificationRecord } from "./verification.js";
import type { CriticRecord } from "./critic.js";
import type { DispositionRecord } from "./disposition.js";
import { runFailure, type RunFailure } from "./failure.js";

// ---------------------------------------------------------------------------
// Authorization subject — the immutable binding
// ---------------------------------------------------------------------------

/**
 * THE immutable authorization a promotion is allowed to enact. It carries every id the
 * publication rests on AND the disposition's `eligibleForPromotion` fact — promotion receives
 * no free-floating boolean saying "approved", it proves authorization FROM the disposition.
 */
export interface PromotionSubject {
  readonly runId: V2RunId;
  readonly taskId: V2TaskId;
  readonly candidateId: V2CandidateId;
  readonly candidateTreeId: string;
  readonly sourceSnapshotId: V2SnapshotDigest;
  readonly verificationId: V2VerificationId;
  readonly criticId: V2CriticId;
  readonly dispositionId: V2DispositionId;
  readonly dispositionPolicyId: V2DispositionPolicyDigest;
  readonly eligibleForPromotion: boolean;
}

/** Assemble the authorization subject from the exact bound records. Pure. */
export function promotionSubjectOf(input: {
  readonly taskId: V2TaskId;
  readonly candidate: CandidateRecord;
  readonly verification: VerificationRecord;
  readonly critic: CriticRecord;
  readonly disposition: DispositionRecord;
}): PromotionSubject {
  return {
    runId: input.candidate.runId,
    taskId: input.taskId,
    candidateId: input.candidate.candidateId,
    candidateTreeId: input.candidate.tree.treeId,
    sourceSnapshotId: input.candidate.sourceSnapshotId,
    verificationId: input.verification.verificationId,
    criticId: input.critic.criticId,
    dispositionId: input.disposition.dispositionId,
    dispositionPolicyId: input.disposition.policyId,
    eligibleForPromotion: input.disposition.eligibleForPromotion,
  };
}

/**
 * Prove the subject and its four evidence records COHERE and that the disposition AUTHORIZES
 * publication. Any mismatch is a wiring defect (a foreign candidate/verification/critic/
 * snapshot or a wrong tree); a non-eligible disposition is a refusal, not a bug. PURE.
 */
export function validatePromotionSubject(input: {
  readonly subject: PromotionSubject;
  readonly candidate: CandidateRecord;
  readonly verification: VerificationRecord;
  readonly critic: CriticRecord;
  readonly disposition: DispositionRecord;
}):
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: "mismatch"; readonly problem: string }
  | { readonly ok: false; readonly kind: "not_eligible"; readonly problem: string } {
  const { subject, candidate, verification, critic, disposition } = input;
  const bad = (problem: string) => ({ ok: false as const, kind: "mismatch" as const, problem });

  // Candidate ↔ subject.
  if (subject.candidateId !== candidate.candidateId) return bad(`subject names candidate ${subject.candidateId}, not ${candidate.candidateId}`);
  if (subject.candidateTreeId !== candidate.tree.treeId) return bad(`subject tree ${subject.candidateTreeId} is not the candidate tree ${candidate.tree.treeId}`);
  if (subject.runId !== candidate.runId) return bad(`subject run ${subject.runId} is not the candidate run ${candidate.runId}`);
  if (subject.sourceSnapshotId !== candidate.sourceSnapshotId) return bad(`subject snapshot ${subject.sourceSnapshotId} is not the candidate snapshot ${candidate.sourceSnapshotId}`);

  // Verification ↔ candidate.
  if (verification.candidateId !== candidate.candidateId) return bad(`verification judged candidate ${verification.candidateId}, not ${candidate.candidateId}`);
  if (verification.candidateTreeId !== candidate.tree.treeId) return bad(`verification judged tree ${verification.candidateTreeId}, not ${candidate.tree.treeId}`);
  if (subject.verificationId !== verification.verificationId) return bad(`subject names verification ${subject.verificationId}, not ${verification.verificationId}`);

  // Critic ↔ verification/candidate.
  if (critic.candidateId !== candidate.candidateId) return bad(`critic judged candidate ${critic.candidateId}, not ${candidate.candidateId}`);
  if (critic.verificationId !== verification.verificationId) return bad(`critic rests on verification ${critic.verificationId}, not ${verification.verificationId}`);
  if (subject.criticId !== critic.criticId) return bad(`subject names critic ${subject.criticId}, not ${critic.criticId}`);

  // Disposition ↔ everything.
  if (disposition.candidateId !== candidate.candidateId) return bad(`disposition adjudicated candidate ${disposition.candidateId}, not ${candidate.candidateId}`);
  if (disposition.candidateTreeId !== candidate.tree.treeId) return bad(`disposition adjudicated tree ${disposition.candidateTreeId}, not ${candidate.tree.treeId}`);
  if (disposition.verificationId !== verification.verificationId) return bad(`disposition weighed verification ${disposition.verificationId}, not ${verification.verificationId}`);
  if (disposition.criticId !== critic.criticId) return bad(`disposition weighed critic ${disposition.criticId}, not ${critic.criticId}`);
  if (subject.dispositionId !== disposition.dispositionId) return bad(`subject names disposition ${subject.dispositionId}, not ${disposition.dispositionId}`);
  if (subject.dispositionPolicyId !== disposition.policyId) return bad(`subject policy ${subject.dispositionPolicyId} is not the disposition policy ${disposition.policyId}`);

  // Authorization — the ONE fact that makes publication lawful. Proven FROM the record.
  if (!disposition.eligibleForPromotion || disposition.decision !== "acceptable_for_promotion") {
    return { ok: false, kind: "not_eligible", problem: `the disposition decision is "${disposition.decision}" (eligible=${disposition.eligibleForPromotion}) — not authorized for promotion` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The publication seam — the ONLY thing that touches git
// ---------------------------------------------------------------------------

/** Where a candidate would be published, resolved from the workspace's source binding. */
export interface PromotionTargetRef {
  /** Absolute path of the target repository. */
  readonly repositoryPath: string;
  /** The branch the candidate would land on. */
  readonly baseBranch: string;
  /** The exact commit the candidate was cut from — the authorized publication base. */
  readonly baseCommit: string;
}

/**
 * Journal write status (V2-016). A best-effort filesystem journal MAY fail; that failure is now
 * VISIBLE rather than swallowed. The git ref/tree remains the authoritative landing proof — a
 * journal failure never turns a landed CAS into a failure — but the receipt reports it truthfully.
 */
export type JournalWriteStatus = "written" | "failed" | "not_attempted";

/**
 * The fresh post-CAS reprobe (V2-016): after the ref moved, the seam FRESHLY re-reads the
 * authoritative branch ref and its tree. `verified` iff `ref == afterCommit` AND
 * `ref^{tree} == candidateTreeId`. A mismatch means the repository changed under us — a DEGRADED
 * landing (reconciliation required), never a clean success and never "nothing happened".
 */
export interface PostCasReprobe {
  readonly verified: boolean;
  readonly observedRef?: string;
  readonly observedTree?: string;
  readonly detail?: string;
}

/** What the seam's atomic publish did. `landed_desynced` is a DEGRADED SUCCESS: the ref moved. */
export type PublicationOutcome =
  | { readonly kind: "landed"; readonly beforeRef: string; readonly afterCommit: string; readonly publishedTree: string; readonly worktreeSynced: boolean; readonly stashed: boolean; readonly journalIntentStatus: JournalWriteStatus; readonly journalLandedStatus: JournalWriteStatus; readonly postCas: PostCasReprobe }
  | { readonly kind: "landed_desynced"; readonly beforeRef: string; readonly afterCommit: string; readonly publishedTree: string; readonly detail: string; readonly journalIntentStatus: JournalWriteStatus; readonly journalLandedStatus: JournalWriteStatus; readonly postCas: PostCasReprobe }
  | { readonly kind: "cas_conflict"; readonly observedHead: string }
  | { readonly kind: "tree_mismatch"; readonly builtTree: string }
  | { readonly kind: "infrastructure_failure"; readonly detail: string };

/**
 * THE git seam. It READS facts (so the pure authority can refuse) and performs the ONE atomic
 * publish. It never decides eligibility, never merges, never mutates the candidate.
 */
export interface PromotionTarget {
  /**
   * The CANONICAL identity of the target repository (V2-016): a stable string that is the same
   * across the repo's worktrees and lexical path aliases, distinct for different repositories, and
   * changes when the path is swapped to a different repo (symlink swap). Undefined if the path is
   * not a readable git repository. Resolved at authorization AND re-resolved at the publish
   * boundary so a swapped target is refused before any CAS.
   */
  repositoryIdentity(target: PromotionTargetRef): Promise<string | undefined>;
  /** The commit the target branch currently points at, or undefined if the branch is absent. */
  liveHead(target: PromotionTargetRef): Promise<string | undefined>;
  /** The git tree of a commit — used for idempotency (does the live head already hold the candidate tree?). */
  treeOfCommit(input: { readonly repositoryPath: string; readonly commit: string }): Promise<string | undefined>;
  /** The checkout state of the target branch: is it checked out, and is that worktree clean? */
  targetCheckout(target: PromotionTargetRef): Promise<{ readonly checkedOutPath?: string; readonly clean: boolean }>;
  /**
   * Publish EXACTLY the candidate tree: commit(tree=candidateTreeId, parent=baseCommit),
   * verify the built commit's tree equals candidateTreeId BEFORE any ref move, CAS the target
   * ref beforeRef→commit, then sync a clean checked-out worktree. Atomic at the CAS.
   */
  publish(input: {
    readonly target: PromotionTargetRef;
    readonly expectedHead: string;
    readonly candidateTreeId: string;
    readonly message: string;
  }): Promise<PublicationOutcome>;
}

// ---------------------------------------------------------------------------
// Result + record
// ---------------------------------------------------------------------------

/** How a publication ENDED. Distinct kinds — "nothing happened" is never conflated with "ref moved". */
export type PromotionResult =
  | { readonly kind: "promoted"; readonly record: PromotionRecord }
  | { readonly kind: "already_promoted"; readonly record: PromotionRecord }
  | { readonly kind: "promoted_degraded"; readonly record: PromotionRecord; readonly detail: string }
  | { readonly kind: "refused_not_eligible"; readonly detail: string }
  | { readonly kind: "refused_wrong_evidence"; readonly failure: RunFailure }
  | { readonly kind: "refused_candidate_drift"; readonly detail: string; readonly observedTree: string }
  | { readonly kind: "refused_stale_target"; readonly detail: string; readonly expectedHead: string; readonly observedHead: string }
  | { readonly kind: "refused_target_worktree_dirty"; readonly detail: string }
  | { readonly kind: "refused_dirty_source_unsupported"; readonly detail: string }
  | { readonly kind: "cas_conflict"; readonly detail: string; readonly observedHead: string }
  | { readonly kind: "infrastructure_failure"; readonly failure: RunFailure };

/** The publication STRATEGY. Only one exists in this slice. */
export type PublicationStrategy = "clean_ref_cas";

/** THE immutable account of one publication — what was authorized AND what actually landed. */
export interface PromotionRecord {
  readonly promotionId: V2PromotionId;
  readonly runId: V2RunId;
  readonly candidateId: V2CandidateId;
  readonly candidateTreeId: string;
  readonly sourceSnapshotId: V2SnapshotDigest;
  readonly verificationId: V2VerificationId;
  readonly criticId: V2CriticId;
  readonly dispositionId: V2DispositionId;
  /** Provenance/display: the absolute path the target was reached through. NOT the identity. */
  readonly targetRepositoryPath: string;
  /**
   * The CANONICAL target repository identity (V2-016) — bound into `promotionId`. Distinguishes
   * repo A/main from repo B/main even when candidate/disposition/tree are identical.
   */
  readonly targetRepositoryIdentity: string;
  readonly targetBranch: string;
  readonly strategy: PublicationStrategy;
  /** The target ref BEFORE publication — the undo/audit anchor. */
  readonly beforeRef: string;
  /** The target ref AFTER publication — the landed commit. */
  readonly afterRef: string;
  /** The tree that became authoritative. MUST equal `candidateTreeId`. */
  readonly publishedTree: string;
  /** Whether a checked-out target worktree was brought forward to the landed commit. */
  readonly worktreeSynced: boolean;
  /** True when this call detected the exact candidate was ALREADY landed and did not re-publish. */
  readonly idempotent: boolean;
  /** A degraded landing: the ref moved but post-CAS bookkeeping did not fully complete. */
  readonly degraded: boolean;
  /** V2-016 — whether the pre-CAS intent / post-CAS landed journal markers were durably written. */
  readonly journalIntentStatus: JournalWriteStatus;
  readonly journalLandedStatus: JournalWriteStatus;
  /**
   * V2-016 — whether the FRESH post-CAS reprobe confirmed `ref == afterRef` AND `ref^{tree} ==
   * candidateTreeId`. False means the repository changed after the CAS (reconciliation required),
   * never that nothing happened. True for an already-authoritative idempotent landing.
   */
  readonly postCasVerified: boolean;
  readonly promotedAt: number;
}

/**
 * Content address of a publication: what was AUTHORIZED (candidate tree, disposition,
 * snapshot) and what LANDED (target branch, published tree). The commit sha, the clock and
 * the run are provenance — the SAME candidate published to the SAME target is the SAME
 * promotion identity, which is exactly what an idempotent re-request must reproduce.
 */
export function promotionRecordDigest(input: {
  readonly candidateId: V2CandidateId;
  readonly candidateTreeId: string;
  readonly dispositionId: V2DispositionId;
  readonly sourceSnapshotId: V2SnapshotDigest;
  /** The CANONICAL target repository identity (V2-016) — publishing to a different repo is a different promotion. */
  readonly targetRepositoryIdentity: string;
  readonly targetBranch: string;
  readonly publishedTree: string;
}): V2PromotionId {
  return contentDigest("promotion", {
    candidateId: input.candidateId,
    candidateTreeId: input.candidateTreeId,
    dispositionId: input.dispositionId,
    sourceSnapshotId: input.sourceSnapshotId,
    targetRepositoryIdentity: input.targetRepositoryIdentity,
    targetBranch: input.targetBranch,
    publishedTree: input.publishedTree,
  });
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export const V2_PROMOTION_FAILURE_CODES = {
  /** The evidence records do not cohere — a wiring defect, not a promotable candidate. */
  wrongEvidence: "promotion.wrong_evidence",
  /** The retained candidate workspace could not be read to recheck its tree. */
  workspaceUnreadable: "promotion.workspace_unreadable",
  /** The git publication seam failed to launch/execute — nothing landed. */
  publicationFailed: "promotion.publication_failed",
} as const;

function promotionFailure(code: string, message: string, detail?: Readonly<Record<string, string | number | boolean>>): RunFailure {
  return runFailure({
    category: "promotion",
    code,
    message,
    stage: "promotion",
    retryable: false,
    ...(detail !== undefined ? { detail } : {}),
  });
}

// ---------------------------------------------------------------------------
// The authority
// ---------------------------------------------------------------------------

/**
 * THE promotion authority. Proves authorization from the disposition, rechecks every mutable
 * fact at this fresh boundary, refuses anything unsafe WITHOUT touching git, and — only when
 * all checks pass — asks the seam to publish EXACTLY the candidate tree.
 *
 * Recheck order (all refusals happen before any git mutation):
 *   1. subject coherence + eligibility  (wrong_evidence / not_eligible)
 *   2. dirty source snapshot            (dirty_source_unsupported — unsupported mode, not a fault)
 *   3. candidate workspace tree drift   (candidate_drift)
 *   4. verification applies to the tree (candidate_drift — stale evidence)
 *   5. IDEMPOTENCY: live target already holds the candidate tree → already_promoted
 *   6. target staleness: live head ≠ authorized base → stale_target (NO auto-merge)
 *   7. dirty checked-out target worktree → target_worktree_dirty
 *   8. publish (commit + CAS + sync) → promoted / degraded / cas_conflict / infra
 */
export async function promoteAuthorized(input: {
  readonly taskId: V2TaskId;
  readonly candidate: CandidateRecord;
  readonly verification: VerificationRecord;
  readonly critic: CriticRecord;
  readonly disposition: DispositionRecord;
  readonly target: PromotionTargetRef;
  /** Whether the run's source snapshot was CLEAN. A dirty snapshot cannot use clean-ref CAS. */
  readonly sourceClean: boolean;
  readonly workspacePath: string;
  readonly probeTree: (path: string) => Promise<string>;
  readonly publisher: PromotionTarget;
  readonly now: () => number;
}): Promise<PromotionResult> {
  const { candidate, verification, critic, disposition, target } = input;
  const subject = promotionSubjectOf({ taskId: input.taskId, candidate, verification, critic, disposition });

  // 1. Coherence + authorization.
  const coherent = validatePromotionSubject({ subject, candidate, verification, critic, disposition });
  if (!coherent.ok && coherent.kind === "mismatch") {
    return { kind: "refused_wrong_evidence", failure: promotionFailure(V2_PROMOTION_FAILURE_CODES.wrongEvidence, `refusing to promote: ${coherent.problem}`, { candidateId: candidate.candidateId }) };
  }
  if (!coherent.ok) {
    return { kind: "refused_not_eligible", detail: coherent.problem };
  }

  // 2. Dirty source — clean-ref CAS cannot publish a candidate tree that also contains the
  //    operator's pre-existing uncommitted work without silently committing it. REFUSE (no git
  //    touch); the candidate stays retained and the disposition stays valid.
  if (!input.sourceClean) {
    return {
      kind: "refused_dirty_source_unsupported",
      detail: "the source checkout was dirty at capture; clean-ref CAS publication would fold the operator's uncommitted work into an ikbi commit — refusing (explicit dirty-worktree publication is a later slice)",
    };
  }

  // 3. Candidate workspace tree drift — the retained workspace must still be the exact tree.
  let currentTree: string;
  try {
    currentTree = await input.probeTree(input.workspacePath);
  } catch (err) {
    return { kind: "infrastructure_failure", failure: promotionFailure(V2_PROMOTION_FAILURE_CODES.workspaceUnreadable, `cannot read the candidate workspace: ${err instanceof Error ? err.message : String(err)}`, { candidateId: candidate.candidateId }) };
  }
  if (currentTree !== candidate.tree.treeId) {
    return { kind: "refused_candidate_drift", detail: `the retained workspace tree ${currentTree} no longer matches the candidate tree ${candidate.tree.treeId}`, observedTree: currentTree };
  }
  // 4. Verification must apply to this exact tree.
  if (verification.treeAfterChecks !== candidate.tree.treeId) {
    return { kind: "refused_candidate_drift", detail: `verification ended on tree ${verification.treeAfterChecks}, not the candidate tree ${candidate.tree.treeId}`, observedTree: verification.treeAfterChecks };
  }

  // 5-PRE. TARGET REPOSITORY IDENTITY (V2-016). Resolve the canonical repository identity NOW,
  //        at authorization, and bind it into the promotion identity. A target that is not a
  //        readable git repository cannot be published to.
  const authorizedRepoIdentity = await input.publisher.repositoryIdentity(target);
  if (authorizedRepoIdentity === undefined) {
    return { kind: "infrastructure_failure", failure: promotionFailure(V2_PROMOTION_FAILURE_CODES.publicationFailed, `the target repository at ${target.repositoryPath} could not be identified (not a readable git repository)`, { candidateId: candidate.candidateId }) };
  }

  // 5–6. Target facts.
  const liveHead = await input.publisher.liveHead(target);
  if (liveHead === undefined) {
    return { kind: "refused_stale_target", detail: `the target branch "${target.baseBranch}" does not exist`, expectedHead: target.baseCommit, observedHead: "<absent>" };
  }

  const record = (landed: { beforeRef: string; afterRef: string; publishedTree: string; worktreeSynced: boolean; idempotent: boolean; degraded: boolean; journalIntentStatus?: JournalWriteStatus; journalLandedStatus?: JournalWriteStatus; postCasVerified?: boolean }): PromotionRecord => ({
    promotionId: promotionRecordDigest({ candidateId: candidate.candidateId, candidateTreeId: candidate.tree.treeId, dispositionId: disposition.dispositionId, sourceSnapshotId: candidate.sourceSnapshotId, targetRepositoryIdentity: authorizedRepoIdentity, targetBranch: target.baseBranch, publishedTree: landed.publishedTree }),
    runId: candidate.runId,
    candidateId: candidate.candidateId,
    candidateTreeId: candidate.tree.treeId,
    sourceSnapshotId: candidate.sourceSnapshotId,
    verificationId: verification.verificationId,
    criticId: critic.criticId,
    dispositionId: disposition.dispositionId,
    targetRepositoryPath: target.repositoryPath,
    targetRepositoryIdentity: authorizedRepoIdentity,
    targetBranch: target.baseBranch,
    strategy: "clean_ref_cas",
    beforeRef: landed.beforeRef,
    afterRef: landed.afterRef,
    publishedTree: landed.publishedTree,
    worktreeSynced: landed.worktreeSynced,
    idempotent: landed.idempotent,
    degraded: landed.degraded,
    journalIntentStatus: landed.journalIntentStatus ?? "not_attempted",
    journalLandedStatus: landed.journalLandedStatus ?? "not_attempted",
    postCasVerified: landed.postCasVerified ?? landed.idempotent,
    promotedAt: input.now(),
  });

  // 5. IDEMPOTENCY — the live target already holds the exact candidate tree. Do NOT publish a
  //    second time; report the truthful already-landed state.
  const liveTree = await input.publisher.treeOfCommit({ repositoryPath: target.repositoryPath, commit: liveHead });
  if (liveTree === candidate.tree.treeId) {
    return { kind: "already_promoted", record: record({ beforeRef: liveHead, afterRef: liveHead, publishedTree: candidate.tree.treeId, worktreeSynced: true, idempotent: true, degraded: false }) };
  }

  // 6. Target staleness — the live head must still be the authorized base. NO AUTO-MERGE: a
  //    moved target means a merge would produce an unverified tree. Refuse; recovery re-captures.
  if (liveHead !== target.baseCommit) {
    return { kind: "refused_stale_target", detail: `the target moved since verification (authorized base ${target.baseCommit}, live head ${liveHead}) — re-verify against the new base before promoting`, expectedHead: target.baseCommit, observedHead: liveHead };
  }

  // 7. Dirty checked-out target worktree — moving the ref under it would desync it. Refuse.
  const checkout = await input.publisher.targetCheckout(target);
  if (checkout.checkedOutPath !== undefined && !checkout.clean) {
    return { kind: "refused_target_worktree_dirty", detail: `the target branch "${target.baseBranch}" is checked out at ${checkout.checkedOutPath} with uncommitted changes — refusing to promote (commit or stash there first)` };
  }

  // 7.5. SYMLINK-SWAP GUARD (V2-016). Re-resolve the target repository identity at the LAST moment
  //      before the CAS. If the path now resolves to a DIFFERENT repository than the one authorized
  //      (a symlink swapped under us between authorization and publish), REFUSE — never publish
  //      through a swapped path.
  const recheckedRepoIdentity = await input.publisher.repositoryIdentity(target);
  if (recheckedRepoIdentity !== authorizedRepoIdentity) {
    return {
      kind: "refused_stale_target",
      detail: `the target repository identity changed between authorization and publish (authorized ${authorizedRepoIdentity}, now ${recheckedRepoIdentity ?? "<unidentifiable>"}) — the path may have been redirected; refusing to publish`,
      expectedHead: target.baseCommit,
      observedHead: liveHead,
    };
  }

  // 8. Publish EXACTLY the candidate tree.
  const message = `ikbi: publish candidate ${candidate.candidateId.slice(0, 16)} (disposition ${disposition.dispositionId.slice(0, 12)})`;
  const outcome = await input.publisher.publish({ target, expectedHead: liveHead, candidateTreeId: candidate.tree.treeId, message });
  switch (outcome.kind) {
    case "landed": {
      const bookkeeping = { journalIntentStatus: outcome.journalIntentStatus, journalLandedStatus: outcome.journalLandedStatus, postCasVerified: outcome.postCas.verified };
      // Belt-and-braces: the seam already verified the built tree == candidate tree BEFORE the
      // CAS. Assert the landed tree once more, and require the FRESH post-CAS reprobe to confirm.
      if (outcome.publishedTree !== candidate.tree.treeId) {
        return { kind: "promoted_degraded", record: record({ beforeRef: outcome.beforeRef, afterRef: outcome.afterCommit, publishedTree: outcome.publishedTree, worktreeSynced: outcome.worktreeSynced, idempotent: false, degraded: true, ...bookkeeping }), detail: `LANDED TREE ${outcome.publishedTree} ≠ candidate tree ${candidate.tree.treeId} — the ref moved to an unexpected tree` };
      }
      // POST-CAS REPROBE (V2-016): the ref moved; if a fresh read no longer shows our commit/tree,
      // the repository changed under us — DEGRADED (reconciliation required), never a clean success.
      if (!outcome.postCas.verified) {
        return { kind: "promoted_degraded", record: record({ beforeRef: outcome.beforeRef, afterRef: outcome.afterCommit, publishedTree: outcome.publishedTree, worktreeSynced: outcome.worktreeSynced, idempotent: false, degraded: true, ...bookkeeping }), detail: outcome.postCas.detail ?? `the ref moved ${outcome.beforeRef}→${outcome.afterCommit} but a fresh post-CAS reprobe no longer confirms it (observed ref ${outcome.postCas.observedRef ?? "?"}, tree ${outcome.postCas.observedTree ?? "?"}) — another actor advanced the target; reconciliation required` };
      }
      // The landed journal failing is bookkeeping-degraded (the ref is authoritative regardless).
      const degraded = outcome.journalLandedStatus === "failed";
      return { kind: degraded ? "promoted_degraded" : "promoted", record: record({ beforeRef: outcome.beforeRef, afterRef: outcome.afterCommit, publishedTree: outcome.publishedTree, worktreeSynced: outcome.worktreeSynced, idempotent: false, degraded, ...bookkeeping }), ...(degraded ? { detail: "the ref landed and was reprobed successfully, but the post-CAS landed-journal write failed — bookkeeping only" } : {}) } as PromotionResult;
    }
    case "landed_desynced":
      // DEGRADED SUCCESS: the ref moved but the checked-out worktree did not sync. NEVER reported
      // as an ordinary failure — the repository changed.
      return { kind: "promoted_degraded", record: record({ beforeRef: outcome.beforeRef, afterRef: outcome.afterCommit, publishedTree: outcome.publishedTree, worktreeSynced: false, idempotent: false, degraded: true, journalIntentStatus: outcome.journalIntentStatus, journalLandedStatus: outcome.journalLandedStatus, postCasVerified: outcome.postCas.verified }), detail: outcome.detail };
    case "cas_conflict":
      return { kind: "cas_conflict", detail: `the target ref moved concurrently during the CAS (observed ${outcome.observedHead}) — no force, no retry`, observedHead: outcome.observedHead };
    case "tree_mismatch":
      // The commit ikbi built did not hold the candidate tree. Caught BEFORE the CAS — nothing landed.
      return { kind: "infrastructure_failure", failure: promotionFailure(V2_PROMOTION_FAILURE_CODES.publicationFailed, `the built publication commit held tree ${outcome.builtTree}, not the candidate tree ${candidate.tree.treeId} — refused before any ref move`, { candidateId: candidate.candidateId }) };
    case "infrastructure_failure":
      return { kind: "infrastructure_failure", failure: promotionFailure(V2_PROMOTION_FAILURE_CODES.publicationFailed, `publication could not complete: ${outcome.detail}`, { candidateId: candidate.candidateId }) };
  }
}

// ---------------------------------------------------------------------------
// Receipt projection
// ---------------------------------------------------------------------------

/** The receipt/audit projection of a promotion — ids, target, before/after, published tree. */
export interface RunPromotionSummary {
  readonly promotionId: V2PromotionId;
  readonly candidateId: V2CandidateId;
  readonly candidateTreeId: string;
  readonly dispositionId: V2DispositionId;
  readonly targetBranch: string;
  readonly strategy: PublicationStrategy;
  readonly beforeRef: string;
  readonly afterRef: string;
  readonly publishedTree: string;
  readonly worktreeSynced: boolean;
  readonly idempotent: boolean;
  readonly degraded: boolean;
  /** V2-016 — the canonical target repository identity bound into the promotion id. */
  readonly targetRepositoryIdentity: string;
  /** V2-016 — journal durability + fresh post-CAS reprobe, surfaced honestly on the receipt. */
  readonly journalIntentStatus: JournalWriteStatus;
  readonly journalLandedStatus: JournalWriteStatus;
  readonly postCasVerified: boolean;
}

export function summarizePromotion(record: PromotionRecord): RunPromotionSummary {
  return {
    promotionId: record.promotionId,
    candidateId: record.candidateId,
    candidateTreeId: record.candidateTreeId,
    dispositionId: record.dispositionId,
    targetBranch: record.targetBranch,
    strategy: record.strategy,
    beforeRef: record.beforeRef,
    afterRef: record.afterRef,
    publishedTree: record.publishedTree,
    worktreeSynced: record.worktreeSynced,
    idempotent: record.idempotent,
    degraded: record.degraded,
    targetRepositoryIdentity: record.targetRepositoryIdentity,
    journalIntentStatus: record.journalIntentStatus,
    journalLandedStatus: record.journalLandedStatus,
    postCasVerified: record.postCasVerified,
  };
}

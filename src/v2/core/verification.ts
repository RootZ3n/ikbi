/**
 * ikbi v2 — THE CANONICAL VERIFICATION AUTHORITY.
 *
 * It answers exactly one question:
 *
 *     "Did THIS candidate — this exact tree — satisfy the deterministic verification
 *      contract, under a plan decided before anything ran?"
 *
 * Not "does the workspace happen to pass now", not "did the builder say it worked", not
 * "can a critic imagine it is fine". The subject is IDENTITY-BOUND: every step names the
 * candidate tree it is about, and a VerificationRecord is content-addressed over that tree,
 * so it is provably applicable to one candidate and no other.
 *
 * DETERMINISTIC ONLY. No model is invoked here — no critic, refuter, judge, fixer or
 * scout. The only thing that happens is: recompute the candidate tree, plan the checks,
 * run them bounded, recompute the tree, and classify. A failed verification ends the run;
 * builder re-entry and recovery are a LATER authority and are deliberately absent.
 *
 * TWO TREE RECHECKS FRAME THE CHECKS, and they are the load-bearing guarantees:
 *
 *   BEFORE — the workspace tree must still equal `candidate.tree.treeId`. If something
 *            moved it (an external process, a stray write, a stale retained workspace),
 *            NO check runs and the verdict is `candidate_drift`. We never "verify what is
 *            there"; we verify what the candidate says it is.
 *   AFTER  — the workspace tree must be UNCHANGED by the checks themselves. A green test
 *            suite that rewrote the thing it was testing has not verified the candidate —
 *            it verified something else. That is `workspace_mutated_by_checks`, whatever
 *            the exit codes said.
 *
 * This file is PURE: contracts, plan/record identity, verdict aggregation, and an
 * orchestration over injected seams (`ChecksSource`, `CheckRunner`, `TreeProbe`). The
 * governed execution, the git tree capture and the filesystem check discovery live in
 * `src/v2/runtime/`.
 */

import { contentDigest, type V2CandidateId, type V2PlanDigest, type V2RunId, type V2SnapshotDigest, type V2VerificationId, type V2WorkspaceId } from "./identity.js";
import { runFailure, type RunFailure } from "./failure.js";
import type { CandidateRecord } from "./candidate.js";

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

/**
 * THE thing being verified, bound to its identity.
 *
 * Every field here is something a mismatch would make the verification meaningless — a
 * candidate from another run, a workspace that is not the candidate's, a tree that is not
 * the one the candidate froze. The verifier refuses on any mismatch rather than silently
 * verifying whatever is in front of it.
 */
export interface VerificationSubject {
  readonly runId: V2RunId;
  readonly candidateId: V2CandidateId;
  readonly candidateTreeId: string;
  readonly workspaceId: V2WorkspaceId;
  readonly sourceSnapshotId: V2SnapshotDigest;
}

/** Derive the subject from a candidate record — the one honest way to build one. */
export function verificationSubjectOf(candidate: CandidateRecord): VerificationSubject {
  return {
    runId: candidate.runId,
    candidateId: candidate.candidateId,
    candidateTreeId: candidate.tree.treeId,
    workspaceId: candidate.workspaceId,
    sourceSnapshotId: candidate.sourceSnapshotId,
  };
}

/**
 * Refuse a subject that does not describe THIS candidate for THIS run.
 *
 * Returns a failure to refuse, or undefined to proceed. This is the "cannot verify
 * someone else's work" guard, checked before any I/O.
 */
export function validateSubject(subject: VerificationSubject, candidate: CandidateRecord, runId: V2RunId): RunFailure | undefined {
  const problem =
    subject.runId !== runId
      ? `the verification subject belongs to run ${subject.runId}, not ${runId}`
      : candidate.runId !== runId
        ? `the candidate belongs to run ${candidate.runId}, not ${runId}`
        : subject.candidateId !== candidate.candidateId
          ? `the subject names candidate ${subject.candidateId}, not the produced ${candidate.candidateId}`
          : subject.candidateTreeId !== candidate.tree.treeId
            ? `the subject's tree ${subject.candidateTreeId} is not the candidate's tree ${candidate.tree.treeId}`
            : subject.workspaceId !== candidate.workspaceId
              ? `the subject names workspace ${subject.workspaceId}, not the candidate's ${candidate.workspaceId}`
              : subject.sourceSnapshotId !== candidate.sourceSnapshotId
                ? `the subject's source snapshot ${subject.sourceSnapshotId} is not the candidate's ${candidate.sourceSnapshotId}`
                : undefined;
  if (problem === undefined) return undefined;
  return verificationFailure(V2_VERIFICATION_FAILURE_CODES.subjectMismatch, `refusing to verify: ${problem}`, {
    candidateId: subject.candidateId,
  });
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/** One check as the plan fixes it. The command is a named list — never model-chosen. */
export interface PlannedCheck {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

/**
 * Where checks run. Deliberately a LABEL, not a path: the identity of a plan must not move
 * because a scratch root was relocated. There is exactly one policy today.
 */
export type CwdPolicy = "candidate_workspace_root";

/** How the check set was chosen — operator config, or deterministic discovery. */
export type ChecksSourceKind = "env" | "default";

/**
 * THE immutable plan. Generated in full BEFORE anything executes: checks are never
 * discovered ad hoc halfway through a run, so the plan the record cites is exactly the
 * plan that ran.
 */
export interface VerificationPlan {
  readonly planId: V2PlanDigest;
  readonly checks: readonly PlannedCheck[];
  readonly cwdPolicy: CwdPolicy;
  readonly source: ChecksSourceKind;
}

/**
 * Content address of a plan: the ordered checks, how each is bounded, where they run, and
 * where the set came from. NOT the absolute workspace path and NOT any clock — the same
 * plan in a relocated checkout is the same plan.
 */
export function verificationPlanDigest(input: {
  readonly checks: readonly PlannedCheck[];
  readonly cwdPolicy: CwdPolicy;
  readonly source: ChecksSourceKind;
}): V2PlanDigest {
  return contentDigest("verification_plan", {
    cwdPolicy: input.cwdPolicy,
    source: input.source,
    checks: input.checks.map((c) => ({ name: c.name, command: c.command, args: [...c.args], timeoutMs: c.timeoutMs })),
  });
}

/** Build the plan from a resolved check set. Order is preserved from discovery. */
export function buildVerificationPlan(input: {
  readonly checks: readonly { readonly name: string; readonly command: string; readonly args: readonly string[] }[];
  readonly timeoutMs: number;
  readonly source: ChecksSourceKind;
}): VerificationPlan {
  const checks: PlannedCheck[] = input.checks.map((c) => ({ name: c.name, command: c.command, args: [...c.args], timeoutMs: input.timeoutMs }));
  const cwdPolicy: CwdPolicy = "candidate_workspace_root";
  return { planId: verificationPlanDigest({ checks, cwdPolicy, source: input.source }), checks, cwdPolicy, source: input.source };
}

// ---------------------------------------------------------------------------
// Seams (implemented in the runtime layer)
// ---------------------------------------------------------------------------

/** What discovering the check set produced. Fail-closed: a reason, never a guessed command. */
export type ResolvedChecks =
  | { readonly ok: true; readonly checks: readonly { readonly name: string; readonly command: string; readonly args: readonly string[] }[]; readonly source: ChecksSourceKind }
  | { readonly ok: false; readonly reason: string };

/** Deterministic check discovery over a workspace. No model, no repository prose. */
export interface ChecksSource {
  resolve(workspacePath: string): Promise<ResolvedChecks>;
}

/**
 * What running one check produced, as the governed executor reports it. The runtime
 * adapter hashes the output (so the core never handles raw bytes) and states plainly
 * whether the command actually launched.
 */
export interface CheckExecution {
  /** Did the command actually run? False for a denied/dry-run/launch failure. */
  readonly launched: boolean;
  /** Present iff launched. */
  readonly exitCode?: number;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** SHA-256 of the full captured output. Bounded excerpt below; never the whole log. */
  readonly outputSha256: string;
  readonly outputExcerpt: string;
  /** Why the command did not launch, when it did not. */
  readonly refusedReason?: string;
}

/** THE governed check executor. One authorized command in, one bounded result out. */
export interface CheckRunner {
  run(input: {
    readonly name: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly timeoutMs: number;
  }): Promise<CheckExecution>;
}

/** Recompute a workspace's git tree id — the same mechanism candidate capture used. */
export interface TreeProbe {
  treeOf(workspacePath: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** How one check ended. Timeout and infrastructure are NOT ordinary failures. */
export type CheckStatus = "pass" | "fail" | "timeout" | "infrastructure_failure";

/** The durable account of one check. Output is a hash plus a bounded excerpt, never a dump. */
export interface CheckRecord {
  readonly name: string;
  /** The rendered command line ("binary arg1 arg2"), for audit. */
  readonly command: string;
  readonly status: CheckStatus;
  /** Present iff the command launched. */
  readonly exitCode?: number;
  readonly durationMs: number;
  readonly outputSha256: string;
  readonly outputExcerpt: string;
}

/**
 * The aggregate verdict.
 *
 *   pass / fail                 checks ran and (all passed) / (at least one failed).
 *   no_checks                   nothing verifiable was found. NOT a pass — whether that
 *                               is acceptable is a later disposition question.
 *   timeout                     a check exceeded its bound; the candidate is indeterminate.
 *   infrastructure_failure      a check could not run at all (denied binary, launch error).
 *   candidate_drift             the workspace tree did not match the candidate BEFORE checks.
 *   workspace_mutated_by_checks the checks changed the tree; the result is not about this
 *                               candidate.
 */
export type VerificationVerdict =
  | "pass"
  | "fail"
  | "no_checks"
  | "timeout"
  | "infrastructure_failure"
  | "candidate_drift"
  | "workspace_mutated_by_checks";

/** A verdict that means the checks either did not run or do not apply to this candidate. */
export function isConclusive(verdict: VerificationVerdict): boolean {
  return verdict === "pass" || verdict === "fail";
}

/**
 * Aggregate ordered check statuses into a verdict, RUN-ALL semantics.
 *
 * Every selected check runs (within budget) so the record shows the full deterministic
 * defect set. Precedence when statuses mix: an INFRASTRUCTURE failure or a TIMEOUT means
 * the evidence is incomplete, so neither a clean pass nor an honest fail can be claimed —
 * they outrank `fail`, which outranks `pass`.
 */
export function aggregateCheckVerdict(checks: readonly CheckRecord[]): VerificationVerdict {
  if (checks.length === 0) return "no_checks";
  if (checks.some((c) => c.status === "infrastructure_failure")) return "infrastructure_failure";
  if (checks.some((c) => c.status === "timeout")) return "timeout";
  if (checks.some((c) => c.status === "fail")) return "fail";
  return "pass";
}

/** Classify one raw execution into a check status. */
export function classifyExecution(execution: CheckExecution): CheckStatus {
  if (!execution.launched) return "infrastructure_failure";
  if (execution.timedOut) return "timeout";
  return execution.exitCode === 0 ? "pass" : "fail";
}

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

/** How the workspace was left after verification. */
export type VerificationDisposition = "retained" | "discarded";

/** THE immutable account of one verification, bound to exactly one candidate tree. */
export interface VerificationRecord {
  readonly verificationId: V2VerificationId;
  readonly runId: V2RunId;
  readonly candidateId: V2CandidateId;
  readonly candidateTreeId: string;
  readonly planId: V2PlanDigest;
  /** The tree observed BEFORE checks — equals candidateTreeId unless there was drift. */
  readonly treeBeforeChecks: string;
  /** The tree observed AFTER checks — equals treeBeforeChecks unless the checks mutated it. */
  readonly treeAfterChecks: string;
  readonly checks: readonly CheckRecord[];
  readonly verdict: VerificationVerdict;
  readonly workspaceDisposition: VerificationDisposition;
  readonly startedAt: number;
  readonly endedAt: number;
}

/**
 * Content address of a verification.
 *
 * Binds the exact candidate, the exact tree it claims to be about, the plan, the ordered
 * per-check verdicts, and the aggregate. Deliberately EXCLUDES durations and output text
 * — those vary run to run — so the identity is a statement about WHAT WAS VERIFIED and HOW
 * IT TURNED OUT, not about the noise of one execution. A different candidate tree changes
 * `candidateTreeId` and therefore the id, even if the checks coincidentally printed the
 * same thing.
 */
export function verificationDigest(input: {
  readonly candidateId: V2CandidateId;
  readonly candidateTreeId: string;
  readonly planId: V2PlanDigest;
  readonly checks: readonly CheckRecord[];
  readonly verdict: VerificationVerdict;
  readonly treeAfterChecks: string;
}): V2VerificationId {
  return contentDigest("verification", {
    candidateId: input.candidateId,
    candidateTreeId: input.candidateTreeId,
    planId: input.planId,
    verdict: input.verdict,
    treeAfterChecks: input.treeAfterChecks,
    checks: input.checks.map((c) => ({ name: c.name, command: c.command, status: c.status, exitCode: c.exitCode ?? null })),
  });
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export const V2_VERIFICATION_FAILURE_CODES = {
  subjectMismatch: "verification.subject_mismatch",
  workspaceMissing: "verification.workspace_missing",
  candidateDrift: "verification.candidate_drift",
  workspaceMutatedByChecks: "verification.workspace_mutated_by_checks",
  planningFailed: "verification.planning_failed",
} as const;

/** Build a verification failure. Identities and reasons only — never raw check output. */
export function verificationFailure(code: string, message: string, detail?: Readonly<Record<string, string | number | boolean>>): RunFailure {
  return runFailure({
    category: "verification",
    code,
    message,
    stage: "verification",
    retryable: false,
    ...(detail !== undefined ? { detail } : {}),
  });
}

// ---------------------------------------------------------------------------
// The orchestration
// ---------------------------------------------------------------------------

export interface VerifyCandidateInput {
  readonly runId: V2RunId;
  readonly subject: VerificationSubject;
  readonly candidate: CandidateRecord;
  readonly workspacePath: string;
  readonly checksSource: ChecksSource;
  readonly runner: CheckRunner;
  readonly tree: TreeProbe;
  readonly checkTimeoutMs: number;
  readonly now?: () => number;
}

export type VerifyCandidateOutcome =
  | { readonly ok: true; readonly record: VerificationRecord }
  | { readonly ok: false; readonly failure: RunFailure };

const MAX_EXCERPT_CHARS = 1_500;

/** Bound a captured excerpt defensively; the adapter already tails, this is belt-and-suspenders. */
function boundExcerpt(text: string): string {
  return text.length <= MAX_EXCERPT_CHARS ? text : text.slice(text.length - MAX_EXCERPT_CHARS);
}

/**
 * Verify one candidate. Pure orchestration over the injected seams.
 *
 * The shape is deliberately linear: bind the subject, recompute the tree (drift guard),
 * plan, run, recompute the tree (mutation guard), classify. Every guard that trips
 * produces a truthful terminal verdict and stops — nothing is retried, nothing is
 * regenerated, no model is consulted.
 */
export async function verifyCandidate(input: VerifyCandidateInput): Promise<VerifyCandidateOutcome> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const { subject, candidate } = input;

  // 0. SUBJECT BINDING. A subject that does not describe this candidate is refused before
  //    any I/O — verifying someone else's work is not a smaller verification, it is a lie.
  const mismatch = validateSubject(subject, candidate, input.runId);
  if (mismatch !== undefined) return { ok: false, failure: mismatch };

  // 1. TREE BEFORE. If the workspace cannot even be read, verification did not happen.
  let treeBefore: string;
  try {
    treeBefore = await input.tree.treeOf(input.workspacePath);
  } catch (err) {
    return {
      ok: false,
      failure: verificationFailure(
        V2_VERIFICATION_FAILURE_CODES.workspaceMissing,
        `cannot read the candidate workspace ${subject.workspaceId}: ${err instanceof Error ? err.message : String(err)}`,
        { candidateId: subject.candidateId, workspaceId: subject.workspaceId },
      ),
    };
  }

  const finish = (input2: {
    readonly planId: V2PlanDigest;
    readonly checks: readonly CheckRecord[];
    readonly verdict: VerificationVerdict;
    readonly treeAfterChecks: string;
  }): VerifyCandidateOutcome => ({
    ok: true,
    record: Object.freeze({
      verificationId: verificationDigest({
        candidateId: subject.candidateId,
        candidateTreeId: subject.candidateTreeId,
        planId: input2.planId,
        checks: input2.checks,
        verdict: input2.verdict,
        treeAfterChecks: input2.treeAfterChecks,
      }),
      runId: input.runId,
      candidateId: subject.candidateId,
      candidateTreeId: subject.candidateTreeId,
      planId: input2.planId,
      treeBeforeChecks: treeBefore,
      treeAfterChecks: input2.treeAfterChecks,
      checks: input2.checks,
      verdict: input2.verdict,
      // Retained on every conclusive-or-not outcome: recovery and disposition are the next
      // authorities, and both want the exact tree that was judged. The run owns cleanup.
      workspaceDisposition: "retained",
      startedAt,
      endedAt: now(),
    }),
  });

  // The plan exists for every outcome so the record always cites one. For a drift or a
  // no-checks stop it is the plan that WOULD have run (empty when nothing was resolvable).
  const emptyPlan = buildVerificationPlan({ checks: [], timeoutMs: input.checkTimeoutMs, source: "default" });

  // 2. DRIFT GUARD. The workspace must still be the candidate. If not, NO check runs and
  //    we do not recapture — the candidate is a fixed thing, and "verify what is there"
  //    is exactly the habit this authority exists to break.
  if (treeBefore !== subject.candidateTreeId) {
    return finish({ planId: emptyPlan.planId, checks: [], verdict: "candidate_drift", treeAfterChecks: treeBefore });
  }

  // 3. PLAN. Deterministic discovery over the workspace, decided in full before execution.
  const resolved = await input.checksSource.resolve(input.workspacePath);
  if (!resolved.ok || resolved.checks.length === 0) {
    // NO_CHECKS is truthful, and it is NOT a pass. Nothing ran, so the tree is unchanged.
    return finish({ planId: emptyPlan.planId, checks: [], verdict: "no_checks", treeAfterChecks: treeBefore });
  }
  const plan = buildVerificationPlan({ checks: resolved.checks, timeoutMs: input.checkTimeoutMs, source: resolved.source });

  // 4. RUN ALL, in plan order. Every check runs within budget so the record shows the full
  //    defect set rather than stopping at the first red.
  const checks: CheckRecord[] = [];
  for (const planned of plan.checks) {
    const execution = await input.runner.run({
      name: planned.name,
      command: planned.command,
      args: planned.args,
      cwd: input.workspacePath,
      timeoutMs: planned.timeoutMs,
    });
    checks.push({
      name: planned.name,
      command: `${planned.command} ${planned.args.join(" ")}`.trim(),
      status: classifyExecution(execution),
      ...(execution.exitCode !== undefined ? { exitCode: execution.exitCode } : {}),
      durationMs: execution.durationMs,
      outputSha256: execution.outputSha256,
      outputExcerpt: boundExcerpt(execution.outputExcerpt),
    });
  }

  // 5. TREE AFTER. If the checks changed the tree, the result is not about this candidate,
  //    whatever the exit codes said. A green suite that rewrote its subject verified nothing.
  let treeAfter: string;
  try {
    treeAfter = await input.tree.treeOf(input.workspacePath);
  } catch (err) {
    return {
      ok: false,
      failure: verificationFailure(
        V2_VERIFICATION_FAILURE_CODES.workspaceMissing,
        `the candidate workspace became unreadable during verification: ${err instanceof Error ? err.message : String(err)}`,
        { candidateId: subject.candidateId, workspaceId: subject.workspaceId },
      ),
    };
  }

  if (treeAfter !== treeBefore) {
    return finish({ planId: plan.planId, checks, verdict: "workspace_mutated_by_checks", treeAfterChecks: treeAfter });
  }

  // 6. AGGREGATE. The tree is intact and equals the candidate; the verdict is the checks'.
  return finish({ planId: plan.planId, checks, verdict: aggregateCheckVerdict(checks), treeAfterChecks: treeAfter });
}

// ---------------------------------------------------------------------------
// Receipt view
// ---------------------------------------------------------------------------

/** A receipt-safe account of a verification. Ids, verdicts, hashes and counts — no logs. */
export interface RunVerificationSummary {
  readonly verificationId: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly candidateTreeId: string;
  readonly planId: string;
  readonly verdict: VerificationVerdict;
  readonly treeBeforeChecks: string;
  readonly treeAfterChecks: string;
  readonly treeUnchanged: boolean;
  readonly workspaceDisposition: VerificationDisposition;
  readonly checks: readonly {
    readonly name: string;
    readonly command: string;
    readonly status: CheckStatus;
    readonly exitCode: number | null;
    readonly durationMs: number;
    readonly outputSha256: string;
    readonly outputExcerpt: string;
  }[];
}

export function summarizeVerification(record: VerificationRecord): RunVerificationSummary {
  return {
    verificationId: record.verificationId,
    runId: record.runId,
    candidateId: record.candidateId,
    candidateTreeId: record.candidateTreeId,
    planId: record.planId,
    verdict: record.verdict,
    treeBeforeChecks: record.treeBeforeChecks,
    treeAfterChecks: record.treeAfterChecks,
    treeUnchanged: record.treeBeforeChecks === record.treeAfterChecks,
    workspaceDisposition: record.workspaceDisposition,
    checks: record.checks.map((c) => ({
      name: c.name,
      command: c.command,
      status: c.status,
      exitCode: c.exitCode ?? null,
      durationMs: c.durationMs,
      outputSha256: c.outputSha256,
      outputExcerpt: c.outputExcerpt,
    })),
  };
}

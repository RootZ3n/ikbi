/**
 * ikbi job-cards — contract (types only).
 *
 * Job Cards are reusable, named, bounded automations. Each card describes a
 * repeatable task (e.g. "find god files", "audit receipts") with guardrails
 * that limit blast radius. Cards produce receipts and respect the trust model.
 */

/** Access policy for a job card. */
export type AccessPolicy = "read-only" | "write-gated" | "write-auto";

/** When to verify a run's output. */
export type VerificationPolicy = "required" | "optional" | "skip";

/** Rollback behaviour on failure. */
export type RollbackPolicy = "on-failure" | "never" | "always";

/** Schedule cadence. */
export type SchedulePolicy = "once" | "loop";

/** Status of a job card run. */
export type JobCardRunStatus = "pending" | "running" | "passed" | "failed" | "rolled-back";

/** Guardrails that limit the blast radius of a job card run. */
export interface Guardrails {
  /** Maximum number of files a run may change (0 for read-only cards). */
  readonly maxFilesChanged: number;
  /** Repo-relative paths the card must never touch. */
  readonly protectedPaths: readonly string[];
  /** Whether the run requires a clean worktree before starting. */
  readonly requireCleanWorktree: boolean;
}

/** A reusable, named, bounded automation. */
export interface JobCard {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Goal template — may contain {{variables}} for dynamic substitution. */
  readonly goalTemplate: string;
  readonly accessPolicy: AccessPolicy;
  readonly guardrails: Guardrails;
  readonly verification: VerificationPolicy;
  readonly rollback: RollbackPolicy;
  readonly schedule: SchedulePolicy;
  /** Minimum trust tier required to run this card. */
  readonly minTrustTier: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A single execution of a job card. */
export interface JobCardRun {
  readonly id: string;
  readonly cardId: string;
  readonly status: JobCardRunStatus;
  readonly startedAt: string;
  readonly finishedAt?: string;
  /** Receipt ID produced by the worker-model, if any. */
  readonly receiptId?: string;
  readonly error?: string;
}

/** The full result of a job card run. */
export interface JobCardResult {
  readonly run: JobCardRun;
  readonly output: string;
  readonly filesChanged: readonly string[];
  readonly verificationPassed: boolean;
}

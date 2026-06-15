/**
 * ikbi worker-model substrate — its events (namespaced `worker.*` per module plan ## 8).
 *
 * Published on the existing event bus with `source: "worker-model"` and identity
 * attribution (parent on run-level events, the spawned role identity on role-level
 * events). Transient live signals; receipts are the durable record.
 */

import { defineEvent } from "../../core/events/index.js";
import type { WorkerOutcome, WorkerRole } from "./contract.js";

/** A run started — workspace allocated, about to dispatch roles. (Attribution: parent.)
 *  Carries the resolved verification + retrieval modes so the operator sees which path will run. */
export const workerStarted = defineEvent<{ taskId: string; workspaceId: string; verificationMode?: string; retrievalMode?: string }>("worker.started");

/** A role is about to run, under its spawned identity. (Attribution: role identity.) */
export const workerRoleDispatched = defineEvent<{ taskId: string; role: WorkerRole; tier?: string }>(
  "worker.role.dispatched",
);

/** A role finished. (Attribution: role identity.) */
export const workerRoleCompleted = defineEvent<{ taskId: string; role: WorkerRole; outcome: WorkerOutcome; costUsd?: number | undefined }>(
  "worker.role.completed",
);

/** A role was deliberately skipped (e.g. the critic on a discard-bound red-verifier build). (Attribution: parent.) */
export const workerRoleSkipped = defineEvent<{ taskId: string; role: WorkerRole; reason: string }>(
  "worker.role.skipped",
);

/** BUILDER tool activity at the role boundary — round count + files written + context pressure. (Attribution: role.) */
export const workerBuilderActivity = defineEvent<{ taskId: string; toolRounds: number; filesWritten: number; contextPercent?: number }>(
  "worker.builder.activity",
);

/** VERIFICATION status — the verifier's verdict + which checks passed. (Attribution: role.) */
export const workerVerification = defineEvent<{ taskId: string; verdict: string; typecheckPassed: boolean; testsPassed: boolean; checks?: ReadonlyArray<{ name: string; passed: boolean }>; verificationScope?: "impact" | "full" }>(
  "worker.verification",
);

/** A verified build is PAUSED awaiting operator approval before promote (SG-10). (Attribution: parent.) */
export const workerApprovalRequested = defineEvent<{ taskId: string; workspaceId: string }>("worker.approval.requested");

/** The operator's approval decision resolved (SG-10). (Attribution: parent.) */
export const workerApprovalResolved = defineEvent<{ taskId: string; workspaceId: string; approved: boolean }>("worker.approval.resolved");

/** A run completed (success / partial). (Attribution: parent.) */
export const workerCompleted = defineEvent<{
  taskId: string;
  outcome: WorkerOutcome;
  promoted: boolean;
  workspaceId: string;
  /** The verification scope a promote/judge relied on ("impact" | "full"), for auditability. */
  verificationScope?: "impact" | "full";
  /** Which verification path actually ran ("ladder" | "legacy"), for auditability. */
  verificationMode?: string;
  /** Which retrieval path actually ran ("index" | "legacy" | "index-fallback"), for auditability. */
  retrievalMode?: string;
}>("worker.completed");

/** A run failed (a role failed/rejected/stub, or an infrastructure error). (Attribution: parent.) */
export const workerFailed = defineEvent<{ taskId: string; reason: string; workspaceId?: string }>("worker.failed");

// ── competitive build mode (AMG) — counts + winner id only, no candidate detail ──

/** A competitive run started — N workspaces about to be allocated. (Attribution: parent.) */
export const workerCompetitiveStarted = defineEvent<{ taskId: string; candidateCount: number }>("worker.competitive.started");

/** The judge picked a winner (or null). (Attribution: parent.) */
export const workerCompetitiveJudged = defineEvent<{ taskId: string; candidateCount: number; winnerWorkspaceId: string | null }>(
  "worker.competitive.judged",
);

/** A competitive run finished — winner promoted/discarded resolved. (Attribution: parent.) */
export const workerCompetitiveCompleted = defineEvent<{ taskId: string; candidateCount: number; winnerWorkspaceId: string | null }>(
  "worker.competitive.completed",
);

// ── candidate tournament mode (#tournament) — counts + winner/shadow ids, no candidate detail ──

/** A tournament started — N candidate workspaces about to race independently. (Attribution: parent.) */
export const workerTournamentStarted = defineEvent<{ taskId: string; candidateCount: number }>("worker.tournament.started");

/** The deterministic judge picked a winner (or null = fail-closed). (Attribution: parent.) */
export const workerTournamentJudged = defineEvent<{ taskId: string; candidateCount: number; winnerWorkspaceId: string | null }>(
  "worker.tournament.judged",
);

/** A tournament finished — winner replayed into the shadow, verified, and promoted/discarded. (Attribution: parent.) */
export const workerTournamentCompleted = defineEvent<{ taskId: string; winnerWorkspaceId: string | null; shadowWorkspaceId?: string; promoted: boolean }>(
  "worker.tournament.completed",
);

/** The iterative fix loop completed — how many fix iterations ran and whether it succeeded. (Attribution: parent.) */
export const workerFixLoopCompleted = defineEvent<{ taskId: string; fixIterations: number; success: boolean; lastErrors?: string }>(
  "worker.fix_loop.completed",
);

export const workerCriticFixLoopCompleted = defineEvent<{ taskId: string; retried: boolean; criticPass: boolean; builderOk?: boolean; verifierPass?: boolean }>(
  "worker.critic_fix_loop.completed",
);

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

/** BUILDER tool activity at the role boundary — round count + files written + context pressure.
 *  Carries the TRUST TIER the builder actually executed under (the spawned role's clamped tier) so
 *  the operator sees the governance posture of the work in the builder's own output, not just
 *  internal state. (Attribution: role.) */
export const workerBuilderActivity = defineEvent<{ taskId: string; toolRounds: number; filesWritten: number; contextPercent?: number; tier?: string }>(
  "worker.builder.activity",
);

/**
 * STREAM-STALL RECOVERY (WO4): a model stream was cut off WHILE emitting a tool call —
 * the truncated action was NOT executed (fail-closed). The builder retries (bounded) or
 * terminates cleanly. CONTENT is redacted: only the partial-argument BYTE COUNT is carried,
 * never the partial argument values. Surfaced so an operator can correlate stalls with a
 * flaky model/provider. (Attribution: role identity.) */
export const workerToolCallStalled = defineEvent<{
  taskId: string;
  /** The stalled tool name(s) the partial call carried, if any. */
  tools: readonly string[];
  /** Total bytes of partial arguments received — the CONTENT is redacted, never the values. */
  partialArgBytes: number;
  /** Logical model + serving provider that stalled, for provider-stability triage. */
  model?: string;
  provider?: string;
  /** Correlation id (the run/task id). */
  requestId?: string;
  /** 1-based stall attempt within this build. */
  attempt: number;
  /** Max stalls tolerated before a clean failure. */
  maxAttempts: number;
  /** Whether the builder will retry the tool call (false ⇒ this stall is terminal). */
  willRetry: boolean;
}>("worker.tool_call_stalled");

/** VERIFICATION status — the verifier's verdict + which checks passed. (Attribution: role.) */
export const workerVerification = defineEvent<{ taskId: string; verdict: string; typecheckPassed: boolean; testsPassed: boolean; checks?: ReadonlyArray<{ name: string; passed: boolean }>; verificationScope?: "impact" | "full" }>(
  "worker.verification",
);

/**
 * TRUST-TIER UX (WO5): a verified build LANDED (was promoted) — the project's work is now
 * bootstrapped under a known trust tier. Emitted at the verified-bootstrap moment so the operator
 * sees, plainly, WHICH trust tier authorized the work to land and what autonomy that tier grants
 * (sandboxing, gate friction, approval requirement, auto-commit). This is a pure VISIBILITY signal —
 * it does not grant, weaken, or alter trust; the tier + grant are read straight from the governance
 * decision that already authorized the promote. (Attribution: parent.) */
export const workerTrustEstablished = defineEvent<{
  taskId: string;
  workspaceId: string;
  /** The trust tier that authorized the promote (the run's governance tier). */
  tier: string;
  /** Was the work run in a disposable shadow-workspace? (probation/untrusted) */
  sandboxed: boolean;
  /** How much gate friction the tier applies ("all" | "standard" | "reduced"). */
  gateLevel: string;
  /** Does the tier require an operator-approval pause before irreversible actions? */
  requiresApproval: boolean;
  /** May the tier auto-commit? (trusted/operator only) */
  autoCommit: boolean;
}>("worker.trust.established");

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

/**
 * A builder failed on the cheap (worker) tier and the escalation engine recommended a mid-tier
 * retry, so the orchestrator re-ran the builder ONCE on the escalated model in the SAME workspace.
 * `success` reports whether that retry converged — a `false` here means the original failure stood
 * (fail-closed). Emitted only when the model swap + retry actually ran (not for an observe-only eval).
 */
export const workerEscalationRetried = defineEvent<{ taskId: string; fromModel?: string; toModel: string; success: boolean }>(
  "worker.escalation.retried",
);

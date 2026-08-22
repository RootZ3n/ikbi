/**
 * ADAPTER — the v2 engine's entry in the OPERATOR receipt log.
 *
 * WHY THIS EXISTS. v2 publishes by a direct clean-ref CAS and deliberately does NOT go through
 * `WorkspaceManager.promote`, which auto-merges and requires an approval this authority does not
 * use. That was the right call for the ref, and it silently took the operator's tools with it: the
 * receipt log is the only durable record `ikbi undo` and `ikbi inspect` read, and after the cutover
 * a canonical `ikbi build` wrote nothing to it but its verifier's governed-exec lines. A build that
 * published a commit could not be found by `ikbi inspect <run-id>`, and `ikbi undo --latest`
 * answered "no revertible promotion found in the receipt log" — while the commit sat on `main`.
 *
 * A build that cannot be undone is not a daily driver, so the engine records what it did.
 *
 * THE SESSION RESULT IS THE SOURCE. This runs AFTER the run is complete, from the returned record,
 * rather than inside the publication adapter — where the journal seam is synchronous and a
 * fire-and-forget append would race the process exit that follows it. Nothing here can influence
 * what was published; it only writes down what already happened.
 *
 * BEST EFFORT, AND HONEST ABOUT IT. The git ref is the authoritative landing proof. A receipt that
 * could not be written must never turn a landed publication into a failure, so a failure here is
 * REPORTED to the caller and never thrown — the same posture the publication journal already takes.
 */

import type { ReceiptInput } from "../../core/receipt/contract.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import type { V2BuildSessionResult } from "../core/session.js";

/** The narrow slice of the receipt store this adapter needs. */
export interface RunReceiptSink {
  append(input: ReceiptInput, identity: AgentIdentity): Promise<unknown>;
}

/** What was written, so a caller can report durability rather than assume it. */
export interface RunReceiptOutcome {
  readonly runSummary: "written" | "failed";
  /** `not_applicable` when the session published nothing — the ordinary withheld case. */
  readonly promotion: "written" | "failed" | "not_applicable";
}

/**
 * The identity these receipts are attributed to.
 *
 * The v2 engine, not the model and not the operator: this records what the ENGINE did, and
 * attributing a publication to whichever model happened to write the candidate would misplace
 * responsibility for a governed decision the model never made.
 */
export const V2_RECEIPT_IDENTITY: AgentIdentity = Object.freeze({
  agentId: "ikbi-v2",
  functionalRole: "builder",
  trustTier: "trusted",
}) as AgentIdentity;

/**
 * Append the operator-facing record of one build session.
 *
 * Writes a `run.summary` — the wrapper `ikbi inspect` resolves a run id through — and, when a
 * publication actually landed, a `workspace.promote` carrying the before/after refs that make the
 * change REVERSIBLE. The two are separate receipts because they answer separate questions, and
 * because a run that published nothing must not leave anything that looks undoable.
 */
export async function recordBuildSessionReceipts(
  session: V2BuildSessionResult,
  /**
   * The repository the OPERATOR pointed at.
   *
   * Taken from the request rather than the promotion summary, which carries only
   * `targetRepositoryIdentity` — the realpath'd git common dir. That is the right thing to BIND a
   * promotion id to and the wrong thing to hand `ikbi undo`, which has to scope `--latest` to the
   * operator's working directory and run git there.
   */
  repositoryPath: string,
  sink: RunReceiptSink = productionReceiptSink(),
  identity: AgentIdentity = V2_RECEIPT_IDENTITY,
): Promise<RunReceiptOutcome> {
  const attempt = session.attempts[session.attempts.length - 1];
  if (attempt === undefined) return { runSummary: "failed", promotion: "not_applicable" };

  const receipt = attempt.receipt;
  const promotion = receipt.promotion;
  // A landed publication is the ONLY thing that may be described as revertible. A withheld,
  // conflicted or degraded-without-landing run moved no ref, and offering an undo for it would
  // point the operator at a revert of something that never happened.
  const landed =
    promotion !== undefined &&
    typeof promotion.beforeRef === "string" &&
    typeof promotion.afterRef === "string" &&
    promotion.beforeRef.length > 0 &&
    promotion.afterRef.length > 0 &&
    promotion.beforeRef !== promotion.afterRef;

  const runSummary = await write(sink, identity, {
    operation: "run.summary",
    requestId: attempt.runId,
    project: repositoryPath,
    outcome: {
      status: session.outcome.kind === "accepted" ? "success" : "failure",
      detail: `v2 build session ${session.buildSessionId}: ${session.outcome.kind}`,
    },
    // No `changes` here. The run summary DESCRIBES the run; the promote receipt below is what
    // carries the reversible state change, and duplicating it would give `undo` two anchors for
    // one ref move.
    changes: [],
    metadata: {
      engine: "v2",
      runId: attempt.runId,
      taskId: attempt.taskId,
      buildSessionId: session.buildSessionId,
      status: session.outcome.kind,
      phase: attempt.journal?.at(-1)?.to ?? "unknown",
      attempts: session.receipt.totalAttempts,
      ...(receipt.candidate?.candidateId !== undefined ? { candidateId: receipt.candidate.candidateId } : {}),
      ...(receipt.candidate?.workspaceId !== undefined ? { workspaceId: receipt.candidate.workspaceId } : {}),
      ...(receipt.verification?.verdict !== undefined
        ? { verification: receipt.verification.verdict, verificationResult: receipt.verification.verdict }
        : {}),
      promotion: landed ? "promoted" : "not_attempted",
      promoted: landed,
      repository: repositoryPath,
      // Recovery is what an operator reads to understand a multi-attempt session.
      recovery: session.recoveryDecisions.map((d) => d.kind),
    },
  });

  if (!landed) return { runSummary, promotion: "not_applicable" };

  const repo = repositoryPath;
  const branch = promotion.targetBranch;
  const promoteStatus = await write(sink, identity, {
    operation: "workspace.promote",
    requestId: attempt.runId,
    project: repo,
    outcome: { status: "success", detail: `published ${promotion.publishedTree} to ${branch}` },
    changes: [
      {
        kind: "state",
        // `<repo>#<branch>` is the shape `ikbi undo` parses to scope `--latest` to the operator's
        // own repository. A different spelling here would make the change unreadable to the one
        // command that exists to reverse it.
        target: `${repo}#${branch}`,
        before: { ref: promotion.beforeRef },
        after: { ref: promotion.afterRef },
        inverse: { operation: "git.update-ref", args: { ref: `refs/heads/${branch}`, to: promotion.beforeRef } },
      },
    ],
    metadata: {
      engine: "v2",
      runId: attempt.runId,
      taskId: attempt.taskId,
      promoted: true,
      promotionId: promotion.promotionId,
      candidateId: promotion.candidateId,
      publishedTree: promotion.publishedTree,
      targetBranch: branch,
      strategy: promotion.strategy,
      worktreeSynced: promotion.worktreeSynced,
      // The operator MUST be told their late local work was stashed — it is not auto-popped.
      stashed: promotion.stashed,
      degraded: promotion.degraded,
      idempotent: promotion.idempotent,
      postCasVerified: promotion.postCasVerified,
    },
  });

  return { runSummary, promotion: promoteStatus };
}

/**
 * The live receipt store, resolved LAZILY.
 *
 * Lazy and adapter-owned for the same reason `productionTransport` resolves the provider registry
 * that way: constructing the store reads the operator configuration, and doing that at module load
 * would make every ikbi command pay for — and be able to fail on — a store the command may never
 * write to. Owning it HERE rather than in `src/v2/cli` is what keeps the adapter layer the only
 * part of v2 that touches v1 donor code.
 */
export function productionReceiptSink(): RunReceiptSink {
  return {
    async append(input, identity) {
      const { receipts } = await import("../../core/receipt/index.js");
      return receipts.append(input, identity);
    },
  };
}

/** Append one receipt, converting any failure into a reported status. Never throws. */
async function write(sink: RunReceiptSink, identity: AgentIdentity, input: ReceiptInput): Promise<"written" | "failed"> {
  try {
    await sink.append(input, identity);
    return "written";
  } catch {
    return "failed";
  }
}

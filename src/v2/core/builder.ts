/**
 * ikbi v2 — THE BUILDER CONTROLLER.
 *
 * This is the first thing in v2 that actually writes code. It runs one bounded
 * conversation with one authorized model, dispatches the tool calls that model makes, and
 * stops when the model explicitly finishes.
 *
 * THE BUILDER IS NOT AN AUTHORITY OVER INFRASTRUCTURE. Read the dependency list below as
 * the enforcement of that sentence: this module is handed a decision it did not make, a
 * workspace it did not allocate, a transport it cannot reach around, and an executor that
 * holds the only capability to change a file. It has no import of a filesystem API, a
 * provider, a resolver or a materializer, and static guards fail the build if one appears.
 *
 * WHAT IT OWNS
 *   the conversation             which messages exist, in what order
 *   the budget                   turns, tool calls, mutations — all bounded, all explicit
 *   dispatch                     which tool call goes to the executor, in call order
 *   the finish interpretation    what counts as done, and what does not
 *   accounting                   which invocations and mutations this candidate is made of
 *
 * WHAT IT DOES NOT OWN
 *   model selection, provider transport, workspace creation, file writes, verification,
 *   recovery, escalation, promotion. Every one of those belongs to something else, and
 *   several of them do not exist yet — which is the point of stopping here.
 *
 * WHY BUDGET EXHAUSTION IS A FAILURE AND NOT A RESCUE. v1's builder, at the end of a
 * loop that ran out of iterations, consults the last check result and — if it was green —
 * synthesizes the completion the model never emitted (`worker-model/builder.ts`, the
 * AUTO-ACCEPT block). That is a recovery policy making a completion decision inside the
 * builder. v2 has no verifier yet and no recovery authority yet, so a builder that ran out
 * of budget produces a structured failure and no candidate. Anything else would be v2
 * inventing an authority to avoid admitting a limit.
 *
 * NO SILENT RETRY, ANYWHERE. A stale write is reported to the MODEL and the loop
 * continues; the controller never re-reads and re-applies on the model's behalf. The
 * difference matters: a model deciding to look again after being refused is reasoning,
 * and infrastructure quietly doing it is a lost compare-and-swap.
 */

import {
  MAX_COMPLETION_SUMMARY_CHARS,
  V2_BUILD_FAILURE_CODES,
  buildFailure,
  type BuilderCompletionClaim,
} from "./candidate.js";
import { BUILDER_TOOLS, isToolFailure, parseToolCall, renderToolProvenance, untrustedToolPayload, type BuilderToolCall, type ParsedToolCall, type ToolOutcome } from "./tools.js";
import { renderBuilderInput, type RenderedMessage } from "./prompt.js";
import type { RepairBrief } from "./repair.js";
import { invokeAuthorized, type InvocationTransport, type ServedModelAlias, type V2InvocationRecord } from "./invocation.js";
import type { InvocationAdmission } from "./cost.js";
import type { ContextPackage } from "./context.js";
import type { ModelResolutionDecision } from "./resolver.js";
import type { RunFailure } from "./failure.js";
import type { V2InvocationId, V2MutationDigest, V2ObservationDigest, V2RunId, V2TaskId } from "./identity.js";
import type { StateBoundMutationAuthority, V2FileObservation, V2WorkspaceRecord } from "./workspace.js";

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/**
 * The bounds on one candidate generation. Every one is a HARD stop that produces a
 * structured failure — none resets, escalates, or grants itself more.
 */
export interface BuilderBudget {
  /** Model turns. One turn is one invocation. */
  readonly maxTurns: number;
  /** Tool calls dispatched across the whole run, successful or not. */
  readonly maxToolCalls: number;
  /** Applied mutations. A refused write does not count against this. */
  readonly maxMutations: number;
  /** Completion tokens per turn. */
  readonly maxOutputTokens: number;
  /** Per-turn wall clock. */
  readonly turnTimeoutMs: number;
}

/**
 * Deliberately small. This slice proves the machinery, and a tight bound makes an
 * unbounded loop a test failure rather than a bill. v1's default is 40 iterations with an
 * env override; v2 will grow this when there is a recovery authority to grow it against.
 */
export const DEFAULT_BUILDER_BUDGET: BuilderBudget = Object.freeze({
  maxTurns: 12,
  maxToolCalls: 40,
  maxMutations: 20,
  maxOutputTokens: 4_096,
  turnTimeoutMs: 120_000,
});

// ---------------------------------------------------------------------------
// The tool executor seam
// ---------------------------------------------------------------------------

/**
 * What actually performs a tool call.
 *
 * The controller holds this and nothing else: it cannot observe, mutate, or read a file
 * except by asking. The implementation (`runtime/builder-tools.ts`) holds the workspace
 * record and the state-bound authority; the controller never sees either.
 */
export interface BuilderToolExecutor {
  execute(call: ParsedToolCall & { ok: true }): Promise<ToolExecution>;
}

/**
 * What the executor is built with.
 *
 * Declared HERE, in the pure layer, so the shape of the capability is part of the
 * architecture rather than an implementation detail of one adapter — and so the run spine
 * can wire it without either side importing a filesystem API.
 */
export interface BuilderToolExecutorDeps {
  readonly runId: V2RunId;
  readonly workspace: V2WorkspaceRecord;
  readonly mutations: StateBoundMutationAuthority;
  /** Called for every observation taken, so the run can put it on the ledger. */
  readonly onObservation: (observation: V2FileObservation) => void;
  /** Called for every mutation applied, so the run can put it on the ledger. */
  readonly onMutation: (input: {
    readonly mutationId: V2MutationDigest;
    readonly path: string;
    readonly observationId: V2ObservationDigest;
  }) => void;
}

/** What one executed tool did, plus the ledger facts the candidate will need. */
export interface ToolExecution {
  readonly outcome: ToolOutcome;
  /** Present when the call APPLIED a mutation. Absent for reads and refusals. */
  readonly mutation?: { readonly mutationId: V2MutationDigest; readonly path: string };
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** What the loop produced: the material a candidate is assembled from. */
export interface BuilderGeneration {
  readonly claim: BuilderCompletionClaim;
  readonly invocations: readonly V2InvocationRecord[];
  readonly invocationIds: readonly V2InvocationId[];
  readonly mutationIds: readonly V2MutationDigest[];
  readonly changedPaths: readonly string[];
  readonly turns: number;
  readonly toolCalls: number;
  readonly toolFailures: number;
  readonly startedAt: number;
  readonly endedAt: number;
}

export type BuilderResult =
  | { readonly ok: true; readonly generation: BuilderGeneration }
  | {
      readonly ok: false;
      readonly failure: RunFailure;
      /** Invocations that really happened before the failure. Counted, never discarded. */
      readonly invocations: readonly V2InvocationRecord[];
      /**
       * A turn that REACHED THE WIRE but produced no record — the provider was contacted
       * and then failed. There is no `V2InvocationRecord` for it (nothing came back to
       * build one from), but a receipt that omitted it would claim a provider was never
       * contacted when it was, and would understate what the run cost.
       */
      readonly attemptedInvocationIds: readonly V2InvocationId[];
      /** Mutations that really applied before the failure. The workspace holds them. */
      readonly mutationIds: readonly V2MutationDigest[];
    };

/**
 * THE UNTRUSTED-DATA BOUNDARY.
 *
 * Repository and tool-derived content — file bytes, mutation-failure detail, rejection
 * text, and any future search/list/terminal output — is DATA, not instruction authority.
 * It re-enters the builder conversation through this one seam, which wraps it as
 * structurally-isolated untrusted data so the exact tokens a model keys on (role tags,
 * fake tool syntax, "ignore previous instructions") cannot act as commands.
 *
 * It is INJECTED because `core/builder.ts` is pure: the real implementation
 * (`runtime/untrusted-boundary.ts`) is v1's verified-absent-nonce neutralization fence,
 * which is I/O-adjacent (it logs and reads config). The controller holds a function, never
 * the machinery — the same discipline as the transport and the tool executor.
 *
 * CONTRACT: `wrap` is LOSSLESS for `source: "repo"` (source code survives byte-for-byte and
 * stays recoverable) and returns a string that a model cannot use to close its own
 * wrapper. It never rewrites the bytes a hash was computed over — the hash is in the
 * trusted provenance, outside the wrapped region.
 */
export interface UntrustedBoundary {
  wrap(input: { readonly content: string; readonly source: "repo" | "tool_result"; readonly origin?: string }): string;
}

export interface BuilderRunInput {
  readonly runId: V2RunId;
  readonly taskId: V2TaskId;
  readonly decision: ModelResolutionDecision;
  readonly contextPackage: ContextPackage;
  readonly transport: InvocationTransport;
  readonly executor: BuilderToolExecutor;
  /**
   * THE one boundary every tool result crosses on its way back to the model. Required:
   * there is no un-neutralized path, and a default here would have to live in this pure
   * layer where the real fence cannot.
   */
  readonly untrustedBoundary: UntrustedBoundary;
  /**
   * OPTIONAL advisory repair evidence from a prior FAILED attempt (V2-013). When present it is
   * rendered as ONE untrusted, fenced historical block after the context — never as authority,
   * carrying no workspace/observation/candidate pointer. Absent on an initial attempt.
   */
  readonly repairBrief?: RepairBrief;
  /** Mints one fresh invocation id per turn. */
  readonly mintInvocationId: () => V2InvocationId;
  readonly budget?: BuilderBudget;
  readonly aliases?: readonly ServedModelAlias[];
  /**
   * OPTIONAL session cost-budget guard. When present, it is consulted BEFORE each model call
   * (admission) and charged AFTER each successful one (accounting). Absent means no budget
   * enforcement — every existing call path is unaffected.
   */
  readonly admission?: InvocationAdmission;
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/**
 * Generate one candidate's worth of work.
 *
 * The shape is deliberately flat and readable: send a turn, record it, dispatch whatever
 * the model asked for, append exactly what happened, repeat. Every early exit is a named
 * failure; there is no branch that ends the loop quietly.
 */
export async function generateCandidate(input: BuilderRunInput): Promise<BuilderResult> {
  const now = input.now ?? Date.now;
  const budget = input.budget ?? DEFAULT_BUILDER_BUDGET;
  const startedAt = now();

  const conversation: RenderedMessage[] = [];
  const invocations: V2InvocationRecord[] = [];
  const mutationIds: V2MutationDigest[] = [];
  const changedPaths = new Set<string>();
  let toolCalls = 0;
  let toolFailures = 0;
  let turns = 0;

  const attemptedInvocationIds: V2InvocationId[] = [];
  /** Everything that really happened, for a failure that must not erase it. */
  const partial = (failure: RunFailure): BuilderResult => ({ ok: false, failure, invocations, mutationIds, attemptedInvocationIds });

  while (turns < budget.maxTurns) {
    // ONE TURN = ONE INVOCATION, through the one authority. There is no other doorway
    // to a model in v2, and the controller does not hold a transport it could use
    // directly — it hands the authority the one it was given.
    const rendered = renderBuilderInput(input.contextPackage, conversation, input.repairBrief !== undefined ? { repairBrief: input.repairBrief, boundary: input.untrustedBoundary } : undefined);
    const turnMaxOutputTokens = Math.min(budget.maxOutputTokens, input.contextPackage.budget.reservedCompletionTokens);
    // PRE-CALL COST ADMISSION. BEFORE the money is spent, ask the session budget authority
    // whether another model call is authorized. It never selects or downgrades a model — it
    // only answers proceed / stop. A denial ends the builder with a structured, non-retryable
    // policy failure; recovery treats cost exhaustion as operator-required, never a retry.
    if (input.admission !== undefined) {
      const admitted = input.admission.admitNext({
        identity: { authorizedModelId: input.decision.modelId, sentProviderId: input.decision.providerId, sentProviderModelId: input.decision.providerModelId },
        estimatedInputTokens: input.contextPackage.budget.availableInputTokens,
        maxOutputTokens: turnMaxOutputTokens,
      });
      if (!admitted.admit) return partial(admitted.failure);
    }
    const invocationId = input.mintInvocationId();
    const called = await invokeAuthorized({
      runId: input.runId,
      taskId: input.taskId,
      invocationId,
      decision: input.decision,
      contextPackage: input.contextPackage,
      rendered,
      tools: BUILDER_TOOLS,
      parameters: {
        maxOutputTokens: turnMaxOutputTokens,
        timeoutMs: budget.turnTimeoutMs,
      },
      transport: input.transport,
      ...(input.aliases !== undefined ? { aliases: input.aliases } : {}),
      now,
    });
    turns += 1;

    if (!called.ok) {
      // NO FALLBACK, NO SECOND ROUTE, NO RETRY. Recovery is a later authority; a builder
      // that quietly re-dialled would be that authority, unreviewed.
      // The transport reached the wire. That IS an invocation and the caller must be
      // able to record it, even though no record object exists for a failed call.
      if (called.attempted) attemptedInvocationIds.push(invocationId);
      return partial(called.failure);
    }
    invocations.push(called.record);
    // POST-CALL ACCOUNTING. Charge the observed usage to the session wallet as it happens, so
    // the NEXT turn's admission sees the true remaining budget. Dedup is by InvocationId; the
    // session's later reconcile charges the same record idempotently.
    if (input.admission !== undefined) input.admission.charge(called.record);

    // The model's own turn goes back on the wire verbatim, including the calls it made.
    // A conversation that dropped them would leave the provider unable to match results
    // to calls, and would let a later turn silently lose what the model decided.
    conversation.push({
      role: "assistant",
      content: called.content,
      ...(called.toolCalls.length > 0 ? { toolCalls: called.toolCalls } : {}),
    });

    if (called.toolCalls.length === 0) {
      // A COMPLETION IS NOT A FINISH. The model stopped talking without calling
      // `finish_candidate`; v1 nudges here and loops. v2 nudges too — once the budget is
      // spent, it fails rather than accepting prose as a finish.
      conversation.push({
        role: "user",
        content:
          "You stopped without calling finish_candidate. If the work is complete, call finish_candidate now. " +
          "If it is not, continue using the tools. Prose is not a way to finish.",
      });
      continue;
    }

    // DISPATCH, strictly in the order the model emitted. No parallelism: these tools all
    // touch one workspace, and concurrent writes to a shared tree would make the order of
    // the mutation ledger a race.
    let finished: BuilderCompletionClaim | undefined;
    for (const call of called.toolCalls) {
      if (toolCalls >= budget.maxToolCalls) {
        return partial(
          buildFailure({
            code: V2_BUILD_FAILURE_CODES.toolLimitExceeded,
            message: `the builder made ${toolCalls} tool calls, which is the limit for one candidate`,
            detail: { maxToolCalls: budget.maxToolCalls, turns },
          }),
        );
      }
      toolCalls += 1;

      const parsed = parseToolCall(call);
      if (!parsed.ok) {
        // A MALFORMED CALL IS A TOOL FAILURE, NOT A CRASH. The model is told precisely
        // what was wrong and may correct itself; the loop stays bounded either way.
        toolFailures += 1;
        appendToolResult(conversation, input.untrustedBoundary, call, { kind: "rejected", reason: parsed.reason, detail: parsed.detail });
        continue;
      }

      if (parsed.name === "finish_candidate") {
        finished = {
          summary: parsed.summary.slice(0, MAX_COMPLETION_SUMMARY_CHARS),
          believesComplete: parsed.believesComplete,
        };
        appendToolResult(conversation, input.untrustedBoundary, call, { kind: "finished", summary: finished.summary, believesComplete: finished.believesComplete });
        // Stop dispatching this round: anything the model queued after declaring itself
        // done is work it has already said it does not need.
        break;
      }

      const executed = await input.executor.execute(parsed);
      if (isToolFailure(executed.outcome)) toolFailures += 1;
      if (executed.mutation !== undefined) {
        mutationIds.push(executed.mutation.mutationId);
        changedPaths.add(executed.mutation.path);
        if (mutationIds.length > budget.maxMutations) {
          return partial(
            buildFailure({
              code: V2_BUILD_FAILURE_CODES.mutationLimitExceeded,
              message: `the builder applied ${mutationIds.length} mutations, which is beyond the limit for one candidate`,
              detail: { maxMutations: budget.maxMutations, turns },
            }),
          );
        }
      }
      appendToolResult(conversation, input.untrustedBoundary, call, executed.outcome);
    }

    if (finished !== undefined) {
      return {
        ok: true,
        generation: {
          claim: finished,
          invocations,
          invocationIds: invocations.map((r) => r.invocationId),
          mutationIds,
          changedPaths: [...changedPaths].sort(),
          turns,
          toolCalls,
          toolFailures,
          startedAt,
          endedAt: now(),
        },
      };
    }
  }

  return partial(
    buildFailure({
      code: V2_BUILD_FAILURE_CODES.turnLimitExceeded,
      message: `the builder took ${turns} turns without calling finish_candidate`,
      detail: { maxTurns: budget.maxTurns, toolCalls, mutationsApplied: mutationIds.length },
    }),
  );
}

/**
 * THE ONE CHOKEPOINT. Append exactly what a tool did, bound to the call it answers.
 *
 * The only path from a tool result into the conversation. It composes each message from
 * two parts kept deliberately apart:
 *
 *   TRUSTED PROVENANCE  — ikbi-authored structured facts (tool, path, ids, hashes). The
 *                         model relies on these; the observationId it quotes back lives
 *                         here, outside the fence.
 *   UNTRUSTED PAYLOAD   — repository/tool-derived free text (file bytes, failure detail),
 *                         wrapped by the injected boundary as isolated untrusted data.
 *
 * A message that carries a wrapped payload is marked `untrusted`, so it can never be read
 * as a system/assistant instruction even structurally. A pure acknowledgement (an applied
 * write, a missing-file read, a finish) has no payload and is plain provenance.
 *
 * The observed content hash is unchanged by any of this: it was computed by the mutation
 * authority over the real bytes and sits in the provenance, not over the wrapper.
 */
function appendToolResult(
  conversation: RenderedMessage[],
  boundary: UntrustedBoundary,
  call: BuilderToolCall,
  outcome: ToolOutcome,
): void {
  const provenance = renderToolProvenance(outcome);
  const payload = untrustedToolPayload(outcome);
  if (payload === undefined) {
    conversation.push({ role: "tool", toolCallId: call.id, content: provenance });
    return;
  }
  const wrapped = boundary.wrap({
    content: payload.content,
    source: payload.source,
    ...(payload.origin !== undefined ? { origin: payload.origin } : {}),
  });
  conversation.push({ role: "tool", toolCallId: call.id, content: `${provenance}
${wrapped}`, untrusted: true });
}

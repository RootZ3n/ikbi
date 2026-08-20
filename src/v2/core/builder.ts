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
import {
  conversationCeiling,
  estimateMessagesTokens,
  factOf,
  fitConversation,
  type CompactedFact,
  type CompactionEvent,
  type ConversationCeiling,
} from "./conversation.js";
import type { RepairBrief } from "./repair.js";
import { invokeAuthorized, type InvocationTransport, type ServedModelAlias, type V2InvocationRecord } from "./invocation.js";
import type { InvocationAdmission } from "./cost.js";
import {
  commandRepeatKey,
  repeatedCommandNote,
  V2_COMMAND_FAILURE_CODES,
  type BuilderCommandCapability,
  type BuilderCommandRecord,
  type PriorCommandRun,
} from "./command.js";
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
  /** Read-only commands the builder may run across the whole candidate (V2-015). */
  readonly maxCommands: number;
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
  maxCommands: 24,
});

/* ── What the builder is allowed to know about its own limits ────────────── */

/**
 * THE EXECUTION BUDGET, as a snapshot the model may see.
 *
 * Every number comes from the counters that already ENFORCE the limits — there is no
 * second tally to drift out of step with the first. It is a view, not a source.
 */
export interface BuilderBudgetStatus {
  /** The turn about to be taken, 1-based. Before the first call this is 1, not 0. */
  readonly turnUsed: number;
  readonly turnLimit: number;
  readonly toolCallsUsed: number;
  readonly toolCallsLimit: number;
  readonly mutationsUsed: number;
  readonly mutationsLimit: number;
  readonly commandsUsed: number;
  readonly commandsLimit: number;
}

/**
 * Render the budget the model sees.
 *
 * THE MODEL MAY KNOW WHAT AUTHORITY REMAINS. THE HARNESS DOES NOT TELL IT HOW TO SPEND
 * THAT AUTHORITY. So this is four counters and nothing else: no "finish soon", no "stop
 * exploring", no adjective, no warning threshold that starts nagging near the end. A
 * builder working against a deadline it cannot see is being asked to plan blind; a
 * builder being told what to do with the deadline is not planning at all.
 *
 * One line, deliberately — it is re-sent every turn, and a paragraph of framing repeated
 * thirty-two times is real context spent on saying the same thing again.
 *
 * `mutations` counts APPLIED writes only; a refused write consumed none, exactly as the
 * enforcing counter has it. `commands` counts every command the policy layer accepted as
 * a request, INCLUDING one it then refused — because that is what the command budget
 * itself charges, and a status that flattered the number would be a different lie.
 */
export function renderBudgetStatus(status: BuilderBudgetStatus): string {
  return (
    `[ikbi execution budget] ` +
    `turn ${status.turnUsed}/${status.turnLimit} · ` +
    `tool_calls ${status.toolCallsUsed}/${status.toolCallsLimit} · ` +
    `mutations ${status.mutationsUsed}/${status.mutationsLimit} · ` +
    `commands ${status.commandsUsed}/${status.commandsLimit}`
  );
}

/* ── The operator's turn budget ──────────────────────────────────────────── */

/**
 * The bounds an operator may raise, and the names they raise them with.
 *
 * WHY THESE AND NOT THE OTHERS. Each was added only after a real production run proved
 * it was the binding constraint on genuine work, never on a hunch.
 *
 *   TURNS — a task ended at `build.turn_limit_exceeded` with mutations already applied
 *   and progress in the log. Twelve was the scaffold-era bound this file admits it is,
 *   and v1 had an override v2 shipped without.
 *
 *   TOOL CALLS — three materially different models were then measured on the same task.
 *   MiMo burned forty calls in an exploration loop and wrote nothing; MiniMax used its
 *   forty across seven substantial write turns with zero redundant commands, and GLM-5.2
 *   was on the same trajectory with six. Two independent vendors doing real work hit the
 *   same wall, which is what distinguishes a limit that is too low from a model that is
 *   wasteful.
 *
 *   COMMANDS — with tool calls raised to 150, the same three runs showed the command
 *   budget would bind at roughly call 51: each had already spent 19 of its 24 commands
 *   inside forty calls, and MiniMax — the productive one — was at ordinal 21 of 24 when
 *   its tool calls ran out. Raising tool calls alone would have bought it three commands.
 *
 * WHAT THEY DELIBERATELY ARE NOT. None touches another, nor `maxMutations`,
 * `maxOutputTokens`, the session invocation cap or the session cost ceiling. Whichever
 * bound is reached first is the one the failure names. Raising a bound buys that resource
 * and nothing else — never authority, never money.
 */
export const BUILDER_TURNS_ENV = "IKBI_V2_MAX_BUILDER_TURNS";
export const BUILDER_TOOL_CALLS_ENV = "IKBI_V2_MAX_TOOL_CALLS";
export const BUILDER_COMMANDS_ENV = "IKBI_V2_MAX_COMMANDS";

/**
 * The hard ceiling on tool calls. A SAFETY BOUNDARY, not a recommended operating point.
 *
 * A tool call is cheap on its own — a read, a listing, a write — but it is never alone:
 * each one returns a result that re-enters the conversation and is re-sent on every
 * later turn, so a large allowance raises latency and spend indirectly even though it
 * grants no extra turns and no extra money. Five hundred is roughly three times the ~150
 * an operator already runs successfully in a comparable harness, which leaves real room
 * above known-good practice while still refusing a typo that would authorize thousands.
 */
export const MAX_BUILDER_TOOL_CALLS_CEILING = 500;

/**
 * The hard ceiling on read-only commands. A SAFETY BOUNDARY, not a recommendation.
 *
 * Commands are the most expensive tool per unit of authority: each one launches a real
 * process in the sandbox, and its bounded output re-enters the conversation to be re-sent
 * on every later turn. Measured production behaviour puts them at roughly 0.47 per tool
 * call — three independent models each ran 19 commands inside their first 40 calls — so a
 * 150-call budget implies something near 70. Two hundred and fifty leaves real headroom
 * above that observed ratio while still refusing an accidental order of magnitude.
 */
export const MAX_BUILDER_COMMANDS_CEILING = 250;

/** Where an effective bound came from. Recorded so a receipt can say. */
export type BuilderBoundSource = "default" | "operator_env";

/** Resolving one operator bound either yields a value, or refuses and says why. */
export type BuilderBoundResolution =
  | { readonly ok: true; readonly value: number; readonly source: BuilderBoundSource }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve ONE operator-settable bound from ONE raw environment string.
 *
 * Pure, so the whole contract is testable without a process. Absent or blank is the
 * shipped default; anything else must be a clean positive integer inside the ceiling.
 *
 * IT REFUSES RATHER THAN IGNORING. The sibling env knobs in the runtime silently fall
 * back when they cannot parse a value, and for a *cost ceiling* that is right — ignoring
 * it fails toward less authority. Ignoring one of these fails toward less WORK: an
 * operator who typed `150junk` would be handed forty, watch the build die at forty, and
 * blame the model for the harness — the exact confusion this whole line of repair came
 * out of. So a malformed value is a configuration error, said out loud, before anything
 * is spent. Nothing is partially parsed and nothing is silently clamped.
 *
 * Shared by both knobs on purpose: two copies of this would eventually disagree about
 * what `2.5` means, and the one that drifted would be the one nobody was testing.
 */
export function resolveBuilderBound(input: {
  readonly raw: string | undefined;
  readonly envName: string;
  readonly shipped: number;
  readonly ceiling: number;
  /** What the bound counts, for the refusal message: "builder turns", "tool calls". */
  readonly noun: string;
}): BuilderBoundResolution {
  const text = (input.raw ?? "").trim();
  if (text.length === 0) return { ok: true, value: input.shipped, source: "default" };

  // A FULL integer, anchored. "2.5", "150junk", "0x20", "1e3" and " 12 x" are all
  // refused here rather than becoming 2, 150, 0, 1 or the default.
  if (!/^-?\d+$/.test(text)) {
    return { ok: false, reason: `${input.envName}="${text}" is not an integer (expected 1–${input.ceiling})` };
  }
  const n = Number(text);
  if (!Number.isSafeInteger(n)) {
    return { ok: false, reason: `${input.envName}="${text}" is not a representable integer` };
  }
  if (n < 1) {
    return { ok: false, reason: `${input.envName}=${n} would authorize no ${input.noun} (expected 1–${input.ceiling})` };
  }
  if (n > input.ceiling) {
    return {
      ok: false,
      reason:
        `${input.envName}=${n} exceeds the hard ceiling of ${input.ceiling}. ` +
        `The ceiling is a safety boundary, not a target — raise the budget deliberately ` +
        `and keep a session cost ceiling on.`,
    };
  }
  return { ok: true, value: n, source: "operator_env" };
}

/** Resolve the operator's tool-call budget. */
export function resolveBuilderToolCalls(raw: string | undefined): BuilderBoundResolution {
  return resolveBuilderBound({
    raw,
    envName: BUILDER_TOOL_CALLS_ENV,
    shipped: DEFAULT_BUILDER_BUDGET.maxToolCalls,
    ceiling: MAX_BUILDER_TOOL_CALLS_CEILING,
    noun: "tool calls",
  });
}

/** Resolve the operator's read-only command budget. */
export function resolveBuilderCommands(raw: string | undefined): BuilderBoundResolution {
  return resolveBuilderBound({
    raw,
    envName: BUILDER_COMMANDS_ENV,
    shipped: DEFAULT_BUILDER_BUDGET.maxCommands,
    ceiling: MAX_BUILDER_COMMANDS_CEILING,
    noun: "commands",
  });
}

/**
 * The hard ceiling. A SAFETY BOUNDARY, not a recommended operating point.
 *
 * A turn is a provider call against a context package that, on a real repository, runs
 * to tens of thousands of prompt tokens — the failed Ofi attempt spent $0.29 on twelve.
 * A hundred is therefore already an expensive number; it exists so that a typo cannot
 * authorize a thousand, and the cost ceilings remain the thing that actually stops spend.
 */
export const MAX_BUILDER_TURNS_CEILING = 100;

/** Where the effective turn budget came from. Recorded so a receipt can say. */
export type BuilderTurnSource = BuilderBoundSource;

/** Resolving the operator's turn budget either yields one, or refuses and says why. */
export type BuilderTurnResolution =
  | { readonly ok: true; readonly maxTurns: number; readonly source: BuilderTurnSource }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve the effective builder TURN budget.
 *
 * A thin naming over the shared resolver, kept as its own export because callers and
 * tests refer to turns by name. The parsing, the refusals and the ceiling behaviour are
 * the shared ones — there is no second copy to drift.
 */
export function resolveBuilderTurns(raw: string | undefined): BuilderTurnResolution {
  const r = resolveBuilderBound({
    raw,
    envName: BUILDER_TURNS_ENV,
    shipped: DEFAULT_BUILDER_BUDGET.maxTurns,
    ceiling: MAX_BUILDER_TURNS_CEILING,
    noun: "builder turns",
  });
  return r.ok ? { ok: true, maxTurns: r.value, source: r.source } : r;
}

/**
 * The default budget with ONLY its turn count replaced.
 *
 * Every other bound is copied unchanged, which is the point: this function is the reason
 * "more turns" cannot quietly become "more tools", "more mutations" or "more money".
 */
export function builderBudgetWithTurns(maxTurns: number): BuilderBudget {
  return Object.freeze({ ...DEFAULT_BUILDER_BUDGET, maxTurns });
}

/**
 * The default budget with ONLY the operator-settable bounds replaced.
 *
 * Every other bound is copied unchanged, which is the point: this function is the reason
 * "more turns" and "more tool calls" cannot quietly become "more mutations", "more
 * commands", "more output" or "more money". A test asserts the resulting key set equals
 * the shipped one, so a bound added later has to be considered here rather than silently
 * inherited.
 */
export function builderBudgetWith(bounds: {
  readonly maxTurns?: number;
  readonly maxToolCalls?: number;
  readonly maxCommands?: number;
}): BuilderBudget {
  return Object.freeze({
    ...DEFAULT_BUILDER_BUDGET,
    ...(bounds.maxTurns !== undefined ? { maxTurns: bounds.maxTurns } : {}),
    ...(bounds.maxToolCalls !== undefined ? { maxToolCalls: bounds.maxToolCalls } : {}),
    ...(bounds.maxCommands !== undefined ? { maxCommands: bounds.maxCommands } : {}),
  });
}

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
  /**
   * OPTIONAL read-only command capability (V2-015). When present, `run_command` runs one bounded
   * command with the candidate READ-ONLY and returns its output as untrusted evidence. It mints NO
   * observation and touches NO mutation authority. Absent ⇒ `run_command` is refused as unavailable.
   */
  readonly commands?: BuilderCommandCapability;
}

/** What one executed tool did, plus the ledger facts the candidate will need. */
export interface ToolExecution {
  readonly outcome: ToolOutcome;
  /** Present when the call APPLIED a mutation. Absent for reads and refusals. */
  readonly mutation?: { readonly mutationId: V2MutationDigest; readonly path: string };
  /** Present when the call RAN a command (V2-015). A command NEVER carries a mutation. */
  readonly command?: BuilderCommandRecord;
  /**
   * Present ONLY when a command changed the candidate tree — a HARD safety violation. The loop
   * MUST abort the whole build with this failure; it never continues after a command mutated state.
   */
  readonly safetyFailure?: RunFailure;
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
  /** Every read-only command the builder ran, in order (V2-015). Never carries a mutation. */
  readonly commands: readonly BuilderCommandRecord[];
  readonly turns: number;
  readonly toolCalls: number;
  readonly toolFailures: number;
  /** Every conversation fold this candidate needed. Empty when it always fitted. */
  readonly compactions: readonly CompactionEvent[];
  /** The window this candidate ran inside, derived from ITS resolved model's facts. */
  readonly ceiling: ConversationCeiling;
  /** The largest request this generation estimated, folded or not. */
  readonly maxEstimatedInputTokens: number;
  /** Read-only commands re-run against an unchanged candidate. Reported, never refused. */
  readonly repeatedCommands: number;
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
      /** Read-only commands that ran before the failure (V2-015). Counted, never discarded. */
      readonly commands: readonly BuilderCommandRecord[];
      /**
       * THE EXECUTION ENVELOPE, preserved through the failure.
       *
       * A failed generation is exactly when an operator most needs to know what the
       * builder was working inside — which window, which ceiling, how often it folded,
       * how close it came. Reporting it only on success meant the receipt went silent at
       * the one moment it was being asked a question, and the numbers had to be
       * reconstructed afterwards from provider usage. The builder already knows them.
       */
      readonly ceiling: ConversationCeiling;
      readonly compactions: readonly CompactionEvent[];
      /** Turns actually executed before the failure. */
      readonly turns: number;
      /** The largest request this generation estimated, folded or not. */
      readonly maxEstimatedInputTokens: number;
      readonly repeatedCommands: number;
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
  const commands: BuilderCommandRecord[] = [];
  let toolCalls = 0;
  let toolFailures = 0;
  let turns = 0;
  /* The window ceiling for THIS model, derived once from the package's own budget — which
     already failed closed if the model had no known window. */
  const ceiling = conversationCeiling(input.contextPackage.budget);
  /* What the harness recorded the tools doing, accumulated as they run. Never rebuilt from
     the conversation, so folding a message can never lose or invent a fact. */
  const facts: CompactedFact[] = [];
  const compactions: CompactionEvent[] = [];
  /* The high-water mark of what was actually about to be sent. Recorded so a receipt can
     say how close a run came to its ceiling without anyone re-deriving it later. */
  let maxEstimatedInputTokens = 0;
  /*
    THE CANDIDATE'S MUTATION EPOCH, and the read-only commands already asked of it.
    The epoch advances only when a mutation actually lands, so a command repeated
    against an unchanged tree is recognisable while the same command after a write is
    legitimate fresh inspection.
  */
  let mutationEpoch = 0;
  const commandsSeen = new Map<string, PriorCommandRun>();
  /** Repeats observed, for the receipt. Counted, never used to refuse anything. */
  let repeatedCommands = 0;

  const attemptedInvocationIds: V2InvocationId[] = [];
  /** Everything that really happened, for a failure that must not erase it. */
  const partial = (failure: RunFailure): BuilderResult => ({
    ok: false, failure, invocations, mutationIds, attemptedInvocationIds, commands,
    // Same evidence the success path reports, so a receipt reads identically either way.
    ceiling, compactions, turns, maxEstimatedInputTokens, repeatedCommands,
  });

  while (turns < budget.maxTurns) {
    /*
      WINDOW MANAGEMENT, BEFORE ANYTHING REACHES THE WIRE.

      The conversation is re-rendered in full every turn, so it grows without bound while
      the model's window does not. This fits the next request under the ceiling first —
      folding older exchanges into a harness-authored account of what the tools actually
      did — and refuses to send at all if even the minimum lawful request does not fit.

      No model call happens here. Compaction is arithmetic and string building.
    */
    /* The status for the invocation ABOUT to happen: turns has not been incremented yet,
       so the turn being taken is turns + 1. Everything else is the live counter. */
    const budgetStatus = renderBudgetStatus({
      turnUsed: turns + 1,
      turnLimit: budget.maxTurns,
      toolCallsUsed: toolCalls,
      toolCallsLimit: budget.maxToolCalls,
      mutationsUsed: mutationIds.length,
      mutationsLimit: budget.maxMutations,
      commandsUsed: commands.length,
      commandsLimit: budget.maxCommands,
    });
    const renderWith = (c: readonly RenderedMessage[]) =>
      estimateMessagesTokens(
        renderBuilderInput(input.contextPackage, c, input.untrustedBoundary, input.repairBrief !== undefined ? { repairBrief: input.repairBrief, boundary: input.untrustedBoundary } : undefined, budgetStatus).messages,
        // THE model's own estimator, resolved once with the budget and frozen for the run.
        input.contextPackage.budget.tokenEstimator,
      );
    const fitted = fitConversation({ conversation, memory: { facts, changedPaths: [...changedPaths] }, ceiling, turn: turns + 1, renderSize: renderWith });
    if (!fitted.ok) return partial(fitted.failure);
    maxEstimatedInputTokens = Math.max(maxEstimatedInputTokens, fitted.estimatedTokens);
    if (fitted.event !== undefined) {
      compactions.push(fitted.event);
      /* The fold is durable: the conversation the loop carries forward IS the compacted
         one, so the next turn builds on it rather than re-growing the history it just
         folded and paying to fold it again. */
      conversation.length = 0;
      conversation.push(...fitted.conversation);
    }

    // ONE TURN = ONE INVOCATION, through the one authority. There is no other doorway
    // to a model in v2, and the controller does not hold a transport it could use
    // directly — it hands the authority the one it was given.
    const rendered = renderBuilderInput(input.contextPackage, conversation, input.untrustedBoundary, input.repairBrief !== undefined ? { repairBrief: input.repairBrief, boundary: input.untrustedBoundary } : undefined, budgetStatus);
    const turnMaxOutputTokens = Math.min(budget.maxOutputTokens, input.contextPackage.budget.reservedCompletionTokens);
    // PRE-CALL COST ADMISSION. BEFORE the money is spent, ask the session budget authority
    // whether another model call is authorized. It never selects or downgrades a model — it
    // only answers proceed / stop. A denial ends the builder with a structured, non-retryable
    // policy failure; recovery treats cost exhaustion as operator-required, never a retry.
    if (input.admission !== undefined) {
      const admitted = input.admission.admitNext({
        identity: { authorizedModelId: input.decision.modelId, sentProviderId: input.decision.providerId, sentProviderModelId: input.decision.providerModelId },
        /*
          THE REQUEST THAT IS ABOUT TO BE SENT, not the package it started from.

          This used to pass `contextPackage.budget.availableInputTokens` — the room the
          package was ALLOWED, fixed at assembly and stale from turn two onward. It both
          overstated a short first turn and understated every long one, so a session cost
          ceiling was being enforced against a number that had nothing to do with the
          prompt. Now it is the estimate of the exact rendered messages.
        */
        estimatedInputTokens: fitted.estimatedTokens,
        maxOutputTokens: turnMaxOutputTokens,
      });
      if (!admitted.admit) return partial(admitted.failure);
    }
    const invocationId = input.mintInvocationId();
    // M2: this call is about to reach the wire — count it against the session invocation cap BEFORE
    // the send, so a failing/malformed call consumes a slot too (never a free retry on the wire).
    if (input.admission !== undefined) input.admission.recordAttempt(invocationId);
    const called = await invokeAuthorized({
      runId: input.runId,
      taskId: input.taskId,
      invocationId,
      decision: input.decision,
      contextPackage: input.contextPackage,
      rendered,
      // Calibration evidence: what we thought this request was, recorded beside what the
      // provider says it was. Read by nothing during the run.
      estimatedInputTokens: fitted.estimatedTokens,
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

    // V2-016A/L2: DUPLICATE TOOL-CALL IDS within one assistant turn are refused BEFORE executing
    // ANY of them — a repeated id would make a tool RESULT ambiguous (two calls answered by one
    // message), which is exactly how a duplicated write could be mis-attributed. Nudge and reloop.
    const callIds = called.toolCalls.map((c) => c.id);
    if (new Set(callIds).size !== callIds.length) {
      toolFailures += 1;
      conversation.push({
        role: "user",
        content: "Your turn reused a tool_call id across two calls. Each tool call must have a UNIQUE id. No tools were executed this turn — reissue them with distinct ids.",
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
        facts.push(factOf({ kind: "rejected", reason: parsed.reason, detail: parsed.detail }));
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

      // A COMMAND BUDGET, separate from mutations and tool calls: a model must not burn
      // unbounded local CPU without model turns. Checked BEFORE dispatch so nothing runs past it.
      if (parsed.name === "run_command" && commands.length >= budget.maxCommands) {
        return partial(
          buildFailure({
            code: V2_COMMAND_FAILURE_CODES.commandBudgetExhausted,
            message: `the builder ran ${commands.length} commands, which is the limit for one candidate`,
            detail: { maxCommands: budget.maxCommands, turns },
          }),
        );
      }

      const executed = await input.executor.execute(parsed);
      // A COMMAND THAT MUTATED THE CANDIDATE TREE is a hard safety violation — abort the whole
      // build immediately. It never continues after a command changed state.
      if (executed.safetyFailure !== undefined) return partial(executed.safetyFailure);
      if (isToolFailure(executed.outcome)) toolFailures += 1;
      if (executed.command !== undefined) commands.push(executed.command);
      if (executed.mutation !== undefined) {
        mutationIds.push(executed.mutation.mutationId);
        changedPaths.add(executed.mutation.path);
        // The tree moved. Every earlier observation of it is now history, so a command
        // re-asked after this point is a NEW question, not a repeat.
        mutationEpoch += 1;
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
      /* THE fact ledger. Recorded from the executor's own outcome — the same object the
         mutation authority produced — so what survives a fold is what happened, not what
         anybody said happened. */
      facts.push(factOf(executed.outcome));

      /*
        REPEATED READ-ONLY EXPLORATION. Only a command that actually LAUNCHED is recorded
        or matched: a policy refusal ran nothing, so it neither establishes a prior result
        nor makes a later real execution redundant.
      */
      let repeatNote: string | undefined;
      if (executed.outcome.kind === "command" && executed.outcome.launched && !executed.outcome.refused) {
        const key = commandRepeatKey({
          program: executed.outcome.program,
          args: executed.outcome.args,
          cwd: executed.outcome.cwd,
          epoch: mutationEpoch,
        });
        const prior = commandsSeen.get(key);
        if (prior !== undefined) {
          repeatedCommands += 1;
          repeatNote = repeatedCommandNote(prior, 0);
        } else {
          commandsSeen.set(key, { turn: turns, ordinal: commands.length });
        }
      }
      appendToolResult(conversation, input.untrustedBoundary, call, executed.outcome, repeatNote);
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
          commands,
          turns,
          toolCalls,
          toolFailures,
          compactions,
          ceiling,
          maxEstimatedInputTokens,
          repeatedCommands,
          startedAt,
          endedAt: now(),
        },
      };
    }
  }

  return partial(
    buildFailure({
      code: V2_BUILD_FAILURE_CODES.turnLimitExceeded,
      // Names the EFFECTIVE limit, not a remembered constant: an operator who raised the
      // budget must be able to read the number their run actually ran under.
      message: `the builder took ${turns} turns without calling finish_candidate (limit ${budget.maxTurns})`,
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
  /**
   * A harness-authored note to carry with this result — today, that an identical
   * read-only command already ran against the unchanged candidate. It joins the TRUSTED
   * provenance half of the message rather than the fenced payload, because ikbi wrote it
   * and it is a fact about ikbi's own execution ledger, not repository-derived text.
   */
  note?: string,
): void {
  const provenance = note !== undefined ? `${renderToolProvenance(outcome)}\n${note}` : renderToolProvenance(outcome);
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

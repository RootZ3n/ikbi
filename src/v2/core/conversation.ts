/**
 * ikbi v2 — THE BUILDER CONVERSATION BUDGET AND ITS COMPACTION.
 *
 * AUTHORITATIVE STATE IS STRUCTURED. CONVERSATION IS A VIEW.
 *
 * ── The defect this closes ────────────────────────────────────────────────
 *
 * v2 budgeted the initial `ContextPackage` against the selected model's declared window
 * and then let the builder append to a conversation that is re-rendered, in full, on
 * every turn. Nothing measured the result. On a real repository with real MiMo
 * (65,536-token window) the prompt grew to ~69,937 tokens over twelve turns and ~93,953
 * over twenty-four — 43% past the window, sent anyway, with no guard and no warning.
 *
 * The symptom looked like an incapable model: tiny 24–46-token replies, one small read
 * per turn, no mutations, no candidate, $0.705 spent. It was the harness. Raising the
 * turn budget made it worse, because more turns meant more conversation.
 *
 * ── What this module does instead ─────────────────────────────────────────
 *
 * The model does not need every historical sentence forever. It needs the task, the
 * repository context, the current working state, the recent exchange, and a TRUTHFUL
 * STRUCTURED ACCOUNT of older work. So older turns are folded, LOCALLY and
 * DETERMINISTICALLY, into one harness-authored memory block:
 *
 *   · what was read, what was written, what commands ran, what was refused
 *   · as facts recorded by the harness — never as the model's own claims
 *
 * ── Three rules that keep it honest ───────────────────────────────────────
 *
 *  1. NO MODEL CALL. Compaction is arithmetic and string building. There is no
 *     summarizer, so the invocation count is exactly the builder/critic calls a run
 *     made, and no cost appears that a receipt cannot explain.
 *
 *  2. NO INVENTED AUTHORITY. The memory block records that an observation happened; it
 *     never presents one as usable. A write still needs an ObservationId the mutation
 *     authority accepts, and that authority is untouched here — if the id was compacted
 *     away, or the file moved under it, the write is refused exactly as before. Prose
 *     never becomes permission.
 *
 *  3. NO REPOSITORY CONTENT. The block carries provenance only — paths, ids, states,
 *     hashes, byte counts, exit codes. Never file bodies, never command output. Tool
 *     payloads reached the model through the untrusted boundary; summarizing their
 *     *content* into a harness-authored message would launder untrusted text into
 *     trusted framing, which is the one thing the neutralization fence exists to stop.
 *     Metadata the harness observed itself is the harness's to state.
 */

import { estimateTokensWith, type ContextBudget } from "./context.js";
import type { TokenEstimatorFacts } from "./config.js";
import { runFailure, type RunFailure } from "./failure.js";
import type { RenderedMessage } from "./prompt.js";
import type { ToolOutcome } from "./tools.js";

/** Bumped when the folding changes shape, so a receipt says which algorithm ran. */
export const COMPACTION_ALGORITHM = "v2-conversation-compaction-1";

/**
 * How the token count for a request was arrived at.
 *
 * MODEL NAMES SELECT FACTS; FACTS SELECT BEHAVIOR. There is no tokenizer here and no
 * model-family branch: every number this module uses arrives as capability FACTS about
 * the model resolved for this run. What varies between an 8k local model and a 200k
 * frontier one is the facts, not the code.
 *
 * `conservative_estimate` is what ikbi can honestly claim today — a chars-per-token
 * heuristic, the same one the context assembler budgets with. The other two members exist
 * so that a real tokenizer, or a provider-reported prompt count, can be adopted later
 * WITHOUT the receipt silently starting to claim precision it never had. Nothing may
 * report `exact` unless it counted with the selected model's own tokenizer.
 */
export type TokenEstimatorKind = "exact" | "provider_reported" | "conservative_estimate";

/** What this build actually used. One value today, and it is the honest one. */
export const ESTIMATOR_KIND: TokenEstimatorKind = "conservative_estimate";

/**
 * Head-room beyond the reserves the context budget already holds back.
 *
 * The estimator is `chars/4`, adopted from v1 and always labelled an estimate. It is
 * decent on prose and OPTIMISTIC on the things a builder conversation is actually full
 * of — JSON tool arguments, paths, hashes, code — where real tokenizers run denser than
 * four characters per token. This margin is what stands between "our estimate says it
 * fits" and "the provider agrees it fits". It is deliberately generous.
 */
/**
 * How much DENSER than the estimator assumes a request's content might really be.
 *
 * The margin's whole job is to absorb estimator error, and estimator error is
 * proportional to the SIZE OF THE REQUEST, not to the size of the model's window. A
 * fraction-of-window margin gets that backwards: it over-protects a small request on a
 * big model and under-protects a big one, and on an 8k model a flat floor ate a quarter
 * of the budget.
 *
 * So the allowance is a ratio, and the ceiling is derived by dividing rather than
 * subtracting. 1.10 means "assume the real request could be ten percent larger than we
 * estimated". Measured density on real builder conversations was 3.560 and 3.587
 * chars/token against an estimator assuming 3.5 — that is, the estimator already runs
 * ~2% conservative, and ten percent covers content materially denser than anything
 * observed before the completion reserve is touched at all.
 *
 * Derived from capability facts and one policy constant. No model name is involved.
 */
export const ESTIMATOR_RESIDUAL_ALLOWANCE = 1.1;

/**
 * The fewest recent turn groups kept verbatim before the fit is declared impossible.
 *
 * One is the floor rather than zero because a builder that cannot see the result of the
 * tool it just called cannot make progress at all — it would re-issue the same call
 * forever. Compaction that produces a livelock is not a fit.
 */
export const MIN_RECENT_GROUPS = 1;

/**
 * How many recent groups to keep when there is room.
 *
 * Four covers the interaction the model is actually mid-way through: the call it just
 * made and its result, plus the two exchanges that led there — enough to continue a
 * thought and to see a refusal it has not yet answered. Below three, models start
 * re-reading files they read moments earlier; above about six the tail stops paying for
 * itself on a long run. It is a policy choice, and it is tested rather than assumed.
 */
export const DEFAULT_RECENT_GROUPS = 4;

/* ── The ceiling ─────────────────────────────────────────────────────────── */

/**
 * THE one place the window arithmetic lives.
 *
 * Every number comes from the resolved model's capability facts by way of the context
 * budget — which already fails closed when the window is unknown, so an unclassified
 * model can never reach this with an invented window.
 */
export interface ConversationCeiling {
  readonly contextWindowTokens: number;
  readonly reservedCompletionTokens: number;
  readonly reservedOverheadTokens: number;
  readonly safetyMarginTokens: number;
  /** The most a rendered request may be ESTIMATED at before it must be compacted. */
  readonly maxRenderedInputTokens: number;
  /** How the estimate was produced. Never `exact` unless it truly is. */
  readonly estimator: TokenEstimatorKind;
  /** The resolved estimator facts these numbers were computed with. */
  readonly tokenEstimator: TokenEstimatorFacts;
  /** Where the window fact came from — roster-declared, table-known, and so on. */
  readonly capabilityProvenance: ContextBudget["capabilityProvenance"];
}

/**
 * Derive the ceiling for one model.
 *
 * The invariant, stated as arithmetic:
 *
 *     rendered input + reserved output + overhead + margin <= context window
 *
 * `reservedCompletionTokens` is used rather than the builder's per-turn output cap
 * because it is the larger of the two and this is a safety boundary. Reserving more
 * output room than a turn will use costs a little input room and can never overflow.
 */
export function conversationCeiling(budget: ContextBudget): ConversationCeiling {
  /*
    A budget that is not fully formed would produce a NaN ceiling, and every comparison
    against NaN is false — which fails closed, but fails closed with an incomprehensible
    message three layers away. Production budgets always come from `deriveBudget`; this
    turns a malformed one into the configuration error it is, where it happened.
  */
  for (const [name, value] of [
    ["contextWindowTokens", budget.contextWindowTokens],
    ["reservedCompletionTokens", budget.reservedCompletionTokens],
    ["reservedOverheadTokens", budget.reservedOverheadTokens],
  ] as const) {
    if (!Number.isFinite(value)) {
      throw new Error(`context budget is malformed: ${name} is ${String(value)} — a conversation ceiling cannot be derived from it`);
    }
  }
  /*
    The room a request may occupy after the reply and prompt overhead are set aside,
    DIVIDED by the allowance — so that even a request whose real content is denser than
    the estimator assumed still fits the window without borrowing the completion reserve.
  */
  const usable = budget.contextWindowTokens - budget.reservedCompletionTokens - budget.reservedOverheadTokens;
  const maxRenderedInputTokens = Math.max(0, Math.floor(usable / ESTIMATOR_RESIDUAL_ALLOWANCE));
  /* What the allowance cost, expressed as tokens, so a receipt can still show a margin. */
  const safetyMarginTokens = usable - maxRenderedInputTokens;
  return {
    contextWindowTokens: budget.contextWindowTokens,
    reservedCompletionTokens: budget.reservedCompletionTokens,
    reservedOverheadTokens: budget.reservedOverheadTokens,
    safetyMarginTokens,
    maxRenderedInputTokens,
    estimator: ESTIMATOR_KIND,
    tokenEstimator: budget.tokenEstimator,
    capabilityProvenance: budget.capabilityProvenance,
  };
}

/**
 * Estimate a rendered request, message by message.
 *
 * Tool CALL arguments are counted too. They are JSON the provider puts on the wire and
 * they are frequently the largest thing in an assistant turn — a `replace_file` call
 * carries a whole file body — so a count that ignored them would understate exactly the
 * requests most at risk of overflowing.
 */
export function estimateMessagesTokens(
  messages: readonly RenderedMessage[],
  estimator: TokenEstimatorFacts,
): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokensWith(m.content, estimator);
    for (const call of m.toolCalls ?? []) {
      total += estimateTokensWith(call.name, estimator) + estimateTokensWith(call.arguments, estimator);
    }
  }
  return total;
}

/* ── Turn groups ─────────────────────────────────────────────────────────── */

/**
 * One logical exchange: an assistant turn and everything that answered it.
 *
 * Grouping exists to keep the wire protocol valid. A native tool call and its result are
 * one indivisible unit — an assistant message carrying `toolCalls` whose `tool` results
 * were compacted away is a malformed request that providers reject, and a `tool` message
 * whose call is gone is worse. So compaction moves whole groups or nothing.
 */
export interface TurnGroup {
  readonly messages: readonly RenderedMessage[];
}

/** Split a conversation into groups, each starting at an assistant turn. */
export function groupConversation(conversation: readonly RenderedMessage[]): TurnGroup[] {
  const groups: { messages: RenderedMessage[] }[] = [];
  for (const message of conversation) {
    if (message.role === "assistant" || groups.length === 0) {
      groups.push({ messages: [message] });
    } else {
      groups[groups.length - 1]!.messages.push(message);
    }
  }
  return groups;
}

/* ── Structured memory ───────────────────────────────────────────────────── */

/**
 * What the harness ITSELF observed a tool do. Facts, not claims.
 *
 * Every field here was produced by an ikbi authority — the mutation authority, the
 * command capability — never by the model. That provenance is the whole reason this can
 * be folded into a harness-authored message at all.
 */
export interface CompactedFact {
  readonly kind: ToolOutcome["kind"];
  readonly line: string;
}

/** Fold one tool outcome into one truthful line of provenance. No content, ever. */
export function factOf(outcome: ToolOutcome): CompactedFact {
  switch (outcome.kind) {
    case "observed":
      return {
        kind: "observed",
        line:
          `read ${outcome.path} (${outcome.state}` +
          `${outcome.byteLength !== null ? `, ${outcome.byteLength} bytes` : ""}` +
          `${outcome.truncated === true ? ", truncated" : ""})`,
      };
    case "applied":
      return {
        kind: "applied",
        line: `${outcome.operation} ${outcome.path} — ${outcome.changed ? "CHANGED" : "no change"}${
          outcome.afterSha256 !== null ? ` (now ${outcome.afterSha256.slice(0, 12)})` : ""
        }`,
      };
    case "refused":
      return { kind: "refused", line: `REFUSED ${outcome.path}: ${outcome.code}` };
    case "command":
      return {
        kind: "command",
        line:
          `ran ${outcome.program} ${outcome.args.join(" ")} — ` +
          (outcome.refused
            ? `REFUSED (${outcome.refusalCode ?? "policy"})`
            : outcome.timedOut
              ? "TIMED OUT"
              : `exit ${outcome.exitCode ?? "?"}`),
      };
    case "rejected":
      // The harness refused the CALL — a malformed argument, an unknown tool, a bad path.
      // The reason is ikbi's own classification, so it is safe to state; the detail may
      // quote the model's argument, so it does not travel.
      return { kind: "rejected", line: `rejected a tool call: ${outcome.reason}` };
    case "finished":
      // Only reachable if a finish was recorded and the loop kept going, which it does
      // not — carried for exhaustiveness rather than because it is expected.
      return { kind: "finished", line: "called finish_candidate" };
  }
}

/**
 * The running account of what the builder has actually done.
 *
 * Accumulated as the loop dispatches tools, NOT reconstructed from the conversation —
 * so folding a message away can never lose a fact, and a fact can never be invented from
 * text the model wrote.
 */
export interface ConversationMemory {
  /** Facts, in the order the harness recorded them. */
  readonly facts: readonly CompactedFact[];
  /** Paths a mutation actually changed. The one list a builder most needs to recall. */
  readonly changedPaths: readonly string[];
}

export const EMPTY_MEMORY: ConversationMemory = Object.freeze({ facts: [], changedPaths: [] });

/**
 * Render the memory block.
 *
 * Written in the harness's own voice and explicitly separated into what is FACT and what
 * the model must not assume. The closing line is the load-bearing one: it tells the model
 * that any observation it can no longer see must be re-read before it can be written
 * through — which is also exactly what the mutation authority will enforce if it tries.
 */
export function renderMemory(memory: ConversationMemory, foldedGroups: number): RenderedMessage {
  const lines: string[] = [
    "[ikbi] EARLIER WORK IN THIS CANDIDATE, recorded by the harness.",
    "",
    `The first ${foldedGroups} exchange${foldedGroups === 1 ? "" : "s"} of this session ` +
      "have been folded to stay inside the model context window. What follows is what the " +
      "TOOLS actually did — not what anybody said they did. Nothing was lost that is listed here.",
    "",
  ];

  if (memory.facts.length === 0) {
    lines.push("  (no tool calls completed in the folded exchanges)");
  } else {
    lines.push("FACTS — tool outcomes recorded by ikbi:");
    for (const fact of memory.facts) lines.push(`  · ${fact.line}`);
  }

  if (memory.changedPaths.length > 0) {
    lines.push("", "FILES YOU HAVE ALREADY CHANGED IN THIS CANDIDATE:");
    for (const path of memory.changedPaths) lines.push(`  · ${path}`);
  }

  lines.push(
    "",
    "IMPORTANT: the observation ids from those folded exchanges are no longer in front of you. " +
      "An observation is only usable while you can see it, and a write will be refused without a " +
      "current one. If you need to change a file again, read it again first. Re-reading is cheap " +
      "and always allowed.",
  );

  return { role: "user", content: lines.join("\n") };
}

/* ── Fitting ─────────────────────────────────────────────────────────────── */

/** What compaction did, for the receipt. Never carries prompt text. */
export interface CompactionEvent {
  /** The builder turn (1-based) at which it ran. */
  readonly turn: number;
  readonly estimatedTokensBefore: number;
  readonly estimatedTokensAfter: number;
  /** Turn groups folded into structured memory. */
  readonly groupsFolded: number;
  /** Turn groups kept verbatim after the fold. */
  readonly groupsKept: number;
  readonly algorithm: string;
}

export const V2_CONVERSATION_FAILURE_CODES = {
  /** Even the minimum lawful request does not fit the model's window. */
  minimumRequestExceedsWindow: "context.minimum_request_exceeds_window",
} as const;

/** The result of fitting one turn's request under the ceiling. */
export type FitResult =
  | {
      readonly ok: true;
      /** The conversation to render. Identical to the input when nothing was folded. */
      readonly conversation: readonly RenderedMessage[];
      readonly estimatedTokens: number;
      /** Absent when the request already fitted. */
      readonly event?: CompactionEvent;
    }
  | { readonly ok: false; readonly failure: RunFailure };

/**
 * Fit the next request under the ceiling, folding older history if it must.
 *
 * Deterministic and total: same conversation, same memory, same ceiling ⇒ same answer,
 * in this process or any other. It performs no I/O and calls no model.
 *
 * The loop is "keep as much recent verbatim history as still fits": try the preferred
 * tail, and if the result is still over, keep one group fewer, down to the floor. This
 * gives back the largest lawful amount of real conversation rather than the smallest.
 *
 * `renderSize` is injected — the caller knows how to render, and this module must not
 * grow a second copy of the prompt layout that could drift from the real one.
 */
export function fitConversation(input: {
  readonly conversation: readonly RenderedMessage[];
  readonly memory: ConversationMemory;
  readonly ceiling: ConversationCeiling;
  readonly turn: number;
  /** Estimated tokens of a request rendered with this conversation. */
  readonly renderSize: (conversation: readonly RenderedMessage[]) => number;
  readonly recentGroups?: number;
}): FitResult {
  const { conversation, memory, ceiling, turn, renderSize } = input;
  const before = renderSize(conversation);
  if (before <= ceiling.maxRenderedInputTokens) {
    return { ok: true, conversation, estimatedTokens: before };
  }

  const groups = groupConversation(conversation);
  const preferred = Math.min(input.recentGroups ?? DEFAULT_RECENT_GROUPS, groups.length);

  for (let keep = preferred; keep >= MIN_RECENT_GROUPS; keep -= 1) {
    const folded = groups.length - keep;
    if (folded <= 0) continue; // nothing to gain — this tail is the whole conversation
    const tail = groups.slice(groups.length - keep).flatMap((g) => g.messages);
    const compacted: RenderedMessage[] = [renderMemory(memory, folded), ...tail];
    const after = renderSize(compacted);
    if (after <= ceiling.maxRenderedInputTokens) {
      return {
        ok: true,
        conversation: compacted,
        estimatedTokens: after,
        event: {
          turn,
          estimatedTokensBefore: before,
          estimatedTokensAfter: after,
          groupsFolded: folded,
          groupsKept: keep,
          algorithm: COMPACTION_ALGORITHM,
        },
      };
    }
  }

  /*
    Nothing lawful fits. STOP BEFORE THE WIRE — this is a configuration truth about the
    model and the repository, not a transport error and not the provider's fault. Sending
    it anyway is what produced the silent degradation this module exists to end.
  */
  const floor = groups.length > MIN_RECENT_GROUPS
    ? renderSize([renderMemory(memory, groups.length - MIN_RECENT_GROUPS), ...groups.slice(groups.length - MIN_RECENT_GROUPS).flatMap((g) => g.messages)])
    : before;
  return {
    ok: false,
    failure: runFailure({
      category: "context",
      code: V2_CONVERSATION_FAILURE_CODES.minimumRequestExceedsWindow,
      message:
        `the smallest lawful request for this turn is an estimated ${floor} tokens, above the ` +
        `${ceiling.maxRenderedInputTokens}-token ceiling for a ${ceiling.contextWindowTokens}-token model ` +
        `(after reserving ${ceiling.reservedCompletionTokens} for the reply, ${ceiling.reservedOverheadTokens} for prompt overhead ` +
        `and a ${ceiling.safetyMarginTokens}-token margin) — the immutable context package plus one exchange does not fit`,
      stage: "candidate_generation",
      retryable: false,
      detail: {
        estimatedTokens: floor,
        maxRenderedInputTokens: ceiling.maxRenderedInputTokens,
        contextWindowTokens: ceiling.contextWindowTokens,
        turn,
      },
    }),
  };
}

/**
 * ikbi v2 — THE MODEL-INPUT RENDERER.
 *
 * One place turns (task + `ContextPackage` + the builder's evolving conversation) into
 * the messages a provider receives. It is the ONLY place repository content becomes model
 * input, and it takes that content exclusively from the package V2-004 authorized: it
 * reads no file, calls no retriever, consults no memory, and has no path by which
 * anything else could be appended.
 *
 * TWO TERMS, KEPT APART DELIBERATELY:
 *
 *   ContextPackage       the AUTHORIZED initial repository context. Assembled once, by
 *                        the one context authority, from the one source snapshot.
 *   BuilderConversation  the EVOLVING interaction — what the model said, what tools it
 *                        called, and exactly what those tools reported back.
 *
 * The package is rendered into the opening turn and never re-assembled; the conversation
 * grows. Collapsing the two would mean re-running context assembly inside the builder
 * loop, which is a second context authority by another name.
 *
 * WHY RENDERING LIVES HERE AND NOT IN THE INVOCATION AUTHORITY. V2-005 rendered inside
 * `invokeAuthorized`, which was fine while there was exactly one kind of prompt. With a
 * real builder there are many turns, and an authority that built them would have to
 * understand tool protocol, conversation state and builder semantics — none of which is
 * its job. It now receives a `RenderedModelInput` and remains responsible only for
 * binding, sending, and attributing what came back.
 */

import { contentDigest, type V2PromptDigest } from "./identity.js";
import type { ContextPackage } from "./context.js";
import type { BuilderToolCall } from "./tools.js";
import { REPAIR_SYSTEM_NOTE, renderRepairBrief, type RepairBrief } from "./repair.js";
import type { UntrustedBoundary } from "./builder.js";

/**
 * A message as v2 renders it, before the transport's own shape is applied.
 *
 * `assistant` and `tool` exist so a real tool loop can round-trip: the model's own turn
 * (with the calls it made) has to go back on the wire, and each result has to be
 * attributable to the call it answers.
 */
export interface RenderedMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  /** For an assistant turn: the tool calls it emitted, verbatim. */
  readonly toolCalls?: readonly BuilderToolCall[];
  /** For a tool result: the id of the call it answers. */
  readonly toolCallId?: string;
  /**
   * STRUCTURAL ISOLATION metadata. True when the message carries repository- or
   * tool-derived content wrapped by the untrusted-data boundary, so nothing downstream can
   * treat it as a trusted instruction even by accident. It does not change the wire body.
   */
  readonly untrusted?: boolean;
}

/** The exact input placed on the wire, plus its identity. */
export interface RenderedModelInput {
  readonly promptId: V2PromptDigest;
  readonly messages: readonly RenderedMessage[];
  /** Characters across all messages — the size actually sent, not an estimate of it. */
  readonly characters: number;
}

/**
 * THE BUILDER CONTRACT.
 *
 * It states the rules that are actually enforced, and nothing about how they are
 * enforced: a model does not need to know what a compare-and-swap is, only that it must
 * read before it writes and that a refused write really did not happen. Architecture
 * internals are deliberately absent — they are not useful to the model and every extra
 * paragraph is context spent on something other than the task.
 */
export const BUILDER_SYSTEM_INSTRUCTION = [
  "You are ikbi's builder. You make the requested code change, and nothing else.",
  "",
  "WHERE YOU ARE. You work in an isolated copy of the repository. The operator's own checkout is untouched by anything you do, including their uncommitted work, which has already been reproduced here for you. Your changes are a proposal; they are not applied to their repository by you.",
  "",
  "WHAT YOU WERE GIVEN. The repository context below was selected for you already. It is what you start from.",
  "",
  "HOW YOU EDIT. Every write must name the state it is replacing:",
  "  1. call read_file(path) — this returns an observationId for that path's exact current state;",
  "  2. call replace_file / create_file / delete_file with that observationId.",
  "This applies to a file you are creating too: read the path first, receive the 'missing' observation, then create against it.",
  "If a file changed after you read it, your write is REFUSED and nothing is written. Read it again and decide what to do — do not assume it worked.",
  "Supply COMPLETE file contents when replacing or creating. There is no partial-edit tool.",
  "",
  "WHEN YOU ARE DONE. Call finish_candidate with a short summary and whether you believe the work is complete. That call is the only way to finish; stopping without it counts as unfinished. Your summary is recorded as YOUR CLAIM — do not describe the work as tested, verified or correct. Something else checks that afterwards, and saying so here does not make it so.",
].join("\n");

/**
 * Render one context artifact: TRUSTED ikbi provenance (index, category, path, digest, truncation)
 * as a header OUTSIDE the fence, then the artifact's body.
 *
 * V2-016A/B3: repository-derived free text is DATA, not instruction authority. Only the `task`
 * category is trusted operator intent and stays raw; EVERY other category — repository instructions
 * (AGENTS.md), goal-target file bodies, and retrieved repository evidence — crosses the canonical
 * UntrustedBoundary as `source: "repo"` (LOSSLESS: the exact bytes survive and the digest still
 * refers to the raw content). An AGENTS.md is advisory repository content, not system authority
 * merely because of its filename.
 */
function renderArtifact(index: number, artifact: ContextPackage["artifacts"][number], boundary: UntrustedBoundary): string {
  const where = artifact.path ?? "(operator task)";
  const header = `--- context[${index}] ${artifact.category} · ${where} · sha256:${artifact.observedSha256.slice(0, 16)}${artifact.truncated ? " · TRUNCATED" : ""} ---`;
  // The operator TASK is trusted operator intent — never fenced. Everything else is untrusted
  // repository-controlled content and crosses the fence, losslessly.
  const body = artifact.category === "task"
    ? artifact.content
    : boundary.wrap({ content: artifact.content, source: "repo", origin: `context:${artifact.category}:${artifact.path ?? "(operator task)"}` });
  return `${header}\n${body}`;
}

/**
 * Render the authorized context package as the builder's opening user turn.
 *
 * The package's artifact ORDER is the delivery order — the assembler already applied the
 * priority policy, and this function does not re-rank, re-select, or top up. Omissions
 * are stated rather than hidden, so a model is told what it was NOT given instead of
 * silently reasoning from a partial view.
 */
export function renderContextBlocks(pkg: ContextPackage, boundary: UntrustedBoundary): string {
  const blocks = pkg.artifacts.map((artifact, index) => renderArtifact(index, artifact, boundary));
  if (pkg.omissions.length > 0) {
    blocks.push(
      `--- context omissions (${pkg.omissions.length}) ---\n` +
        pkg.omissions.map((o) => `${o.category} ${o.path ?? ""}: ${o.reason}`).join("\n"),
    );
  }
  return blocks.join("\n\n");
}

/**
 * Render one builder turn: the standing contract, the authorized context, then the
 * conversation so far exactly as it happened.
 *
 * `promptId` is content-addressed over the FULL message list, so two turns of the same
 * run have different prompt identities — which is what makes an invocation record able to
 * say which turn it was without a counter anyone could get wrong.
 */
export function renderBuilderInput(
  pkg: ContextPackage,
  conversation: readonly RenderedMessage[],
  boundary: UntrustedBoundary,
  repair?: { readonly repairBrief: RepairBrief; readonly boundary: UntrustedBoundary },
): RenderedModelInput {
  // The ORIGINAL task and the current context come first and outrank everything. The repair
  // brief — when present — is a distinct, LOWER-priority, untrusted historical block placed after
  // the current context (so current source truth always outranks stale historical text), and the
  // system contract gains one repair-aware paragraph ONLY on a repair attempt.
  const systemContent = repair === undefined
    ? BUILDER_SYSTEM_INSTRUCTION
    : `${BUILDER_SYSTEM_INSTRUCTION}\n\n${REPAIR_SYSTEM_NOTE}`;
  const messages: readonly RenderedMessage[] = [
    { role: "system", content: systemContent },
    // The context block carries repository-derived bodies through the untrusted fence (B3); the
    // whole user turn is marked untrusted so nothing downstream can treat repository text as authority.
    { role: "user", content: renderContextBlocks(pkg, boundary), untrusted: true },
    ...(repair !== undefined ? [renderRepairBrief(repair.repairBrief, repair.boundary)] : []),
    ...conversation,
  ];
  return {
    promptId: contentDigest("prompt", {
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        toolCalls: m.toolCalls?.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
        toolCallId: m.toolCallId,
        untrusted: m.untrusted,
      })),
    }),
    messages,
    characters: messages.reduce((total, m) => total + m.content.length, 0),
  };
}

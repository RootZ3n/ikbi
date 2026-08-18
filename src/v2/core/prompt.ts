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

/** Render one context artifact as a labelled, bounded block. */
function renderArtifact(index: number, artifact: ContextPackage["artifacts"][number]): string {
  const where = artifact.path ?? "(operator task)";
  const header = `--- context[${index}] ${artifact.category} · ${where} · sha256:${artifact.observedSha256.slice(0, 16)}${artifact.truncated ? " · TRUNCATED" : ""} ---`;
  return `${header}\n${artifact.content}`;
}

/**
 * Render the authorized context package as the builder's opening user turn.
 *
 * The package's artifact ORDER is the delivery order — the assembler already applied the
 * priority policy, and this function does not re-rank, re-select, or top up. Omissions
 * are stated rather than hidden, so a model is told what it was NOT given instead of
 * silently reasoning from a partial view.
 */
export function renderContextBlocks(pkg: ContextPackage): string {
  const blocks = pkg.artifacts.map((artifact, index) => renderArtifact(index, artifact));
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
export function renderBuilderInput(pkg: ContextPackage, conversation: readonly RenderedMessage[]): RenderedModelInput {
  const messages: readonly RenderedMessage[] = [
    { role: "system", content: BUILDER_SYSTEM_INSTRUCTION },
    { role: "user", content: renderContextBlocks(pkg) },
    ...conversation,
  ];
  return {
    promptId: contentDigest("prompt", {
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        toolCalls: m.toolCalls?.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
        toolCallId: m.toolCallId,
      })),
    }),
    messages,
    characters: messages.reduce((total, m) => total + m.content.length, 0),
  };
}

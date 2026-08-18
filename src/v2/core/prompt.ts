/**
 * ikbi v2 — THE MODEL-INPUT RENDERER.
 *
 * One function turns (task + `ContextPackage`) into the messages a provider receives.
 * It is the ONLY place repository content becomes model input, and it takes that content
 * exclusively from the package V2-004 authorized: it reads no file, calls no retriever,
 * consults no memory, and has no path by which anything else could be appended.
 *
 * WHAT THIS IS NOT: the builder prompt. This slice performs a TRANSPORT QUALIFICATION —
 * proving that the exact authorized route can be invoked and that what came back can be
 * attributed truthfully. The instruction therefore asks for an acknowledgement and
 * explicitly forbids proposing or performing work. The builder's prompt, its tools and
 * its loop belong to a later slice and must not be smuggled in here.
 */

import { contentDigest, type V2PromptDigest } from "./identity.js";
import type { ContextPackage } from "./context.js";

/** A message as v2 renders it, before the transport's own shape is applied. */
export interface RenderedMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

/** The exact input placed on the wire, plus its identity. */
export interface RenderedModelInput {
  readonly promptId: V2PromptDigest;
  readonly messages: readonly RenderedMessage[];
  /** Characters across all messages — the size actually sent, not an estimate of it. */
  readonly characters: number;
}

/**
 * The qualification instruction. Deliberately narrow: this slice proves a route works,
 * it does not ask a model to do anything.
 */
export const QUALIFICATION_SYSTEM_INSTRUCTION = [
  "You are participating in an ikbi v2 transport qualification.",
  "Read the supplied task and repository context, then reply with ONE short sentence acknowledging what you were given.",
  "Do NOT propose changes. Do NOT write code. Do NOT execute anything. Do NOT ask questions.",
].join("\n");

/** Render one context artifact as a labelled, bounded block. */
function renderArtifact(index: number, artifact: ContextPackage["artifacts"][number]): string {
  const where = artifact.path ?? "(operator task)";
  const header = `--- context[${index}] ${artifact.category} · ${where} · sha256:${artifact.observedSha256.slice(0, 16)}${artifact.truncated ? " · TRUNCATED" : ""} ---`;
  return `${header}\n${artifact.content}`;
}

/**
 * Render the authorized context package into model input.
 *
 * The package's artifact ORDER is the delivery order — the assembler already applied the
 * priority policy, and this function does not re-rank, re-select, or top up. Omissions
 * are stated rather than hidden, so a model is told what it was NOT given instead of
 * silently reasoning from a partial view.
 */
export function renderModelInput(pkg: ContextPackage): RenderedModelInput {
  const blocks = pkg.artifacts.map((artifact, index) => renderArtifact(index, artifact));
  if (pkg.omissions.length > 0) {
    blocks.push(
      `--- context omissions (${pkg.omissions.length}) ---\n` +
        pkg.omissions.map((o) => `${o.category} ${o.path ?? ""}: ${o.reason}`).join("\n"),
    );
  }
  const messages: readonly RenderedMessage[] = [
    { role: "system", content: QUALIFICATION_SYSTEM_INSTRUCTION },
    { role: "user", content: blocks.join("\n\n") },
  ];
  return {
    promptId: contentDigest("prompt", { messages }),
    messages,
    characters: messages.reduce((total, m) => total + m.content.length, 0),
  };
}

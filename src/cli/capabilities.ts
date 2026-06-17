/**
 * ikbi `capabilities` — the tool-inventory report (a pure-info built-in, like `doctor`).
 *
 * Lists the tools the two model+tool loops expose: the worker BUILDER's `TOOLS` and the
 * CHAT session's `CHAT_TOOLS`. It is the operator's quick answer to "what can the agent
 * actually do?" and the check the audit assumed — `ikbi capabilities` shows the builder's
 * 22 tools and confirms chat parity. PURE over its inputs (the live arrays by default), so
 * the formatting is unit-testable without touching the model.
 */

import type { ModelTool } from "../core/provider/contract.js";
import { TOOLS as BUILDER_TOOLS } from "../modules/worker-model/builder.js";
import { CHAT_TOOLS } from "../modules/chat/session.js";

/** Inputs (defaults are the live tool arrays; tests pass their own). */
export interface CapabilitiesInputs {
  readonly builderTools?: readonly ModelTool[];
  readonly chatTools?: readonly ModelTool[];
}

/** The capabilities report: rendered lines + the structured tool-name sets. */
export interface CapabilitiesResult {
  readonly lines: readonly string[];
  readonly builder: readonly string[];
  readonly chat: readonly string[];
  /** Tools the builder has that chat lacks (parity gap; empty when in parity). */
  readonly builderOnly: readonly string[];
  /** Tools chat has that the builder lacks. */
  readonly chatOnly: readonly string[];
}

/** One-line-per-tool listing: `  name — description`. */
function toolLines(tools: readonly ModelTool[]): string[] {
  return tools.map((t) => `  ${t.name} — ${t.description}`);
}

/** Build the capabilities report. Pure over its inputs (live arrays by default). */
export function runCapabilities(inp: CapabilitiesInputs = {}): CapabilitiesResult {
  const builderTools = inp.builderTools ?? BUILDER_TOOLS;
  const chatTools = inp.chatTools ?? CHAT_TOOLS;
  const builder = builderTools.map((t) => t.name);
  const chat = chatTools.map((t) => t.name);
  const chatSet = new Set(chat);
  const builderSet = new Set(builder);
  const builderOnly = builder.filter((n) => !chatSet.has(n));
  const chatOnly = chat.filter((n) => !builderSet.has(n));

  const parity = builderOnly.length === 0 && chatOnly.length === 0;
  const lines = [
    `ikbi capabilities — model+tool inventory`,
    "",
    `Builder tools (${builder.length}) — the worker build pipeline's tool loop:`,
    ...toolLines(builderTools),
    "",
    `Chat tools (${chat.length}) — the /chat session loop:`,
    ...toolLines(chatTools),
    "",
    parity
      ? `Parity: chat exposes the same ${builder.length} tools as the builder. ✓`
      : `Parity: MISMATCH — builder-only: [${builderOnly.join(", ") || "none"}]; chat-only: [${chatOnly.join(", ") || "none"}].`,
  ];

  return { lines, builder, chat, builderOnly, chatOnly };
}

/**
 * ikbi cognition-layer — the ASK bridge.
 *
 * The cognition layer can already DECIDE that a goal is underspecified — it returns
 * `{ decision: "ask", missingInfo: [...] }`. But cognition recommends, it never acts, so until
 * now nothing could actually PUT a clarifying question to the operator. This module is the seam
 * that turns that `ask` intent into a concrete, answerable request:
 *
 *   - `AskUserRequest` / `AskUserFn` — the canonical shape of a clarification and the callback a
 *     surface (the REPL, a headless stdin reader) supplies to answer it.
 *   - `clarificationRequest(decision, goal)` — bridges a cognition `ask` decision into an
 *     `AskUserRequest` (so the same intent the deliberation produced can be voiced to the user).
 *   - `formatAskPrompt(req)` — renders a request as the text shown to the operator.
 *   - `interpretAnswer(req, raw)` — maps a raw reply onto a chosen option when options were given
 *     (accepts the 1-based number or the option text), else returns the trimmed free-text answer.
 *
 * The `ask_user` TOOL (src/modules/agent-tools/ask-user.ts) is the model-initiated counterpart:
 * the model calls it to ask the SAME kind of question cognition's `ask` intent represents, and it
 * is fulfilled through an `AskUserFn`. Keeping the types here keeps tool and deliberation aligned.
 *
 * Pure: no I/O, no model calls. A surface owns the actual prompting.
 */

import type { CognitionDecision } from "./contract.js";

/** A clarifying question to put to the user. Up to 4 options ⇒ multiple-choice; none ⇒ open-ended. */
export interface AskUserRequest {
  /** The question text. */
  readonly question: string;
  /** Optional multiple-choice options (capped at 4 by the tool). Empty/absent ⇒ open-ended. */
  readonly options?: readonly string[];
  /** Optional short label/header for the prompt (e.g. "Auth method"). */
  readonly header?: string;
}

/** A surface-supplied callback that puts an `AskUserRequest` to the user and resolves their reply. */
export type AskUserFn = (req: AskUserRequest) => Promise<string>;

/** Max multiple-choice options (mirrors the tool's contract). */
export const MAX_ASK_OPTIONS = 4;

/**
 * Bridge a cognition `ask` decision into a concrete clarification request. Returns undefined when
 * the decision is not an `ask` (so a caller can `?? proceed`). The `missingInfo` items become the
 * body of the question; the rationale is folded in as context.
 */
export function clarificationRequest(decision: CognitionDecision, goal: string): AskUserRequest | undefined {
  if (decision.decision !== "ask") return undefined;
  const missing = (decision.missingInfo ?? []).filter((m) => m.trim().length > 0);
  const body =
    missing.length > 0
      ? `Before I proceed on "${truncate(goal, 120)}", I need to clarify:\n${missing.map((m) => `  - ${m}`).join("\n")}`
      : `Before I proceed on "${truncate(goal, 120)}", I need more detail. ${decision.rationale}`;
  return { question: body, header: "Clarify" };
}

/** Render an `AskUserRequest` into the text shown to the operator (question + numbered options). */
export function formatAskPrompt(req: AskUserRequest): string {
  const head = req.header !== undefined && req.header.length > 0 ? `[${req.header}] ` : "";
  const lines = [`${head}${req.question}`];
  const opts = (req.options ?? []).slice(0, MAX_ASK_OPTIONS);
  if (opts.length > 0) {
    opts.forEach((o, i) => lines.push(`  ${i + 1}) ${o}`));
    lines.push("Reply with the option number or your own answer: ");
  } else {
    lines.push("Your answer: ");
  }
  return lines.join("\n");
}

/**
 * Interpret a raw reply against a request. With options, a bare 1-based number or an exact (case-
 * insensitive) option text selects that option; anything else is returned as a free-text answer.
 * Returns `{ answer, selectedIndex? }`.
 */
export function interpretAnswer(req: AskUserRequest, raw: string): { answer: string; selectedIndex?: number } {
  const trimmed = raw.trim();
  const opts = (req.options ?? []).slice(0, MAX_ASK_OPTIONS);
  if (opts.length === 0) return { answer: trimmed };
  // Numeric choice (1-based).
  const num = Number(trimmed);
  if (Number.isInteger(num) && num >= 1 && num <= opts.length) {
    return { answer: opts[num - 1] as string, selectedIndex: num - 1 };
  }
  // Exact option text (case-insensitive).
  const lower = trimmed.toLowerCase();
  const idx = opts.findIndex((o) => o.toLowerCase() === lower);
  if (idx >= 0) return { answer: opts[idx] as string, selectedIndex: idx };
  return { answer: trimmed };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

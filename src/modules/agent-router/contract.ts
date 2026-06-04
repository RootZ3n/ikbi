/**
 * ikbi agent-router — THE MODULE CONTRACT (versioned).
 *
 * The engine's GENERIC conversational router / intent / Q&A capability. It is
 * AGENT-AGNOSTIC: it runs under whatever `AgentIdentity` it is given at runtime. A
 * lab agent (e.g. a guide called "agent-a") is a runtime CONFIGURATION of this
 * capability — wired with an identity in the lab layer — NOT baked into the engine.
 * This module is deliberately NOT named after any specific agent.
 *
 * CLASSIFY-AND-ANSWER ONLY — it executes NOTHING. It classifies intent and answers
 * questions over lab memory, but if a classified intent IS an action, it RETURNS the
 * classification (intent + target) for the CALLER to act on; it never dispatches to
 * worker-model / governed-exec / any action module. That is what keeps it genuinely
 * 2-eyes: no execution surface, no gate-wall. Wiring intent→action is a later,
 * deliberately-governed step — not this module.
 *
 * Untrusted-content discipline: USER INPUT is untrusted, and retrieved LAB-MEMORY
 * content (possibly authored by other agents) is untrusted-adjacent — BOTH pass
 * through `neutralizeUntrusted` before entering the model prompt.
 *
 * The teacher/teaching endpoint is DEFERRED (plan: "teacher content deferred") — not
 * implemented here; only this router/intent/Q&A surface.
 *
 * No frozen-core change.
 *
 * CONTRACT_VERSION changelog (newest on top):
 *   1.0.0 — initial agent-router contract: classify (intent) + ask (Q&A over lab
 *           memory), agent-agnostic, answer-only (returns action intents, never
 *           dispatches). Reads lab-context-memory (read-only).
 */

import type { OperationContext } from "../../core/identity/index.js";
import type { MemoryKind } from "../lab-context-memory/index.js";

/** Semantic version of the agent-router contract. Bump on breaking change. */
export const CONTRACT_VERSION = "1.0.0";

/** A classified intent. `target` is the extracted subject (e.g. a project name). */
export interface IntentResult {
  /** The intent label (e.g. "build", "question", "status", "unknown"). */
  readonly intent: string;
  /** The extracted target/subject, if any (e.g. the project/agent the intent concerns). */
  readonly target?: string;
  /** Model-reported confidence in [0,1], if provided. */
  readonly confidence?: number;
  /** Short rationale for the classification. */
  readonly rationale?: string;
}

/** A redacted view of a memory entry cited as a Q&A source — NEVER the raw value. */
export interface MemoryEntrySummary {
  readonly id: string;
  readonly project: string;
  readonly agent: string;
  readonly kind: MemoryKind;
  readonly key: string;
}

/** An answer over lab memory + model, with the (redacted) sources it drew on. */
export interface AnswerResult {
  readonly answer: string;
  readonly sources?: readonly MemoryEntrySummary[];
}

/** Input to `classify` — a single user message to label. */
export interface ClassifyInput {
  readonly parentCtx: OperationContext;
  readonly message: string;
}

/** Input to `ask` — a question, optionally scoped to a project (for the lab-memory lookup). */
export interface AskInput {
  readonly parentCtx: OperationContext;
  readonly question: string;
  readonly project?: string;
}

/** Failure kinds for the router. */
export type AgentRouterErrorKind = "disabled" | "identity";

/** A typed router failure (thrown only on a fail-closed refusal). */
export class AgentRouterError extends Error {
  readonly kind: AgentRouterErrorKind;
  constructor(kind: AgentRouterErrorKind, message: string) {
    super(message);
    this.name = "AgentRouterError";
    this.kind = kind;
  }
}

/** The agent-router surface (classify + answer; executes nothing). */
export interface AgentRouter {
  /** Classify a user message's intent. Returns the intent — does NOT act on it. */
  classify(input: ClassifyInput): Promise<IntentResult>;
  /** Answer a question over lab memory (cross-agent) + the model. */
  ask(input: AskInput): Promise<AnswerResult>;
}

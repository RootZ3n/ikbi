/**
 * ikbi agent-router — its events (namespaced `router.*` per module plan ## 8).
 *
 * Published with `source: "agent-router"` and identity attribution. Payloads carry
 * the intent label / project / source count — NEVER the user message, the answer, or
 * memory entry values verbatim.
 */

import { defineEvent } from "../../core/events/index.js";

/** Payload common to the router lifecycle events (fields populated as known). */
export interface RouterEventPayload {
  /** The classified intent label (never the message text). */
  readonly intent?: string;
  /** The project scope of a Q&A (never the question/answer text). */
  readonly project?: string;
  /** How many memory entries were cited as sources (never their values). */
  readonly sourceCount?: number;
}

/** Emitted when a message is classified. */
export const routerClassified = defineEvent<RouterEventPayload>("router.classified");
/** Emitted when a question is answered. */
export const routerAnswered = defineEvent<RouterEventPayload>("router.answered");

/**
 * ikbi chat — THE MODULE CONTRACT (versioned).
 *
 * A persistent conversational endpoint that runs a bounded model+tool loop using
 * the SAME builder tools (search_files / patch / governed terminal / read / write /
 * list) confined to a per-session worktree. It consumes the frozen provider,
 * injection, and identity contracts; it adds NO frozen-core change.
 *
 * CONTRACT_VERSION changelog (newest on top):
 *   1.2.1 — additive: HTTP sessions explicitly disclose that they are ephemeral/non-resumable.
 *   1.2.0 — additive: cost + context visibility and PLAN MODE. The request gains an OPTIONAL
 *           `mode?: "agent" | "plan"` ("plan" restricts the loop to read-only tools and returns a
 *           structured plan without making changes). The response gains OPTIONAL `cost` (USD for the
 *           turn) and `context_percent` (0-100 window pressure). All backward-compatible.
 *   1.1.0 — additive: multimodal input. The request gains an OPTIONAL `images?: string[]`
 *           (data-URLs or http(s) URLs) so the operator can PASTE images; they attach to
 *           the turn as multimodal parts. Backward-compatible — omitting it is the old
 *           text-only behavior. (Builds on provider contract 1.2.0's ModelMessage.parts.)
 *   1.0.0 — initial chat contract: POST /chat { message, session_id? } ->
 *           { response, session_id, tools? }. Sessions are in-memory and keyed by
 *           session_id; the tool-calling loop is bounded and worktree-confined.
 */

/** Semantic version of the chat module contract. Bump on breaking change. */
export const CONTRACT_VERSION = "1.2.1";

/** Chat mode: `agent` (default — full tool suite) or `plan` (read-only analysis → structured plan). */
export type ChatMode = "agent" | "plan";

/** The POST /chat request body. */
export interface ChatRequest {
  /** The user's message for this turn. */
  readonly message: string;
  /** Continue an existing conversation; omit to start a new one. */
  readonly session_id?: string;
  /**
   * OPTIONAL operator-pasted images for this turn — each a data-URL
   * (`data:image/png;base64,...`) or an http(s) URL. Attached to the turn as multimodal
   * parts so a vision-capable model sees them inline. Omit for a text-only turn.
   */
  readonly images?: readonly string[];
  /**
   * OPTIONAL turn mode. `"plan"` runs the loop with READ-ONLY tools only and asks the model
   * for a structured plan WITHOUT making changes; `"agent"` (default) runs the full tool suite.
   */
  readonly mode?: ChatMode;
}

/** A tool the loop invoked while answering (surfaced for display/audit). */
export interface ChatToolActivity {
  readonly name: string;
  readonly ok: boolean;
  readonly summary?: string;
  /**
   * OPTIONAL unified-diff text of a file mutation this tool made (write_file / patch only,
   * on success). DISPLAY-only — bounded, not fed back to the model. The REPL colorizes it.
   */
  readonly diff?: string;
}

/** The POST /chat response body. */
export interface ChatResponse {
  /** The assistant's reply text. */
  readonly response: string;
  /** The session id (newly minted when the request omitted one). */
  readonly session_id: string;
  /** Tools invoked during this turn, in order, if any. */
  readonly tools?: readonly ChatToolActivity[];
  /** USD cost of every model invocation this turn made (cost visibility). */
  readonly cost?: number;
  /** Context-window pressure for the session after this turn, 0-100 (context visibility). */
  readonly context_percent?: number;
  /** HTTP /chat session persistence disclosure. REPL sessions use the disk store; HTTP sessions do not. */
  readonly session_persistence?: "ephemeral";
  readonly resumable?: false;
  readonly warning?: string;
}

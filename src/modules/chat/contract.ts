/**
 * ikbi chat — THE MODULE CONTRACT (versioned).
 *
 * A persistent conversational endpoint that runs a bounded model+tool loop using
 * the SAME builder tools (search_files / patch / governed terminal / read / write /
 * list) confined to a per-session worktree. It consumes the frozen provider,
 * injection, and identity contracts; it adds NO frozen-core change.
 *
 * CONTRACT_VERSION changelog (newest on top):
 *   1.1.0 — additive: multimodal input. The request gains an OPTIONAL `images?: string[]`
 *           (data-URLs or http(s) URLs) so the operator can PASTE images; they attach to
 *           the turn as multimodal parts. Backward-compatible — omitting it is the old
 *           text-only behavior. (Builds on provider contract 1.2.0's ModelMessage.parts.)
 *   1.0.0 — initial chat contract: POST /chat { message, session_id? } ->
 *           { response, session_id, tools? }. Sessions are in-memory and keyed by
 *           session_id; the tool-calling loop is bounded and worktree-confined.
 */

/** Semantic version of the chat module contract. Bump on breaking change. */
export const CONTRACT_VERSION = "1.1.0";

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
}

/** A tool the loop invoked while answering (surfaced for display/audit). */
export interface ChatToolActivity {
  readonly name: string;
  readonly ok: boolean;
  readonly summary?: string;
}

/** The POST /chat response body. */
export interface ChatResponse {
  /** The assistant's reply text. */
  readonly response: string;
  /** The session id (newly minted when the request omitted one). */
  readonly session_id: string;
  /** Tools invoked during this turn, in order, if any. */
  readonly tools?: readonly ChatToolActivity[];
}

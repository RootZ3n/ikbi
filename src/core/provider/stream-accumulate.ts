/**
 * ikbi provider layer — streaming delta accumulator (consumer-side).
 *
 * A `ModelStream` yields sparse `StreamDelta`s: content slices, piecewise tool-call
 * fragments (keyed by index), a terminal finish reason, and a trailing usage chunk.
 * `StreamAccumulator` folds them back into the SAME shape a non-streaming `invoke`
 * returns — so a streaming consumer can run the identical tool loop afterwards.
 *
 * Pure and dependency-light — tested directly in isolation.
 */

import type { FinishReason, StreamDelta, TokenUsage, ToolCall } from "./contract.js";

/** The fully-assembled result of consuming a stream — mirrors the non-streaming fields. */
export interface AccumulatedResponse {
  readonly content: string;
  /** ADDITIVE (1.4.0): accumulated extended-thinking text, if the stream carried any. */
  readonly reasoning?: string;
  /** ADDITIVE (1.4.0): the reasoning block's opaque signature, for verbatim round-trip. */
  readonly reasoningSignature?: string;
  readonly toolCalls: readonly ToolCall[];
  readonly finishReason: FinishReason;
  readonly usage?: TokenUsage;
}

/** Internal per-index tool-call assembly state. */
interface ToolCallParts {
  id?: string;
  name: string;
  arguments: string;
}

export class StreamAccumulator {
  private content = "";
  private reasoning = "";
  private reasoningSignature: string | undefined;
  private finishReason: FinishReason = "unknown";
  private usage: TokenUsage | undefined;
  /** Tool-call fragments keyed by their streaming `index`, assembled in first-seen order. */
  private readonly parts = new Map<number, ToolCallParts>();
  private readonly order: number[] = [];
  /** Synthetic index counter for mis-indexed distinct calls (B7) — starts high to avoid colliding
   *  with a backend's real 0-based indices. */
  private synthetic = 1_000_000;

  /** Fold one delta into the running state. */
  push(delta: StreamDelta): void {
    if (delta.content !== undefined) this.content += delta.content;
    if (delta.reasoning !== undefined) this.reasoning += delta.reasoning;
    if (delta.reasoningSignature !== undefined) this.reasoningSignature = delta.reasoningSignature;
    if (delta.finishReason !== undefined) this.finishReason = delta.finishReason;
    if (delta.usage !== undefined) this.usage = delta.usage;
    if (delta.toolCalls !== undefined) {
      for (const tc of delta.toolCalls) {
        // B7: a delta carrying an id that DIFFERS from the id already accumulated at this index is a
        // DISTINCT call the backend mis-indexed (e.g. two complete calls sent in separate chunks both
        // WITHOUT an explicit index → both fall back to 0). Route it to a fresh slot instead of merging,
        // which would overwrite the name and concatenate two unrelated argument blobs into one garbled
        // call executed under the wrong name. A normal fragment continuation (same id, or no id) merges.
        let idx = tc.index;
        const existing = this.parts.get(idx);
        if (existing?.id !== undefined && tc.id !== undefined && tc.id !== existing.id) {
          idx = this.synthetic++;
        }
        let acc = this.parts.get(idx);
        if (acc === undefined) {
          acc = { name: "", arguments: "" };
          this.parts.set(idx, acc);
          this.order.push(idx);
        }
        if (tc.id !== undefined) acc.id = tc.id;
        if (tc.name !== undefined) acc.name = tc.name;
        if (tc.arguments !== undefined) acc.arguments += tc.arguments;
      }
    }
  }

  /** The accumulated assistant text so far (for live display). */
  get currentContent(): string {
    return this.content;
  }

  /** Assemble the final response. Tool calls are emitted in first-seen index order. */
  result(): AccumulatedResponse {
    const toolCalls: ToolCall[] = this.order
      .map((idx) => this.parts.get(idx))
      .filter((v): v is ToolCallParts => v !== undefined && v.name.length > 0)
      .map((v, i) => ({ id: v.id ?? `call_${i}`, name: v.name, arguments: v.arguments }));
    // Some providers omit OR MISREPORT finish_reason on the tool-call chunk — "unknown", or even
    // "stop" with tool calls present (older Ollama, some gateways/vLLM). If ANY tool call was emitted
    // the model's intent IS a tool call, so infer "tool_calls" regardless of the raw reason — otherwise
    // the builder/chat loops (which key on finishReason === "tool_calls") silently DROP the action and
    // treat it as a bare stop ("the harness, not the model" failure).
    const finishReason: FinishReason =
      toolCalls.length > 0 && this.finishReason !== "tool_calls" ? "tool_calls" : this.finishReason;
    return {
      content: this.content,
      ...(this.reasoning.length > 0 ? { reasoning: this.reasoning } : {}),
      ...(this.reasoningSignature !== undefined ? { reasoningSignature: this.reasoningSignature } : {}),
      toolCalls,
      finishReason,
      ...(this.usage !== undefined ? { usage: this.usage } : {}),
    };
  }
}

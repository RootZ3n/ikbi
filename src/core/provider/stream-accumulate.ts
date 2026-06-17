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
  private finishReason: FinishReason = "unknown";
  private usage: TokenUsage | undefined;
  /** Tool-call fragments keyed by their streaming `index`, assembled in first-seen order. */
  private readonly parts = new Map<number, ToolCallParts>();
  private readonly order: number[] = [];

  /** Fold one delta into the running state. */
  push(delta: StreamDelta): void {
    if (delta.content !== undefined) this.content += delta.content;
    if (delta.finishReason !== undefined) this.finishReason = delta.finishReason;
    if (delta.usage !== undefined) this.usage = delta.usage;
    if (delta.toolCalls !== undefined) {
      for (const tc of delta.toolCalls) {
        let acc = this.parts.get(tc.index);
        if (acc === undefined) {
          acc = { name: "", arguments: "" };
          this.parts.set(tc.index, acc);
          this.order.push(tc.index);
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
    // Some providers omit finish_reason on the tool-call chunk; infer it when calls were emitted.
    const finishReason: FinishReason =
      this.finishReason === "unknown" && toolCalls.length > 0 ? "tool_calls" : this.finishReason;
    return {
      content: this.content,
      toolCalls,
      finishReason,
      ...(this.usage !== undefined ? { usage: this.usage } : {}),
    };
  }
}

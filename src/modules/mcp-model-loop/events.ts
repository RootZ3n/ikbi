/**
 * ikbi mcp-model-loop — its events (namespaced `mcp.*` per module plan ## 8).
 *
 * Published with `source: "mcp-model-loop"` and identity attribution so every loop
 * and every gated tool call is observable live. Payloads carry the tool NAME +
 * verdict + round + stop reason — NEVER the full tool arguments or results verbatim.
 */

import { defineEvent } from "../../core/events/index.js";

/** Payload common to the loop/tool lifecycle events (fields populated as known). */
export interface McpEventPayload {
  /** The MCP tool name (never its arguments). */
  readonly toolName?: string;
  /** The outbound-gate verdict for a tool call. */
  readonly allow?: boolean;
  /** The tool-call round (1-based). */
  readonly round?: number;
  /** Why the loop stopped (stop / max_iterations / timeout / …). */
  readonly stopReason?: string;
  /** Total tool-call rounds (loop.completed). */
  readonly rounds?: number;
  /** Human/audit reason (deny / failure). */
  readonly reason?: string;
}

/** Emitted when a loop run starts. */
export const mcpLoopStarted = defineEvent<McpEventPayload>("mcp.loop.started");
/** Emitted when the model requests a tool call (before the gate). */
export const mcpToolRequested = defineEvent<McpEventPayload>("mcp.tool.requested");
/** Emitted with the outbound-gate verdict for a tool call (allow/deny). */
export const mcpToolGated = defineEvent<McpEventPayload>("mcp.tool.gated");
/** Emitted when a tool call completed (the transport returned a result). */
export const mcpToolCompleted = defineEvent<McpEventPayload>("mcp.tool.completed");
/** Emitted when a loop run ends. */
export const mcpLoopCompleted = defineEvent<McpEventPayload>("mcp.loop.completed");
/** Emitted when a loop run fails / refuses (fail-closed). */
export const mcpLoopFailed = defineEvent<McpEventPayload>("mcp.loop.failed");

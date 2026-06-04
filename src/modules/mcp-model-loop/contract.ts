/**
 * ikbi mcp-model-loop — THE MODULE CONTRACT (versioned).
 *
 * A STANDALONE model+tool loop driven by MCP-discovered tools (Interpretation A): it
 * runs its OWN invokeModel loop and its OWN tool dispatch — it does NOT import
 * worker-model or its orchestrator. It shares the builder's neutralization CHOKEPOINT
 * pattern, not its code.
 *
 * THREE SECURITY INVARIANTS (the spine):
 *   1. INBOUND NEUTRALIZE (#8): every MCP tool RESULT passes through
 *      `neutralizeUntrusted({ source:"mcp_result", … })` and re-enters the
 *      conversation ONLY via `toUntrustedMessage` (untrusted:true). A single
 *      append-tool-result chokepoint is the ONLY path from a result string to a
 *      message — there is no raw path.
 *   2. OUTBOUND GATE: every MCP tool CALL routes through `gateWall.evaluate` (exec
 *      action) BEFORE the transport is touched. A deny refuses the call (a denial
 *      result is fed back through the inbound chokepoint) and the transport is never
 *      invoked for it.
 *   3. HTTP THROUGH EGRESS: an HTTP-shaped `McpTransport` MUST route its outbound
 *      HTTP through the egress guard (`resolveFetchGuard`/`guardedFetch`) — the
 *      contract does not permit an unguarded network transport. The shipped mock is
 *      in-process (no network); real stdio/HTTP transports are a follow-up.
 *
 * No frozen-core / gate-wall contract change — consumes provider invokeModel +
 * injection neutralize + gate-wall ≥1.1.0 exec action + (for real transports) egress.
 *
 * CONTRACT_VERSION changelog (newest on top):
 *   1.0.0 — initial mcp-model-loop contract: McpTransport seam + McpToolDef, and
 *           McpLoopRequest/McpLoopResult for a standalone governed model+tool loop.
 *           Minimal in-process transport; real stdio/HTTP transport deferred.
 */

import type { OperationContext } from "../../core/identity/index.js";

/** Semantic version of the mcp-model-loop contract. Bump on breaking change. */
export const CONTRACT_VERSION = "1.0.0";

/**
 * The transport seam a real stdio/HTTP MCP client satisfies later. SECURITY CONTRACT:
 * an HTTP-shaped implementation MUST perform its outbound HTTP through the egress
 * guard (`resolveFetchGuard()`/`guardedFetch` from the egress module) so it inherits
 * SSRF protection — an unguarded network transport is not a permitted implementation.
 * The in-process mock shipped this pass makes no network calls.
 */
export interface McpTransport {
  /** Establish the connection / handshake. Called once before the loop. */
  connect(): Promise<void>;
  /** Discover the server's tools (mapped to provider ModelTool[] for the model). */
  listTools(): Promise<readonly McpToolDef[]>;
  /** Invoke a tool by name with its raw JSON argument string; returns a raw result string. */
  callTool(name: string, argsJson: string): Promise<string>;
  /** Tear down the connection. Called once after the loop (even on a mid-loop break). */
  close(): Promise<void>;
}

/** A tool advertised by an MCP server. Maps 1:1 to the provider's ModelTool. */
export interface McpToolDef {
  readonly name: string;
  readonly description: string;
  /** JSON-Schema object describing the tool parameters. */
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** A request to run the MCP model+tool loop toward a goal. */
export interface McpLoopRequest {
  /** The caller's operation context (must carry a ValidatedIdentity). */
  readonly parentCtx: OperationContext;
  /** The goal the loop works toward. */
  readonly goal: string;
  /** Optional model override (logical roster id). */
  readonly model?: string;
}

/**
 * The outcome of a loop run. `completed` is true iff the model stopped cleanly
 * (finishReason "stop"). The counters are the audit of the three invariants:
 * `neutralizedCount` (inbound), `gatedCalls`/`deniedCalls` (outbound gate).
 */
export interface McpLoopResult {
  readonly completed: boolean;
  readonly rounds: number;
  readonly stopReason: string;
  /** How many tool results were neutralized inbound (one per result — the chokepoint). */
  readonly neutralizedCount: number;
  /** How many tool calls were evaluated by gate-wall (every call). */
  readonly gatedCalls: number;
  /** How many tool calls gate-wall denied (subset of gatedCalls; never reached the transport). */
  readonly deniedCalls: number;
  /** The final assistant content, when the loop ended cleanly. */
  readonly content?: string;
  /** Human/audit reason (refusal / failure). */
  readonly reason?: string;
}

/** The mcp-model-loop surface. */
export interface McpModelLoop {
  run(request: McpLoopRequest): Promise<McpLoopResult>;
}

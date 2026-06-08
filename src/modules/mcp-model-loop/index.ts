/**
 * ikbi mcp-model-loop — module entrypoint.
 *
 * Pins the FROZEN-CORE contracts this module builds against (exact targets) so a
 * drift throws a clear ContractVersionError at load. Like gate-wall / governed-exec /
 * subagent-spawning, it registers NO guard / side-effect — it is a pure consumer. The
 * operator wires the loop into an entrypoint (route/CLI) in the later barrel-wiring
 * pass; this file does NOT touch `src/modules/index.ts`.
 *
 * NOTE: `gate-wall` (outbound tool-call gating) and `egress` (the SSRF guard real
 * HTTP transports route through) are MODULE dependencies, not frozen-core contracts
 * in `CONTRACT_VERSIONS`, so they cannot be pinned here — only the frozen deps
 * (provider, injection, events, identity).
 */

import { assertContractCompatible } from "../../core/contracts/index.js";

assertContractCompatible("provider", "1.1.0");
assertContractCompatible("injection", "1.0.0");
assertContractCompatible("events", "1.0.0");
assertContractCompatible("identity", "1.1.0");

// Side-effect import: registers the `ikbi mcp` CLI command (opt-in stdio transport) at
// load time. The modules barrel imports this index, so the command is live once ikbi starts.
import "./cli.js";

export { createMcpModelLoop, createMockTransport, mcpModelLoop, type McpModelLoopDeps, type NeutralizeFn, type ToUntrustedFn } from "./loop.js";
// The `ikbi mcp` CLI command surface (testable factory + arg parsers).
export { createMcpCli, parseMcpArgs, splitServerCommand, type McpCliDeps } from "./cli.js";
// OPT-IN real transport: stdio (spawn a child MCP server, JSON-RPC over stdin/stdout).
// The mock transport remains the default; wire this via createMcpModelLoop({ transport }).
export { createStdioTransport, type StdioTransportOptions, type SpawnLike, type SpawnedChild } from "./transports/stdio.js";
export {
  CONTRACT_VERSION,
  type McpLoopRequest,
  type McpLoopResult,
  type McpModelLoop,
  type McpToolDef,
  type McpTransport,
} from "./contract.js";
export {
  mcpModelLoopConfig,
  loadMcpModelLoopConfig,
  LOOP_MODEL,
  LOOP_TEMPERATURE,
  LOOP_MAX_TOKENS,
  DEFAULT_MAX_TOOL_ITERATIONS,
  DEFAULT_LOOP_TIMEOUT_MS,
  type McpModelLoopConfig,
} from "./config.js";
export {
  mcpLoopStarted,
  mcpToolRequested,
  mcpToolGated,
  mcpToolCompleted,
  mcpLoopCompleted,
  mcpLoopFailed,
  type McpEventPayload,
} from "./events.js";

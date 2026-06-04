/**
 * ikbi mcp-model-loop — its OWN config slice (per-module config seam).
 *
 * Read ONLY through `moduleEnv("mcp-model-loop")` — never `configEnv` directly
 * (module plan ## 8). The reader auto-prefixes `IKBI_MCP_MODEL_LOOP_`.
 *
 *   IKBI_MCP_MODEL_LOOP_ENABLED             on/off. DEFAULT ON. Disabled ⇒ the loop
 *                                           REFUSES (fail-closed — never a bypass).
 *   IKBI_MCP_MODEL_LOOP_MAX_TOOL_ITERATIONS hard cap on tool-call rounds.
 *   IKBI_MCP_MODEL_LOOP_TIMEOUT_MS          loop wall-clock budget.
 *
 * MCP server endpoints are NOT configured here — that belongs to the real transport
 * (a follow-up). This pass ships an in-process mock.
 */

import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("mcp-model-loop");

/** Logical roster model id the loop drives. */
export const LOOP_MODEL = "mimo-v2.5";
/** Sampling temperature for the loop. */
export const LOOP_TEMPERATURE = 0.1;
/** Max completion tokens per round. */
export const LOOP_MAX_TOKENS = 2048;
/** Hard cap on tool-call rounds — the loop can never run forever. */
export const DEFAULT_MAX_TOOL_ITERATIONS = 20;
/** Loop wall-clock budget. */
export const DEFAULT_LOOP_TIMEOUT_MS = 120_000;

export interface McpModelLoopConfig {
  /** When false, the loop refuses fail-closed (NOT a bypass). */
  readonly enabled: boolean;
  /** Hard cap on tool-call rounds. */
  readonly maxToolIterations: number;
  /** Loop wall-clock budget (ms). */
  readonly loopTimeoutMs: number;
}

/** Load the mcp-model-loop config slice from `IKBI_MCP_MODEL_LOOP_*`. */
export function loadMcpModelLoopConfig(reader = env): McpModelLoopConfig {
  return Object.freeze({
    enabled: reader.bool("ENABLED", true),
    maxToolIterations: reader.int("MAX_TOOL_ITERATIONS", DEFAULT_MAX_TOOL_ITERATIONS, { min: 1 }),
    loopTimeoutMs: reader.int("TIMEOUT_MS", DEFAULT_LOOP_TIMEOUT_MS, { min: 1 }),
  });
}

/** The process-wide mcp-model-loop config. */
export const mcpModelLoopConfig: McpModelLoopConfig = loadMcpModelLoopConfig();

/**
 * ikbi agent-router — its OWN config slice (per-module config seam).
 *
 * Read ONLY through `moduleEnv("agent-router")` — never `configEnv` directly (module
 * plan ## 8). The reader auto-prefixes `IKBI_AGENT_ROUTER_`.
 *
 *   IKBI_AGENT_ROUTER_ENABLED            on/off. DEFAULT ON. Disabled ⇒ refuse.
 *   IKBI_AGENT_ROUTER_MAX_MEMORY_ENTRIES cap on memory entries pulled per `ask`
 *                                        (bounds the model context).
 */

import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("agent-router");

/** Logical roster model id the router drives (classifier + answerer). Overridable via IKBI_AGENT_ROUTER_MODEL. */
export const ROUTER_MODEL = env.str("MODEL", "mimo-v2.5");
/** Sampling temperature (low — classification/answering should be steady). */
export const ROUTER_TEMPERATURE = 0.1;
/** Max completion tokens per call. */
export const ROUTER_MAX_TOKENS = 1024;
/** Default cap on memory entries pulled into an `ask` context. */
export const DEFAULT_MAX_MEMORY_ENTRIES = 50;

export interface AgentRouterConfig {
  /** When false, classify/ask refuse fail-closed. */
  readonly enabled: boolean;
  /** Max memory entries pulled into the Q&A model context. */
  readonly maxMemoryEntries: number;
}

/** Load the agent-router config slice from `IKBI_AGENT_ROUTER_*`. */
export function loadAgentRouterConfig(reader = env): AgentRouterConfig {
  return Object.freeze({
    enabled: reader.bool("ENABLED", true),
    maxMemoryEntries: reader.int("MAX_MEMORY_ENTRIES", DEFAULT_MAX_MEMORY_ENTRIES, { min: 1 }),
  });
}

/** The process-wide agent-router config. */
export const agentRouterConfig: AgentRouterConfig = loadAgentRouterConfig();

/**
 * ikbi runtime-truth-shadow - mode resolution.
 *
 * The shadow mode is an operator-facing, cross-cutting FEATURE FLAG (`IKBI_RUNTIME_TRUTH=shadow`)
 * rather than a per-module knob, so it is read here from the frozen process-env snapshot directly
 * (with an injectable env for tests). Default is OFF.
 *
 * Resolution order (first match wins):
 *   1. `IKBI_RUNTIME_TRUTH` env var (off|shadow) - explicit operator override, applies to all agents;
 *   2. per-agent default profile (e.g. Ricky) - shadow-by-default for named agents only;
 *   3. off.
 */

import { configEnv } from "../../core/config.js";
import type { RuntimeTruthMode } from "./contract.js";

/** The env var that turns shadow mode on globally. */
export const RUNTIME_TRUTH_ENV = "IKBI_RUNTIME_TRUTH";

/**
 * Agents that default to shadow mode when the env var is unset. Lowercased agent ids.
 * (Ricky is enabled here; everyone else stays off unless the operator sets the env var.)
 */
export const SHADOW_DEFAULT_AGENTS: ReadonlySet<string> = new Set<string>(["ricky"]);

/** Parse a raw mode string; anything that is not "shadow" is off (fail-closed). */
export function parseRuntimeTruthMode(raw: string | undefined): RuntimeTruthMode {
  return (raw ?? "").trim().toLowerCase() === "shadow" ? "shadow" : "off";
}

/**
 * Resolve the effective mode for an agent. The env var (if set) wins for ALL agents; otherwise a
 * named agent in the default-shadow profile gets `shadow`; otherwise `off`.
 */
export function resolveRuntimeTruthMode(agentId?: string, env: Readonly<NodeJS.ProcessEnv> = configEnv): RuntimeTruthMode {
  const raw = env[RUNTIME_TRUTH_ENV]?.trim();
  if (raw !== undefined && raw.length > 0) return parseRuntimeTruthMode(raw);
  if (agentId !== undefined && SHADOW_DEFAULT_AGENTS.has(agentId.trim().toLowerCase())) return "shadow";
  return "off";
}

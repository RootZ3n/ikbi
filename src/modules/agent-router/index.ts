/**
 * ikbi agent-router — module entrypoint.
 *
 * Pins the FROZEN-CORE contracts this module builds against (exact targets) so a
 * drift throws a clear ContractVersionError at load. It registers NO guard / side-
 * effect and executes NOTHING — a pure read/answer consumer (2-eyes). The operator
 * wires it into an entrypoint (route/CLI) in the later barrel-wiring pass; this file
 * does NOT touch `src/modules/index.ts`.
 *
 * NO gate-wall: this module executes nothing — there is no action surface to govern.
 *
 * NOTE: `lab-context-memory` is a MODULE dependency (READ-ONLY — the router queries
 * it for Q&A and never writes it), not a frozen-core contract in `CONTRACT_VERSIONS`,
 * so it is not pinned here. The plan's original dep row omitted it; recorded as an
 * additive read-only dependency (the docs row is updated alongside).
 */

import { assertContractCompatible } from "../../core/contracts/index.js";

assertContractCompatible("provider", "1.1.0");
assertContractCompatible("injection", "1.0.0");
assertContractCompatible("identity", "1.1.0");
assertContractCompatible("events", "1.0.0");

// Side-effect import: registers the `classify` / `ask` CLI commands at load time
// (the modules barrel imports this module, so the commands are live once ikbi starts).
import "./cli.js";

export { createAgentRouter, agentRouter, type AgentRouterDeps, type LabMemoryReader, type NeutralizeFn, type ToUntrustedFn } from "./router.js";
export { createRouterCli, parseProject, type RouterCliDeps } from "./cli.js";
export {
  CONTRACT_VERSION,
  AgentRouterError,
  type AgentRouter,
  type AgentRouterErrorKind,
  type AnswerResult,
  type AskInput,
  type ClassifyInput,
  type IntentResult,
  type MemoryEntrySummary,
} from "./contract.js";
export {
  agentRouterConfig,
  loadAgentRouterConfig,
  ROUTER_MODEL,
  ROUTER_TEMPERATURE,
  ROUTER_MAX_TOKENS,
  DEFAULT_MAX_MEMORY_ENTRIES,
  type AgentRouterConfig,
} from "./config.js";
export {
  routerClassified,
  routerAnswered,
  type RouterEventPayload,
} from "./events.js";

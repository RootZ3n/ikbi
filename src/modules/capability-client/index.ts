/**
 * ikbi capability-client — module entrypoint.
 *
 * Pins the FROZEN-CORE contracts this module builds against (events — for the
 * `capability.*` lifecycle events). It registers NO guard, NO CLI command, and NO
 * HTTP route, and performs NO active work at import (the singleton's first fetch is
 * lazy, on first access). A pure read-only consumer of an external HTTP service.
 *
 * NO gate-wall: this module executes nothing in the engine — it only GETs scores.
 */

import { assertContractCompatible } from "../../core/contracts/index.js";

assertContractCompatible("events", "1.0.0");

export {
  createCapabilityClient,
  capabilityClient,
  type CapabilityClientDeps,
  type FetchLike,
} from "./client.js";
export {
  CONTRACT_VERSION,
  type CapabilityClient,
  type CapabilitySelector,
  type CapabilityScore,
} from "./contract.js";
export {
  capabilityClientConfig,
  loadCapabilityClientConfig,
  DEFAULT_LEDGER_URL,
  DEFAULT_TTL_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_MIN_SAMPLES,
  type CapabilityClientConfig,
} from "./config.js";
export {
  capabilityFetched,
  capabilityUnavailable,
  type CapabilityEventPayload,
} from "./events.js";

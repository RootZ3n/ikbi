/**
 * ikbi network-egress floor — module entrypoint (the SSRF security floor).
 *
 * Loading this module registers its `guardedFetch` as the process-wide provider
 * fetch guard (the fail-closed seam): after this, every provider's outbound HTTP
 * is subjected to scheme + allowlist + internal-IP checks. It must load BEFORE any
 * provider constructs against the live network — providers fail closed otherwise.
 *
 * WIRING NOTE (module plan ## 8 — barrel is a post-merge operator pass): this file
 * self-registers on import, but nothing imports it yet. The operator activates the
 * floor by adding `import "./egress/index.js";` to `src/modules/index.ts` in the
 * single post-merge wiring pass — this module does NOT edit the barrel.
 */

import { assertContractCompatible } from "../../core/contracts/index.js";
import { registerFetchGuard } from "../../core/provider/fetch-guard.js";
import { guardedFetch } from "./guard.js";

// Pin the frozen-core provider contract this floor builds against (the fetch-guard
// seam shipped in provider 1.1.0). A drift throws a clear ContractVersionError.
assertContractCompatible("provider", "1.1.0");

/** Register the egress guard as the process-wide provider fetch guard. Idempotent. */
export function register(): void {
  registerFetchGuard(guardedFetch);
}

// Self-register on import so simply loading the module activates the floor.
register();

export { guardedFetch, createGuardedFetch, type GuardedFetchDeps } from "./guard.js";
export { classifyIp, type IpVerdict } from "./ip.js";
export { egressBlocked, type EgressBlockedPayload, type EgressBlockReason } from "./events.js";
export { egressConfig, loadEgressConfig, type EgressConfig } from "./config.js";

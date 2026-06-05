/**
 * ikbi capability-recovery — its events (namespaced `recovery.*` per module plan ## 8).
 *
 * Published with `source: "capability-recovery"` and identity attribution. Payloads
 * carry the capability id / status / cause class / recommended module — NEVER the
 * evidence verbatim, memory/receipt contents, or secrets.
 */

import { defineEvent } from "../../core/events/index.js";
import type { CapabilityStatus, CauseClass, RepairModule } from "./contract.js";

/** Emitted once per assessment with the plan's shape (no content). */
export const recoveryAssessed = defineEvent<{
  agentId: string;
  capability: string;
  status: CapabilityStatus;
  likelyCause: CauseClass;
  recommendedModule: RepairModule | null;
}>("recovery.assessed");

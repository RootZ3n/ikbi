/**
 * ikbi lab-context-memory — its events (namespaced `labmem.*` per module plan ## 8).
 *
 * Published with `source: "lab-context-memory"` and identity attribution. Payloads
 * carry the project / agent / kind / count — NEVER the entry VALUES (which can be
 * large or carry agent-authored content).
 */

import { defineEvent } from "../../core/events/index.js";
import type { MemoryKind } from "./contract.js";

/** Payload common to the lab-memory lifecycle events (fields populated as known). */
export interface LabMemEventPayload {
  /** The lab project the operation concerns. */
  readonly project?: string;
  /** The agent attributed / queried. */
  readonly agent?: string;
  /** The memory kind. */
  readonly kind?: MemoryKind;
  /** A count (entries projected / entries matched) — never the entry values. */
  readonly count?: number;
}

/** Emitted when a single entry is recorded/updated. */
export const labmemRecorded = defineEvent<LabMemEventPayload>("labmem.recorded");
/** Emitted when a projection run completes (with the count projected). */
export const labmemProjected = defineEvent<LabMemEventPayload>("labmem.projected");
/** Emitted when a query runs (with the match count). */
export const labmemQueried = defineEvent<LabMemEventPayload>("labmem.queried");

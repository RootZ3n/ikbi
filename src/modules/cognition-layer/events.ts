/**
 * ikbi cognition-layer — its events (namespaced `cognition.*` per module plan ## 8).
 *
 * Published with `source: "cognition-layer"` and identity attribution. Payloads carry
 * the decision label / confidence / recommended module / agent / project — NEVER the
 * goal text, the rationale verbatim, or memory contents.
 */

import { defineEvent } from "../../core/events/index.js";
import type { Decision, RecommendableModule } from "./contract.js";

/** Emitted once per deliberation with the structured verdict's shape (no content). */
export const cognitionDecided = defineEvent<{
  agentId: string;
  project?: string;
  decision: Decision;
  confidence: number;
  recommendedModule: RecommendableModule | null;
}>("cognition.decided");

/**
 * ikbi memory-governor — PRODUCTION FACTORY.
 *
 * Creates a memory governor wired with real apply functions for production use.
 * Both the orchestrator (builder path) and the chat CLI (REPL path) use this
 * to construct a governor that actually writes to files and brain pages on approval.
 *
 * Usage:
 *   import { createProductionGovernor } from "../memory-governor/create.js";
 *   const governor = createProductionGovernor({ gbrainBridge });
 *   // pass to builder deps or chat session deps
 */

import { createMemoryGovernor } from "./store.js";
import { createCombinedApply } from "./apply.js";
import type { MemoryGovernor } from "./contract.js";
import type { GbrainBridge } from "../../core/gbrain-bridge.js";
import type { DocumentStore } from "../../core/substrate/store.js";
import type { MemoryProposal } from "./contract.js";

export interface ProductionGovernorDeps {
  /** The gbrain bridge for brain page approval. Absent ⇒ brain proposals skip on approve. */
  readonly gbrainBridge?: GbrainBridge;
  /** Override the proposal document store (tests). Absent ⇒ default store under state root. */
  readonly store?: DocumentStore<MemoryProposal>;
  /** Override the logger (tests). */
  readonly logger?: import("pino").Logger;
}

/**
 * Create a memory governor wired with production apply functions.
 *
 * The governor stores proposals under the state root (`~/.ikbi/state/memory-governor/`).
 * When a proposal is approved:
 *   - File surfaces (CLAUDE.md, .ikbi/*, etc.) → content written to the absolute target path
 *   - Brain surfaces → gbrainBridge.putPage(slug, content)
 *
 * If no gbrain bridge is available, brain proposals are skipped on approval (the proposal
 * is marked "approved" in the store but the page is not written — an operator can re-apply).
 */
export function createProductionGovernor(deps: ProductionGovernorDeps = {}): MemoryGovernor {
  const apply = createCombinedApply(deps.gbrainBridge);
  return createMemoryGovernor({
    apply,
    ...(deps.store !== undefined ? { store: deps.store } : {}),
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
  });
}

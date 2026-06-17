/**
 * ikbi memory-governor — INDEX (factory + re-exports).
 *
 * The memory governor intercepts writes to durable memory surfaces and converts
 * them into proposals that require operator approval.
 */

export {
  CONTRACT_VERSION,
  type MemorySurface,
  type ProposalStatus,
  type MemoryProposal,
  type ProposalInput,
  type MemoryGovernor,
  MemoryGovernorError,
  GOVERNED_FILE_PATHS,
} from "./contract.js";

export { isGovernedPath, isGovernedBrainSlug, brainSurface, makeProposalId } from "./guard.js";

export { createMemoryGovernor, type MemoryGovernorDeps } from "./store.js";

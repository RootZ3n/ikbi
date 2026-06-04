/**
 * ikbi workspace primitive — public surface (frozen core).
 *
 * The single canonical disposable-workspace mechanism. Competitive build,
 * trust-probation (sandboxed), subagent spawning, and the deferred concurrency
 * feature all build on THIS — they are NOT built here.
 *
 *     const ws = await workspaces.allocate({ targetRepo, identity });
 *     // ... agent edits files in ws.path ...
 *     await workspaces.commit(ws, "work");
 *     const diff = await workspaces.diff(ws);                 // judge seam input
 *     const r = await workspaces.promote(ws, { evaluation: { approved: true } }); // governed + atomic
 *     await workspaces.discard(ws);                           // complete teardown
 *
 * Seams (documented for later modules): the EVALUATION/judge seam (caller runs
 * the async judge over `diff()`/the worktree, passes a `WorkspaceEvaluation` to
 * `promote`) and the PROMOTE-GOVERNANCE seam (`PromoteGovernance` veto). Promote
 * is atomic at the ref level (off-worktree merge + CAS update-ref); conflicts are
 * NOT auto-resolved (returned for governed resolution). See `contract.ts`.
 */

import { join } from "node:path";

import { config } from "../config.js";
import { events } from "../events/index.js";
import { childLogger } from "../log.js";
import { receipts } from "../receipt/index.js";
import { createDocumentStore, locks } from "../substrate/index.js";
import type { WorkspaceRecord } from "./contract.js";
import { WorkspaceManager } from "./manager.js";

const log = childLogger("workspace");

/** The process-wide workspace manager. */
export const workspaces: WorkspaceManager = new WorkspaceManager({
  root: config.workspace.root,
  max: config.workspace.max,
  locks,
  store: createDocumentStore<WorkspaceRecord>({ dir: join(config.workspace.root, "registry") }),
  logger: log,
  events,
  receipts,
});

// --- re-export the frozen contract + building blocks ---
export { WorkspaceManager, WorkspaceEvents } from "./manager.js";
export type { WorkspaceManagerDeps, WorkspaceReceiptSink } from "./manager.js";
export {
  WORKSPACE_CONTRACT_VERSION,
  SCRATCH_BRANCH_PREFIX,
  WORKSPACE_ID_PATTERN,
  isValidWorkspaceId,
  WorkspaceError,
  type AllocateOptions,
  type DiscardResult,
  type PromoteApproval,
  type PromoteGovernance,
  type PromoteResult,
  type PromoteStrategy,
  type ReclaimResult,
  type WorkspaceEvaluation,
  type WorkspaceHandle,
  type WorkspaceRecord,
  type WorkspaceState,
} from "./contract.js";

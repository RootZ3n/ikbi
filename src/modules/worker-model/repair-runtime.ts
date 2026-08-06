/** Shared repair-session construction for fixer, patchsmith, consult, and replay paths. */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

import type { AgentIdentity } from "../../core/provider/contract.js";
import type { RoleContext } from "./contract.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import {
  createWorkspaceMutationSession,
  isValidWorkspaceId,
  type MutationSessionBinding,
  type WorkspaceMutationSession,
} from "../../core/workspace/index.js";

function stableRootId(root: string): string {
  return createHash("sha256").update(root, "utf8").digest("hex").slice(0, 20);
}

/**
 * Construct an explicit binding for standalone repair callers (CLI fix and
 * isolated unit seams). It is a repair workspace/candidate envelope, not a
 * substitution of taskId for candidate identity.
 */
export function standaloneRepairBinding(workspace: WorkspaceHandle, role: string, attempt = "1"): MutationSessionBinding {
  const root = stableRootId(realpathSync(workspace.path));
  return {
    sessionId: `repair:${root}:${role}:${attempt}`,
    workspaceId: workspace.id,
    candidateId: `repair-candidate-${root}`,
    generationId: `repair-generation-${root}-${attempt}`,
    actor: "model",
    cause: "model",
    attemptId: `repair-attempt-${attempt}`,
    role,
  };
}

/** Build an explicit allocated workspace envelope for standalone repair APIs. */
export function standaloneRepairWorkspace(root: string, identity: AgentIdentity): WorkspaceHandle {
  const real = realpathSync(root);
  const id = `repairws-${stableRootId(real).slice(0, 12)}`;
  return {
    id,
    targetRepo: real,
    baseBranch: "repair",
    baseRef: "repair-source",
    scratchBranch: `ikbi/ws/${id}`,
    path: real,
    identity,
    state: "allocated",
    createdAt: Date.now(),
  };
}

/** Create a session for one repair role; all callers use this same helper. */
export async function createRepairSession(
  workspace: WorkspaceHandle,
  role: string,
  binding: MutationSessionBinding | undefined,
  attempt = "1",
): Promise<WorkspaceMutationSession> {
  const effectiveWorkspace = binding === undefined && !isValidWorkspaceId(workspace.id)
    ? {
        ...workspace,
        id: `repairws-${stableRootId(realpathSync(workspace.path)).slice(0, 12)}`,
        scratchBranch: `ikbi/ws/repairws-${stableRootId(realpathSync(workspace.path)).slice(0, 12)}`,
      }
    : workspace;
  const base = binding ?? standaloneRepairBinding(effectiveWorkspace, role, attempt);
  const effective = attempt === "1"
    ? base
    : base.fork !== undefined
      ? base.fork({ attemptId: `${base.attemptId ?? "repair"}:${attempt}`, role, suffix: `repair:${attempt}` })
      : {
          ...base,
          sessionId: `${base.sessionId}:repair:${attempt}`,
          generationId: `${base.generationId}:repair:${attempt}`,
          attemptId: `${base.attemptId ?? "repair"}:${attempt}`,
          role,
        };
  return createWorkspaceMutationSession(effectiveWorkspace, effective);
}

export async function createRoleRepairSession(ctx: RoleContext, role: string, attempt = "1"): Promise<WorkspaceMutationSession> {
  return createRepairSession(ctx.workspace, role, ctx.mutationBinding, attempt);
}

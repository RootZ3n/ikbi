/**
 * ikbi worker-model — applyConsultPatch: the APPLIED frontier-consult build step.
 *
 * The recovery loop's frontier executor. When the worker+mid pool is exhausted AND frontier is
 * authorized, this runs a CONSULT in patch mode — ONE bounded, tool-free frontier call over an
 * evidence-dense packet — and applies the returned unified diff in the managed worktree using
 * the SAME confine + parse + apply primitives patchsmith uses. The frontier model never scans
 * the repo and never enters a tool loop; it returns a diff, ikbi applies it.
 *
 * It does NOT verify — the caller (orchestrator) runs the verification ladder on the worktree
 * afterward, exactly as for any build. The diff is worktree-local and promotion stays gated, so
 * a bad frontier patch fails closed at the ladder like any other.
 *
 * Lives in worker-model (not consult) by design: consult is the lower-level packet/call layer;
 * the APPLY step belongs with the build machinery that owns the worktree + diff primitives.
 */

import { runConsult as defaultRunConsult } from "../consult/index.js";
import type { ConsultRequest, ConsultResult } from "../consult/index.js";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { confinePath } from "./builder-tools/confine.js";
import { applyFilePatch, extractDiff, parseUnifiedDiff } from "./patchsmith.js";
import {
  applyRepairPlan,
  createRepairPlan,
  repairFailure,
  type RepairMutationFailure,
} from "../../core/workspace/repair-plan.js";
import type { MutationSessionBinding, WorkspaceHandle } from "../../core/workspace/index.js";
import { createRepairSession, standaloneRepairWorkspace } from "./repair-runtime.js";

export type ApplyConsultStop = "no_diff" | "need_context" | "malformed_patch" | "path_violation" | "patch_did_not_apply" | "stale_repair" | "repair_generation_revoked" | "repair_plan_invalid";

export interface ApplyConsultPatchInput {
  /** The managed worktree the diff is applied into. */
  readonly workspacePath: string;
  /** The allocated managed workspace, when called from the worker orchestrator. */
  readonly workspace?: WorkspaceHandle;
  /** Source-generation binding for the consult repair plan. */
  readonly mutationBinding?: MutationSessionBinding;
  readonly producingAttemptId?: string;
  readonly producingRole?: string;
  readonly producingInvocationId?: string;
  /** Consult request fields (mode + repoRoot are set internally to "patch" + the worktree). */
  readonly request: Omit<ConsultRequest, "mode" | "repoRoot">;
}

export interface ApplyConsultPatchResult {
  /** True when the frontier diff parsed and applied cleanly into the worktree. */
  readonly applied: boolean;
  /** Stable mutation outcome flags; failed consults are never reported as writes. */
  readonly mutationApplied?: boolean;
  readonly partialMutation?: boolean;
  readonly filesChanged: readonly string[];
  readonly modelId?: string;
  readonly stopReason?: ApplyConsultStop;
  readonly error?: string;
  readonly repairError?: RepairMutationFailure;
  readonly planId?: string;
  readonly workspaceId?: string;
  readonly candidateId?: string;
  readonly generationId?: string;
  readonly attemptId?: string;
  readonly role?: string;
  /** The underlying consult result (model, usage, cost, packet, answer). */
  readonly consult?: ConsultResult;
}

export interface ApplyConsultPatchDeps {
  readonly runConsult?: (req: ConsultRequest) => Promise<ConsultResult>;
}

/**
 * Retain a complete raw-byte source for the consult call before the frontier
 * model reasons. Directory enumeration is only discovery; each regular file
 * becomes mutation authority only after its own exact observation succeeds.
 * The snapshot is deliberately bounded to the managed workspace and does not
 * follow symlinked directories.
 */
async function observeCandidateSource(
  workspaceRoot: string,
  mutationSession: Awaited<ReturnType<typeof createRepairSession>>,
): Promise<ReadonlyMap<string, Readonly<Uint8Array>>> {
  const snapshot = new Map<string, Readonly<Uint8Array>>();
  const ignoredDirectories = new Set([".git", "node_modules"]);

  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      const observed = await mutationSession.observeBytes(relativePath);
      if (observed.bytes !== null && (observed.observation.kind === "empty" || observed.observation.kind === "regular")) {
        snapshot.set(relativePath.split(path.sep).join("/"), Buffer.from(observed.bytes));
      }
    }
  };

  await walk(workspaceRoot, "");
  return snapshot;
}

export async function applyConsultPatch(
  input: ApplyConsultPatchInput,
  deps: ApplyConsultPatchDeps = {},
): Promise<ApplyConsultPatchResult> {
  const runConsult = deps.runConsult ?? defaultRunConsult;
  if (input.workspace !== undefined && input.mutationBinding === undefined) {
    return {
      applied: false,
      filesChanged: [],
      stopReason: "repair_generation_revoked",
      error: "candidate generation binding is unavailable",
      workspaceId: input.workspace.id,
      mutationApplied: false,
      partialMutation: false,
    };
  }
  const workspace = input.workspace ?? standaloneRepairWorkspace(input.workspacePath, input.request.identity);
  const mutationSession = await createRepairSession(workspace, input.producingRole ?? "consult", input.mutationBinding);
  const worktreeReal = workspace.path;

  let sourceSnapshot: ReadonlyMap<string, Readonly<Uint8Array>>;
  try {
    sourceSnapshot = await observeCandidateSource(worktreeReal, mutationSession);
  } catch (error) {
    return {
      applied: false,
      filesChanged: [],
      stopReason: "repair_plan_invalid",
      error: error instanceof Error ? error.message : String(error),
      workspaceId: mutationSession.binding.workspaceId,
      candidateId: mutationSession.binding.candidateId,
      generationId: mutationSession.binding.generationId,
      mutationApplied: false,
      partialMutation: false,
    };
  }

  const result = await runConsult({ ...input.request, repoRoot: worktreeReal, mode: "patch", sourceSnapshot });
  const base = {
    modelId: result.modelId,
    consult: result,
    workspaceId: mutationSession.binding.workspaceId,
    candidateId: mutationSession.binding.candidateId,
    generationId: mutationSession.binding.generationId,
    ...(mutationSession.binding.attemptId === undefined ? {} : { attemptId: mutationSession.binding.attemptId }),
    ...(mutationSession.binding.role === undefined ? {} : { role: mutationSession.binding.role }),
    mutationApplied: false,
    partialMutation: false,
  } as const;

  const extracted = extractDiff(result.answer);
  if (extracted.kind === "need_context") {
    return { applied: false, filesChanged: [], stopReason: "need_context", error: `frontier needs context: ${extracted.files.join(", ")}`, ...base };
  }
  if (extracted.kind === "malformed") {
    return { applied: false, filesChanged: [], stopReason: "no_diff", error: extracted.reason, ...base };
  }

  const parsed = parseUnifiedDiff(extracted.text);
  if (!parsed.ok) {
    return { applied: false, filesChanged: [], stopReason: "malformed_patch", error: parsed.error, ...base };
  }

  // Confine EVERY touched path and retain an exact raw observation before
  // computing any result. No direct read or write is permitted here.
  const plans: Array<{ deleted: boolean; rel: string; patch: (typeof parsed.files)[number] }> = [];
  for (const fp of parsed.files) {
    const c = confinePath(worktreeReal, fp.path);
    if (!c.ok) {
      return { applied: false, filesChanged: [], stopReason: "path_violation", error: c.error, ...base };
    }
    try {
      if (!mutationSession.hasObservation(c.rel)) {
        // A new path may be created only through an explicit missing-state
        // observation after the model proposes it. Existing-file replacement
        // and deletion must have been in the pre-consult source snapshot.
        if (!fp.created) {
          return { applied: false, filesChanged: [], stopReason: "repair_plan_invalid", error: `existing consult target ${c.rel} was not in the exact source snapshot`, ...base };
        }
        await mutationSession.observeBytes(c.rel);
      }
    } catch (error) {
      return { applied: false, filesChanged: [], stopReason: "repair_plan_invalid", error: error instanceof Error ? error.message : String(error), ...base };
    }
    plans.push({ deleted: fp.deleted, rel: c.rel, patch: fp });
  }

  // Compute complete after-bytes from the retained observations. The repair
  // plan is then applied transactionally by the Phase 1 core.
  const planned: Array<{ path: string; operation: "create" | "replace" | "delete"; afterBytes: Uint8Array | null }> = [];
  for (const p of plans) {
    if (p.deleted) {
      planned.push({ path: p.rel, operation: "delete", afterBytes: null });
      continue;
    }
    const observed = mutationSession.currentObservation(p.rel);
    if (observed === undefined) return { applied: false, filesChanged: [], stopReason: "repair_plan_invalid", error: `no exact observation retained for ${p.rel}`, ...base };
    let original = "";
    if (observed.bytes !== null) {
      try { original = new TextDecoder("utf-8", { fatal: true }).decode(observed.bytes); }
      catch { return { applied: false, filesChanged: [], stopReason: "patch_did_not_apply", error: `consult patch cannot rewrite binary content at ${p.rel}`, ...base }; }
    }
    const applied = applyFilePatch(original, p.patch);
    if (!applied.ok) {
      return { applied: false, filesChanged: [], stopReason: "patch_did_not_apply", error: applied.error, ...base };
    }
    planned.push({ path: p.rel, operation: p.patch.created ? "create" : "replace", afterBytes: Buffer.from(applied.content, "utf8") });
  }

  try {
    const plan = createRepairPlan({
      session: mutationSession,
      producingAttemptId: input.producingAttemptId ?? mutationSession.binding.attemptId ?? "consult-attempt",
      producingRole: input.producingRole ?? "consult",
      ...((input.producingInvocationId ?? mutationSession.binding.invocationId) === undefined ? {} : { producingInvocationId: input.producingInvocationId ?? mutationSession.binding.invocationId }),
      files: planned,
      rationale: "consult unified diff computed from complete observed candidate bytes",
    });
    const appliedPlan = await applyRepairPlan(mutationSession, plan);
    return { ...base, applied: true, mutationApplied: true, partialMutation: false, filesChanged: appliedPlan.mutations.map((m) => m.mutation.path), planId: plan.planId };
  } catch (error) {
    const failure = repairFailure(error, { session: mutationSession, paths: planned.map((p) => p.path) });
    const stopReason: ApplyConsultStop = failure.code === "STALE_REPAIR" ? "stale_repair" : failure.code === "REPAIR_GENERATION_REVOKED" ? "repair_generation_revoked" : "repair_plan_invalid";
    return { applied: false, filesChanged: [], stopReason, error: failure.message, repairError: failure, ...base };
  }
}

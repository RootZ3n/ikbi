/**
 * Immutable, state-bound repair plans.
 *
 * A repair plan is more than a diff: every file carries the exact observation
 * that supplied its before-bytes and the complete after-bytes computed from
 * those bytes. Applying a plan never rereads a file to manufacture a result;
 * it only revalidates the retained observation through WorkspaceMutation.
 */

import { randomUUID } from "node:crypto";

import type { FileState } from "./file-state.js";
import { sameFileState, sha256Bytes } from "./file-state.js";
import { MutationError, STALE_MUTATION } from "./mutation.js";
import type { BoundMutationResult, MutationSessionLike, SessionByteMutation } from "./mutation-session.js";

export type RepairOperationKind = "create" | "replace" | "delete";

export type RepairErrorCode =
  | "STALE_REPAIR"
  | "RELOCATION_REQUIRED"
  | "REPAIR_GENERATION_REVOKED"
  | "REPAIR_PLAN_INVALID"
  | "REPAIR_RESTORE_STALE"
  | "TOURNAMENT_BASE_DIVERGED"
  | "REPAIR_PARTIAL_APPLY_PREVENTED";

export interface RepairPlanFile {
  readonly path: string;
  readonly operation: RepairOperationKind;
  /** The opaque session token and core observation id are both retained. */
  readonly observationToken: string;
  readonly observationId: string;
  readonly before: FileState;
  readonly beforeBytes: Readonly<Uint8Array> | null;
  readonly afterBytes: Readonly<Uint8Array> | null;
}

/** A complete repair proposal, never a diff-only authorization. */
export interface RepairPlan {
  readonly planId: string;
  readonly operationId: string;
  readonly sourceWorkspaceId: string;
  readonly sourceCandidateId: string;
  readonly sourceGenerationId: string;
  readonly producingAttemptId: string;
  readonly producingRole: string;
  readonly producingInvocationId?: string;
  readonly files: readonly RepairPlanFile[];
  readonly rationale?: string;
}

export interface RepairMutationFailure {
  readonly code: RepairErrorCode;
  readonly planId?: string;
  readonly operationId?: string;
  readonly workspaceId?: string;
  readonly candidateId?: string;
  readonly sourceWorkspaceId?: string;
  readonly sourceCandidateId?: string;
  readonly sourceGenerationId?: string;
  readonly targetGenerationId?: string;
  readonly attemptId?: string;
  readonly role?: string;
  readonly invocationId?: string;
  readonly paths: readonly string[];
  readonly mutationApplied: false;
  readonly partialMutation: false;
  readonly retryable: boolean;
  readonly recommendedRecovery: string;
  readonly message: string;
}

export class RepairMutationError extends Error {
  readonly code: RepairErrorCode;
  readonly planId?: string;
  readonly operationId?: string;
  readonly path?: string;
  readonly partialMutation = false;

  constructor(
    code: RepairErrorCode,
    message: string,
    opts: { planId?: string; operationId?: string; path?: string } = {},
  ) {
    super(message);
    this.name = "RepairMutationError";
    this.code = code;
    if (opts.planId !== undefined) this.planId = opts.planId;
    if (opts.operationId !== undefined) this.operationId = opts.operationId;
    if (opts.path !== undefined) this.path = opts.path;
  }
}

export interface AppliedRepairPlan {
  readonly plan: RepairPlan;
  readonly mutations: readonly BoundMutationResult[];
  readonly mutationApplied: true;
  readonly partialMutation: false;
}

export interface ImportedRepairPlan extends AppliedRepairPlan {
  readonly sourceGenerationId: string;
  readonly targetGenerationId: string;
}

function cloneBytes(bytes: Readonly<Uint8Array> | null): Readonly<Uint8Array> | null {
  return bytes === null ? null : new Uint8Array(bytes);
}

function stateOnly(state: FileState): FileState {
  return Object.freeze({
    kind: state.kind,
    byteLength: state.byteLength,
    sha256: state.sha256,
    symlinkTarget: state.symlinkTarget,
    mode: state.mode,
  });
}

function freezeFile(file: RepairPlanFile): RepairPlanFile {
  return Object.freeze({
    ...file,
    before: stateOnly(file.before),
    beforeBytes: cloneBytes(file.beforeBytes),
    afterBytes: cloneBytes(file.afterBytes),
  });
}

function freezePlan(plan: RepairPlan): RepairPlan {
  return Object.freeze({
    ...plan,
    files: Object.freeze(plan.files.map(freezeFile)),
  });
}

function planInvalid(message: string, plan?: RepairPlan, path?: string): RepairMutationError {
  return new RepairMutationError("REPAIR_PLAN_INVALID", message, {
    ...(plan === undefined ? {} : { planId: plan.planId, operationId: plan.operationId }),
    ...(path === undefined ? {} : { path }),
  });
}

function bindingMatches(session: MutationSessionLike, plan: RepairPlan): boolean {
  const b = session.binding;
  return b.workspaceId === plan.sourceWorkspaceId && b.candidateId === plan.sourceCandidateId && b.generationId === plan.sourceGenerationId;
}

/** Build a plan from the latest exact observations retained by one session. */
export function createRepairPlan(input: {
  readonly session: MutationSessionLike;
  readonly planId?: string;
  readonly operationId?: string;
  readonly producingAttemptId: string;
  readonly producingRole: string;
  readonly producingInvocationId?: string;
  readonly files: readonly {
    readonly path: string;
    readonly operation: RepairOperationKind;
    readonly afterBytes: Readonly<Uint8Array> | null;
  }[];
  readonly rationale?: string;
}): RepairPlan {
  if (input.files.length === 0) throw planInvalid("repair plan must contain at least one file");
  const b = input.session.binding;
  const files: RepairPlanFile[] = [];

  for (const requested of input.files) {
    const observed = input.session.currentObservation(requested.path);
    if (observed === undefined) throw planInvalid(`no retained observation for ${requested.path}`, undefined, requested.path);
    const state = stateOnly(observed.observation);
    const isExistingRegular = state.kind === "empty" || state.kind === "regular";
    if (requested.operation === "create" && state.kind !== "missing") {
      throw planInvalid(`create requires an observed missing state at ${observed.path}`, undefined, observed.path);
    }
    if (requested.operation === "replace" && !isExistingRegular) {
      throw planInvalid(`replace requires an observed regular file at ${observed.path}`, undefined, observed.path);
    }
    if (requested.operation === "delete" && state.kind === "missing") {
      throw planInvalid(`delete requires an observed existing state at ${observed.path}`, undefined, observed.path);
    }
    if (requested.operation !== "delete" && requested.afterBytes === null) {
      throw planInvalid(`non-delete repair operation has no complete after-bytes at ${observed.path}`, undefined, observed.path);
    }
    files.push({
      path: observed.path,
      operation: requested.operation,
      observationToken: observed.token,
      observationId: observed.observation.observationId,
      before: state,
      beforeBytes: cloneBytes(observed.bytes),
      afterBytes: cloneBytes(requested.afterBytes),
    });
  }

  return freezePlan({
    planId: input.planId ?? randomUUID(),
    operationId: input.operationId ?? randomUUID(),
    sourceWorkspaceId: b.workspaceId,
    sourceCandidateId: b.candidateId,
    sourceGenerationId: b.generationId,
    producingAttemptId: input.producingAttemptId,
    producingRole: input.producingRole,
    ...(input.producingInvocationId === undefined ? {} : { producingInvocationId: input.producingInvocationId }),
    files,
    ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
  });
}

/**
 * Build a plan from an immutable source snapshot rather than a live session.
 * Tournament replay uses this when the winner's source candidate has already
 * been verified/committed: the base bytes are read from the immutable source
 * generation and the winner's complete after-bytes are observed separately.
 * The destination is still re-observed by importRepairPlan before any write.
 */
export function createRepairPlanFromSnapshot(input: {
  readonly planId?: string;
  readonly operationId?: string;
  readonly sourceWorkspaceId: string;
  readonly sourceCandidateId: string;
  readonly sourceGenerationId: string;
  readonly producingAttemptId: string;
  readonly producingRole: string;
  readonly producingInvocationId?: string;
  readonly files: readonly {
    readonly path: string;
    readonly operation: RepairOperationKind;
    readonly observationId?: string;
    readonly before: FileState;
    readonly beforeBytes: Readonly<Uint8Array> | null;
    readonly afterBytes: Readonly<Uint8Array> | null;
  }[];
  readonly rationale?: string;
}): RepairPlan {
  if (input.files.length === 0) throw planInvalid("repair snapshot plan must contain at least one file");
  const files: RepairPlanFile[] = input.files.map((file) => {
    const before = stateOnly(file.before);
    const beforeBytes = cloneBytes(file.beforeBytes);
    if ((before.kind === "missing" || before.kind === "directory" || before.kind === "symlink") !== (beforeBytes === null)) {
      throw planInvalid(`source snapshot bytes do not match the observed state at ${file.path}`, undefined, file.path);
    }
    if (beforeBytes !== null && (before.kind !== "empty" && before.kind !== "regular" || before.byteLength !== beforeBytes.byteLength || before.sha256 !== sha256Bytes(beforeBytes))) {
      throw planInvalid(`source snapshot before hash does not match the observed bytes at ${file.path}`, undefined, file.path);
    }
    if (file.operation === "create" && before.kind !== "missing") {
      throw planInvalid(`create requires a missing source state at ${file.path}`, undefined, file.path);
    }
    if (file.operation === "replace" && before.kind !== "empty" && before.kind !== "regular") {
      throw planInvalid(`replace requires a regular source state at ${file.path}`, undefined, file.path);
    }
    if (file.operation === "delete" && before.kind === "missing") {
      throw planInvalid(`delete requires an existing source state at ${file.path}`, undefined, file.path);
    }
    const afterBytes = cloneBytes(file.afterBytes);
    if (file.operation !== "delete" && afterBytes === null) {
      throw planInvalid(`non-delete source snapshot operation has no after-bytes at ${file.path}`, undefined, file.path);
    }
    return {
      path: file.path,
      operation: file.operation,
      observationToken: file.observationId ?? `source:${input.sourceGenerationId}:${file.path}`,
      observationId: file.observationId ?? `source:${input.sourceGenerationId}:${file.path}`,
      before,
      beforeBytes,
      afterBytes,
    };
  });
  return freezePlan({
    planId: input.planId ?? randomUUID(),
    operationId: input.operationId ?? randomUUID(),
    sourceWorkspaceId: input.sourceWorkspaceId,
    sourceCandidateId: input.sourceCandidateId,
    sourceGenerationId: input.sourceGenerationId,
    producingAttemptId: input.producingAttemptId,
    producingRole: input.producingRole,
    ...(input.producingInvocationId === undefined ? {} : { producingInvocationId: input.producingInvocationId }),
    files,
    ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
  });
}

function toSessionOps(plan: RepairPlan, files: readonly RepairPlanFile[] = plan.files): readonly SessionByteMutation[] {
  return files.map((file) => ({
    path: file.path,
    observationToken: file.observationToken,
    observationId: file.observationId,
    kind: file.operation,
    ...(file.afterBytes === null ? {} : { content: file.afterBytes }),
  }));
}

function mapApplyError(error: unknown, plan: RepairPlan, paths: readonly string[]): RepairMutationError {
  if (error instanceof RepairMutationError) return error;
  if (error instanceof MutationError && error.code === STALE_MUTATION) {
    return new RepairMutationError("STALE_REPAIR", error.message, { planId: plan.planId, operationId: plan.operationId, ...(error.path === undefined ? {} : { path: error.path }) });
  }
  if (error instanceof MutationError && error.code === "MUTATION_POLICY") {
    return new RepairMutationError("REPAIR_GENERATION_REVOKED", error.message, { planId: plan.planId, operationId: plan.operationId, ...(error.path === undefined ? {} : { path: error.path }) });
  }
  if (error instanceof MutationError && error.code === "MUTATION_VALIDATION") {
    return new RepairMutationError("REPAIR_PLAN_INVALID", error.message, { planId: plan.planId, operationId: plan.operationId, ...(error.path === undefined ? {} : { path: error.path }) });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new RepairMutationError("REPAIR_PARTIAL_APPLY_PREVENTED", `${message}; authoritative batch prevented partial repair apply`, {
    planId: plan.planId,
    operationId: plan.operationId,
    ...(paths[0] === undefined ? {} : { path: paths[0] }),
  });
}

/** Apply a plan against the exact observations from which it was made. */
export async function applyRepairPlan(session: MutationSessionLike, plan: RepairPlan): Promise<AppliedRepairPlan> {
  if (!bindingMatches(session, plan)) throw planInvalid("repair plan source identity does not match the target mutation session", plan);
  try {
    const mutations = await session.applyByteBatch(toSessionOps(plan), plan.operationId);
    return { plan, mutations, mutationApplied: true, partialMutation: false };
  } catch (error) {
    throw mapApplyError(error, plan, plan.files.map((f) => f.path));
  }
}

/**
 * Import a source plan into another candidate generation. The destination is
 * observed under its own session and every before-state must match the source
 * snapshot before one byte is changed.
 */
export async function importRepairPlan(
  session: MutationSessionLike,
  plan: RepairPlan,
  opts: { readonly targetGenerationId?: string } = {},
): Promise<ImportedRepairPlan> {
  const target = session.binding;
  const targetFiles: RepairPlanFile[] = [];
  for (const file of plan.files) {
    const observed = await session.observeBytes(file.path);
    if (!sameFileState(observed.observation, file.before)) {
      throw new RepairMutationError(
        "TOURNAMENT_BASE_DIVERGED",
        `destination base diverged at ${file.path}: expected ${file.before.kind}/${file.before.sha256 ?? "none"}, found ${observed.observation.kind}/${observed.observation.sha256 ?? "none"}`,
        { planId: plan.planId, operationId: plan.operationId, path: file.path },
      );
    }
    targetFiles.push({
      ...file,
      observationToken: observed.token,
      observationId: observed.observation.observationId,
      before: stateOnly(observed.observation),
      beforeBytes: observed.bytes === null ? null : cloneBytes(observed.bytes),
    });
  }
  const targetPlan = freezePlan({
    ...plan,
    operationId: randomUUID(),
    sourceWorkspaceId: target.workspaceId,
    sourceCandidateId: target.candidateId,
    sourceGenerationId: opts.targetGenerationId ?? target.generationId,
    files: targetFiles,
  });
  try {
    const mutations = await session.applyByteBatch(toSessionOps(targetPlan, targetFiles), targetPlan.operationId);
    return {
      plan,
      mutations,
      mutationApplied: true,
      partialMutation: false,
      sourceGenerationId: plan.sourceGenerationId,
      targetGenerationId: opts.targetGenerationId ?? target.generationId,
    };
  } catch (error) {
    throw mapApplyError(error, plan, plan.files.map((f) => f.path));
  }
}

/** Restore one successful repair only while its exact after-state is still on disk. */
export async function restoreRepairMutations(
  session: MutationSessionLike,
  applied: readonly BoundMutationResult[],
  opts: { readonly planId?: string; readonly operationId?: string } = {},
): Promise<readonly BoundMutationResult[]> {
  if (applied.length === 0) return [];
  const seen = new Set<string>();
  const currentByPath: Array<{ readonly applied: BoundMutationResult; readonly current: Awaited<ReturnType<MutationSessionLike["observeBytes"]>> }> = [];
  for (const mutation of applied) {
    const path = mutation.mutation.path;
    if (seen.has(path)) throw new RepairMutationError("REPAIR_PLAN_INVALID", `repair restore contains duplicate path ${path}`, { ...opts, path });
    seen.add(path);
    const current = await session.observeBytes(path);
    if (!sameFileState(current.observation, mutation.mutation.after)) {
      throw new RepairMutationError("REPAIR_RESTORE_STALE", `repair restore refused at ${path}: the file no longer equals the mutation after-state`, { ...opts, path });
    }
    currentByPath.push({ applied: mutation, current });
  }
  const edits: SessionByteMutation[] = [];
  for (const entry of currentByPath) {
    const path = entry.applied.mutation.path;
    const before = entry.applied.mutation.before;
    // A CREATE is restored by deleting the currently-existing after-state; a
    // DELETE is restored by creating the previously-existing before-state.
    // The current observed state, not only the before state, determines which
    // explicit core operation is valid.
    const operation: RepairOperationKind = before.kind === "missing"
      ? "delete"
      : entry.current.observation.kind === "missing"
        ? "create"
        : "replace";
    if (operation === "replace" || operation === "create") {
      if (before.kind !== "empty" && before.kind !== "regular") {
        throw new RepairMutationError("REPAIR_PLAN_INVALID", `repair restore cannot reconstruct ${before.kind} at ${path}`, { ...opts, path });
      }
      if (entry.applied.beforeBytes === undefined || entry.applied.beforeBytes === null) {
        throw new RepairMutationError("REPAIR_PLAN_INVALID", `repair restore has no before-bytes at ${path}`, { ...opts, path });
      }
    }
    edits.push({
      path,
      observationToken: entry.current.token,
      observationId: entry.current.observation.observationId,
      kind: operation,
      ...(operation === "replace" || operation === "create" ? { content: entry.applied.beforeBytes } : {}),
    });
  }
  try {
    return await session.applyByteBatch(edits, opts.operationId);
  } catch (error) {
    if (error instanceof RepairMutationError) throw error;
    const firstPath = applied[0]?.mutation.path;
    if (error instanceof MutationError && error.code === STALE_MUTATION) {
      throw new RepairMutationError("REPAIR_RESTORE_STALE", error.message, { ...opts, ...(firstPath === undefined ? {} : { path: firstPath }) });
    }
    const plan = { planId: opts.planId ?? "restore", operationId: opts.operationId ?? "restore", files: applied.map((entry) => ({ path: entry.mutation.path })) } as unknown as RepairPlan;
    throw mapApplyError(error, plan, applied.map((entry) => entry.mutation.path));
  }
}

/** Restore one successful repair through the same transactional batch path. */
export async function restoreRepairMutation(
  session: MutationSessionLike,
  applied: BoundMutationResult,
  opts: { readonly planId?: string; readonly operationId?: string } = {},
): Promise<BoundMutationResult> {
  return (await restoreRepairMutations(session, [applied], opts))[0]!;
}

/** Stable failure projection for receipts, role results, and operator output. */
export function repairFailure(error: unknown, input: {
  readonly plan?: RepairPlan;
  readonly session: MutationSessionLike;
  readonly paths?: readonly string[];
  readonly targetGenerationId?: string;
}): RepairMutationFailure {
  const repair = error instanceof RepairMutationError ? error : undefined;
  const code = repair?.code ?? "REPAIR_PARTIAL_APPLY_PREVENTED";
  const b = input.session.binding;
  const plan = input.plan;
  const paths = repair?.path === undefined ? [...(input.paths ?? plan?.files.map((f) => f.path) ?? [])] : [repair.path];
  const retryable = code === "STALE_REPAIR" || code === "RELOCATION_REQUIRED" || code === "TOURNAMENT_BASE_DIVERGED" || code === "REPAIR_RESTORE_STALE";
  const planId = repair?.planId ?? plan?.planId;
  const operationId = repair?.operationId ?? plan?.operationId;
  return {
    code,
    ...(planId === undefined ? {} : { planId }),
    ...(operationId === undefined ? {} : { operationId }),
    workspaceId: b.workspaceId,
    candidateId: b.candidateId,
    ...(plan?.sourceWorkspaceId === undefined ? {} : { sourceWorkspaceId: plan.sourceWorkspaceId }),
    ...(plan?.sourceCandidateId === undefined ? {} : { sourceCandidateId: plan.sourceCandidateId }),
    ...(plan?.sourceGenerationId === undefined ? {} : { sourceGenerationId: plan.sourceGenerationId }),
    targetGenerationId: input.targetGenerationId ?? b.generationId,
    ...(plan?.producingAttemptId ?? b.attemptId) === undefined ? {} : { attemptId: plan?.producingAttemptId ?? b.attemptId },
    ...(plan?.producingRole ?? b.role) === undefined ? {} : { role: plan?.producingRole ?? b.role },
    ...(plan?.producingInvocationId ?? b.invocationId) === undefined ? {} : { invocationId: plan?.producingInvocationId ?? b.invocationId },
    paths,
    mutationApplied: false,
    partialMutation: false,
    retryable,
    recommendedRecovery: retryable ? "Re-observe every affected file and generate a new repair plan." : "Stop and require explicit recovery; no repair mutation was applied.",
    message: error instanceof Error ? error.message : String(error),
  };
}

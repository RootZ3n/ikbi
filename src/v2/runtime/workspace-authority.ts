/**
 * ADAPTERS — v1's workspace manager and state-bound mutation core, behind v2 authorities.
 *
 * WHAT IS ADOPTED, AND WHY IT IS NOT REBUILT. v1's mutation core is the strongest thing
 * in the donor codebase and this slice would be strictly worse for reimplementing it:
 *
 *   - `observe` normalizes and confines the path, re-asserts the workspace root by
 *     `realpath`, and walks every existing parent component rejecting symlink ancestors
 *     (`core/workspace/mutation.ts:370-376`);
 *   - the observation is kept in the core's PRIVATE table, so a caller cannot alter the
 *     expected bytes after observing them;
 *   - `apply` takes a cross-process lock, re-reads the path, and compares the raw byte
 *     identity before writing — raising `STALE_MUTATION` when it differs
 *     (`mutation.ts:527+`);
 *   - the write itself goes through `atomicWriteFile` (temp file + rename).
 *
 * v2 therefore adds exactly what the donor lacks for its own purposes: a run binding, a
 * workspace-scoped content-addressed observation identity, a source-tree binding for the
 * workspace, and structured v2 failures instead of thrown errors.
 *
 * WHAT IS NOT ADOPTED: promotion. `WorkspaceManager.promote` is a real, careful
 * compare-and-swap, and it stays untouched and unused here — promotion is its own
 * authority in a later slice, and calling it from this one would create exactly the
 * second promote path v2 exists to prevent.
 */

import { randomUUID } from "node:crypto";

import type { AgentIdentity } from "../../core/provider/contract.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import { runGit } from "../../core/workspace/git.js";
import { WorkspaceManager } from "../../core/workspace/manager.js";
import {
  MutationError,
  STALE_MUTATION,
  StaleMutationError,
  createWorkspaceMutation,
  type FileObservation,
  type MutationContext,
  type WorkspaceMutation,
} from "../../core/workspace/mutation.js";
import type { V2ObservationDigest, V2RunId, V2WorkspaceId } from "../core/identity.js";
import {
  V2_WORKSPACE_FAILURE_CODES,
  mutationDigest,
  observationDigest,
  staleObservationFailure,
  validateObservationBinding,
  workspaceFailure,
  type MutationOutcome,
  type FileReadOutcome,
  type ObservationOutcome,
  type ObservedState,
  type StateBoundMutationAuthority,
  type V2MutationRecord,
  type V2WorkspaceRecord,
  type WorkspaceAllocationResult,
  type WorkspaceAuthority,
  type WorkspaceDisposition,
} from "../core/workspace.js";
import { materializeSnapshot } from "./source-materializer.js";
import { writeWorktreeTree } from "./candidate-capture.js";
import type { CapturedBytes } from "./source-snapshot.js";

/** The identity v2 allocates workspaces under until it has its own identity system. */
const V2_IDENTITY: AgentIdentity = { agentId: "ikbi-v2", functionalRole: "builder", trustTier: "trusted" } as AgentIdentity;

/** The narrow slice of the donor manager these authorities use. Never `promote`. */
export interface WorkspaceManagerLike {
  allocate(opts: { targetRepo: string; identity: AgentIdentity; label?: string }): Promise<WorkspaceHandle>;
  discard(handle: WorkspaceHandle): Promise<{ readonly ok?: boolean } | unknown>;
  retain(handle: WorkspaceHandle, reason: string): Promise<{ readonly ok?: boolean } | unknown>;
}

/** Translate v1's `FileState` shape into v2's `ObservedState`. Mode is deliberately dropped. */
function toObservedState(state: {
  kind: string;
  sha256: string | null;
  byteLength: number | null;
  symlinkTarget: string | null;
}): ObservedState {
  return {
    kind: state.kind as ObservedState["kind"],
    contentSha256: state.sha256,
    byteLength: state.byteLength,
    symlinkTarget: state.symlinkTarget,
  };
}

/** Map a donor `MutationError` onto a structured v2 failure, preserving its distinctions. */
function mapMutationError(err: unknown, context: { workspaceId: V2WorkspaceId; path: string }): ReturnType<typeof workspaceFailure> {
  if (err instanceof MutationError) {
    const code =
      err.code === "MUTATION_CONFINEMENT"
        ? V2_WORKSPACE_FAILURE_CODES.pathEscapesWorkspace
        : err.code === "MUTATION_VALIDATION" || err.code === "MUTATION_POLICY"
          ? V2_WORKSPACE_FAILURE_CODES.mutationRejected
          : V2_WORKSPACE_FAILURE_CODES.mutationIoFailure;
    return workspaceFailure({
      code,
      message: err.message,
      detail: { workspaceId: context.workspaceId, path: context.path, donorCode: err.code },
    });
  }
  return workspaceFailure({
    code: V2_WORKSPACE_FAILURE_CODES.mutationIoFailure,
    message: err instanceof Error ? err.message : String(err),
    detail: { workspaceId: context.workspaceId, path: context.path },
  });
}

/**
 * THE workspace authority.
 *
 * `allocate` binds the workspace to the EXACT source commit and tree, not to a branch
 * name: a branch moves, and a future promotion has to compare against what this candidate
 * was actually cut from.
 */
export function createWorkspaceAuthority(deps: {
  readonly manager: WorkspaceManagerLike;
  readonly mintWorkspaceId: () => V2WorkspaceId;
  /** Captured delta bytes for a snapshot, so its state can be reproduced in the worktree. */
  readonly capturedBytes: (snapshotId: string) => CapturedBytes | undefined;
  readonly now?: () => number;
}): WorkspaceAuthority & { handleOf(record: V2WorkspaceRecord): WorkspaceHandle | undefined } {
  const now = deps.now ?? Date.now;
  // The donor handle is kept out of the v2 record: a record is data an operator and a
  // receipt can read, while a handle is a live capability only these authorities hold.
  const handles = new Map<string, WorkspaceHandle>();

  return {
    handleOf: (record) => handles.get(record.workspaceId),

    async allocate(input): Promise<WorkspaceAllocationResult> {
      const snapshot = input.source;
      let handle: WorkspaceHandle;
      try {
        handle = await deps.manager.allocate({
          targetRepo: snapshot.repositoryRoot,
          identity: V2_IDENTITY,
          ...(input.label !== undefined ? { label: input.label } : {}),
        });
      } catch (err) {
        return {
          ok: false,
          failure: workspaceFailure({
            code: V2_WORKSPACE_FAILURE_CODES.allocationFailed,
            message: `could not allocate an isolated workspace: ${err instanceof Error ? err.message : String(err)}`,
            detail: { repoPath: snapshot.repositoryRoot },
          }),
        };
      }

      // The TREE of the base commit — content identity, independent of commit metadata.
      let baseTree: string;
      try {
        baseTree = (await runGit(snapshot.repositoryRoot, ["rev-parse", `${handle.baseRef}^{tree}`])).stdout.trim();
      } catch (err) {
        // The workspace exists but cannot be truthfully bound. Rather than record a
        // half-known binding, hand it back and fail.
        await deps.manager.discard(handle).catch(() => undefined);
        return {
          ok: false,
          failure: workspaceFailure({
            code: V2_WORKSPACE_FAILURE_CODES.sourceUnreadable,
            message: `allocated a workspace but could not read the source tree of ${handle.baseRef}: ${err instanceof Error ? err.message : String(err)}`,
            detail: { repoPath: snapshot.repositoryRoot, baseRef: handle.baseRef },
          }),
        };
      }

      // MATERIALIZE the snapshot. The worktree arrives at HEAD; for a dirty checkout the
      // operator's uncommitted work is reproduced on top, then VERIFIED. A workspace that
      // does not actually hold the snapshot is handed back rather than handed on.
      const materialized = materializeSnapshot({
        snapshot,
        captured: deps.capturedBytes(snapshot.snapshotId) ?? new Map(),
        workspacePath: handle.path,
      });
      if (!materialized.ok) {
        await deps.manager.discard(handle).catch(() => undefined);
        return { ok: false, failure: materialized.failure };
      }

      // THE STARTING TREE, recorded before any model turn exists. This is what a
      // candidate's `changed` is measured against, so the operator's own uncommitted work
      // can never be reported as something the builder did.
      let startTree: string;
      try {
        startTree = await writeWorktreeTree(handle.path);
      } catch (err) {
        await deps.manager.discard(handle).catch(() => undefined);
        return {
          ok: false,
          failure: workspaceFailure({
            code: V2_WORKSPACE_FAILURE_CODES.sourceUnreadable,
            message: `allocated a workspace but could not record its starting state: ${err instanceof Error ? err.message : String(err)}`,
            detail: { workspacePath: handle.path },
          }),
        };
      }

      const workspaceId = deps.mintWorkspaceId();
      handles.set(workspaceId, handle);
      return {
        ok: true,
        workspace: Object.freeze({
          workspaceId,
          runId: input.runId,
          donorWorkspaceId: handle.id,
          source: Object.freeze({
            repositoryPath: handle.targetRepo,
            baseBranch: handle.baseBranch,
            baseCommit: handle.baseRef,
            baseTree,
            sourceSnapshotId: snapshot.snapshotId,
            materializedStateDigest: materialized.proof.materializedStateDigest,
            materializedEntries: materialized.proof.applied,
            startTree,
          }),
          path: handle.path,
          status: "allocated" as const,
          allocatedAt: now(),
        }),
      };
    },

    async discard(record): Promise<WorkspaceDisposition> {
      const handle = handles.get(record.workspaceId);
      if (handle === undefined) {
        return { kind: "failed", attempted: "discard", detail: "no live handle for this workspace in this process" };
      }
      try {
        await deps.manager.discard(handle);
        handles.delete(record.workspaceId);
        return { kind: "discarded" };
      } catch (err) {
        // A cleanup that did not finish is NEVER reported as if it had. The worktree is
        // still on disk and the operator needs to know that.
        return { kind: "failed", attempted: "discard", detail: err instanceof Error ? err.message : String(err) };
      }
    },

    async retain(record, reason): Promise<WorkspaceDisposition> {
      const handle = handles.get(record.workspaceId);
      if (handle === undefined) {
        return { kind: "failed", attempted: "retain", detail: "no live handle for this workspace in this process" };
      }
      try {
        await deps.manager.retain(handle, reason);
        handles.delete(record.workspaceId);
        return { kind: "retained", reason };
      } catch (err) {
        return { kind: "failed", attempted: "retain", detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/**
 * THE state-bound mutation authority.
 *
 * It keeps one donor mutation core per workspace, and its own table mapping v2's
 * content-addressed observation ids to the donor observations that actually carry the
 * observed bytes. A caller therefore holds a NAME for a capability, never the capability
 * itself — it cannot present bytes it did not observe.
 */
export function createMutationAuthority(deps: {
  readonly workspaceHandle: (record: V2WorkspaceRecord) => WorkspaceHandle | undefined;
  readonly now?: () => number;
  /** Test seam. Production uses the donor core. */
  readonly createMutation?: (handle: WorkspaceHandle) => Promise<WorkspaceMutation>;
}): StateBoundMutationAuthority {
  const now = deps.now ?? Date.now;
  const cores = new Map<string, WorkspaceMutation>();
  // Keyed by `${workspaceId} ${observationId}` — the workspace is PART of the key,
  // so an observation cannot be looked up from a sibling workspace even by accident.
  const observations = new Map<string, FileObservation>();
  const key = (workspaceId: string, observationId: string): string => `${workspaceId} ${observationId}`;

  async function coreFor(record: V2WorkspaceRecord): Promise<WorkspaceMutation | undefined> {
    const existing = cores.get(record.workspaceId);
    if (existing !== undefined) return existing;
    const handle = deps.workspaceHandle(record);
    if (handle === undefined) return undefined;
    const core = await (deps.createMutation ?? ((h: WorkspaceHandle) => createWorkspaceMutation(h)))(handle);
    cores.set(record.workspaceId, core);
    return core;
  }

  /** The donor context. `candidateId` is the workspace: no candidate exists in this slice. */
  function donorContext(record: V2WorkspaceRecord, role: string): MutationContext {
    return {
      workspaceId: record.donorWorkspaceId,
      candidateId: record.workspaceId,
      generationId: record.runId,
      operationId: randomUUID(),
      actor: "deterministic-system",
      cause: "deterministic-system",
      role,
    };
  }

  return {
    async observe(input): Promise<ObservationOutcome> {
      if (input.workspace.runId !== input.runId) {
        return {
          ok: false,
          failure: workspaceFailure({
            code: V2_WORKSPACE_FAILURE_CODES.runMismatch,
            message: `workspace ${input.workspace.workspaceId} belongs to a different run`,
            detail: { workspaceId: input.workspace.workspaceId },
          }),
        };
      }
      const core = await coreFor(input.workspace);
      if (core === undefined) {
        return {
          ok: false,
          failure: workspaceFailure({
            code: V2_WORKSPACE_FAILURE_CODES.observationFailed,
            message: `no live workspace handle for ${input.workspace.workspaceId}`,
            detail: { workspaceId: input.workspace.workspaceId, path: input.path },
          }),
        };
      }
      let donor: FileObservation;
      try {
        donor = await core.observe(donorContext(input.workspace, "observer"), input.path);
      } catch (err) {
        return { ok: false, failure: mapMutationError(err, { workspaceId: input.workspace.workspaceId, path: input.path }) };
      }

      const state = toObservedState(donor);
      const observationId = observationDigest({ workspaceId: input.workspace.workspaceId, path: donor.path, state });
      observations.set(key(input.workspace.workspaceId, observationId), donor);
      return {
        ok: true,
        observation: Object.freeze({
          observationId,
          runId: input.runId,
          workspaceId: input.workspace.workspaceId,
          path: donor.path,
          state: Object.freeze(state),
          observedAt: now(),
        }),
      };
    },

    async read(input): Promise<FileReadOutcome> {
      // ONE ACT. The donor observation already retains the exact bytes it saw
      // (`mutation.ts` `FileObservation.bytes`), so the content handed back and the
      // observation that anchors it come from the same instant. Reading the file again
      // separately would open a window in which they disagree — precisely the window a
      // state-bound edit exists to close.
      const observed = await this.observe({ runId: input.runId, workspace: input.workspace, path: input.path });
      if (!observed.ok) return observed;

      const donor = observations.get(key(input.workspace.workspaceId, observed.observation.observationId));
      const bytes = donor?.bytes ?? null;
      if (observed.observation.state.kind !== "regular" || bytes === null) {
        // Missing, empty, a directory or a symlink: a real observation with nothing to
        // show. The caller still holds an anchor — which is how `create_file` works.
        return { ok: true, observation: observed.observation };
      }
      return { ok: true, observation: observed.observation, content: Buffer.from(bytes).toString("utf8").slice(0, input.maxChars) };
    },

    async mutate(input): Promise<MutationOutcome> {
      // BINDING FIRST, before any I/O. A foreign observation never gets as far as a lock.
      const bindingProblem = validateObservationBinding({
        runId: input.runId,
        workspace: input.workspace,
        observation: input.observation,
      });
      if (bindingProblem !== undefined) return { ok: false, failure: bindingProblem };

      const donor = observations.get(key(input.workspace.workspaceId, input.observation.observationId));
      if (donor === undefined) {
        return {
          ok: false,
          failure: workspaceFailure({
            code: V2_WORKSPACE_FAILURE_CODES.unknownObservation,
            message: `observation ${input.observation.observationId} was not taken by this authority in workspace ${input.workspace.workspaceId}`,
            detail: { workspaceId: input.workspace.workspaceId, observationId: input.observation.observationId, path: input.observation.path },
          }),
        };
      }
      const core = await coreFor(input.workspace);
      if (core === undefined) {
        return {
          ok: false,
          failure: workspaceFailure({
            code: V2_WORKSPACE_FAILURE_CODES.mutationIoFailure,
            message: `no live workspace handle for ${input.workspace.workspaceId}`,
            detail: { workspaceId: input.workspace.workspaceId },
          }),
        };
      }

      const context = donorContext(input.workspace, "mutator");
      try {
        // The donor takes the cross-process lock, re-reads the path and compares raw byte
        // identity before writing. That comparison IS the compare-and-swap.
        const result =
          input.operation.kind === "delete"
            ? await core.delete(context, donor)
            : input.operation.kind === "create"
              ? await core.create(context, donor, Buffer.from(input.operation.content))
              : await core.replace(context, donor, Buffer.from(input.operation.content));

        const before = toObservedState(result.before);
        const after = toObservedState(result.after);
        const record: Omit<V2MutationRecord, "mutationId" | "appliedAt"> = {
          runId: input.runId,
          workspaceId: input.workspace.workspaceId,
          observationId: input.observation.observationId,
          path: result.path,
          operation: input.operation.kind,
          before,
          after,
          // Byte-identical replacement is applied and recorded, with `changed: false`.
          changed: before.contentSha256 !== after.contentSha256 || before.kind !== after.kind,
        };
        return { ok: true, record: Object.freeze({ ...record, mutationId: mutationDigest(record), appliedAt: now() }) };
      } catch (err) {
        if (err instanceof StaleMutationError || (err instanceof MutationError && err.code === STALE_MUTATION)) {
          const stale = err as StaleMutationError;
          return {
            ok: false,
            failure: staleObservationFailure({
              workspaceId: input.workspace.workspaceId,
              observationId: input.observation.observationId,
              path: input.observation.path,
              expected: toObservedState(stale.expected),
              actual: toObservedState(stale.actual),
            }),
          };
        }
        return { ok: false, failure: mapMutationError(err, { workspaceId: input.workspace.workspaceId, path: input.observation.path }) };
      }
    },
  };
}

/** Build the production workspace + mutation authorities over the donor manager. */
export function createProductionWorkspaceAuthorities(deps: {
  readonly manager: WorkspaceManager | WorkspaceManagerLike;
  readonly mintWorkspaceId: () => V2WorkspaceId;
  readonly capturedBytes: (snapshotId: string) => CapturedBytes | undefined;
  readonly now?: () => number;
}): { workspaces: ReturnType<typeof createWorkspaceAuthority>; mutations: StateBoundMutationAuthority } {
  const workspaces = createWorkspaceAuthority({
    manager: deps.manager as WorkspaceManagerLike,
    mintWorkspaceId: deps.mintWorkspaceId,
    capturedBytes: deps.capturedBytes,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  const mutations = createMutationAuthority({
    workspaceHandle: (record) => workspaces.handleOf(record),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  return { workspaces, mutations };
}

/** Re-exported so callers need not reach into the donor for the observation id type. */
export type { V2ObservationDigest, V2RunId };

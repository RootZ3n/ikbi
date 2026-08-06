/**
 * State-bound candidate-file mutation core.
 *
 * An observation is a capability for one exact path/state pair. The capability
 * is kept in this core's private observation table, so callers cannot alter the
 * expected bytes or identity fields after observing them. Every apply is
 * serialized with the workspace's cross-process mutation lock and rechecks the
 * path and raw-byte identity before it writes.
 */

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rmdir, symlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

import { atomicWriteFile } from "../substrate/atomic.js";
import { locks as defaultLocks } from "../substrate/index.js";
import { LockManager } from "../substrate/lock.js";
import { SubstrateError } from "../substrate/contract.js";
import type { WorkspaceHandle } from "./contract.js";
import {
  observeFileState,
  sameFileState,
  sha256Bytes,
  type FileState,
  type FileStateKind,
  type ObservedFileState,
} from "./file-state.js";

/** Stable error code for an observation that no longer describes disk state. */
export const STALE_MUTATION = "STALE_MUTATION" as const;

export type MutationErrorCode =
  | typeof STALE_MUTATION
  | "MUTATION_VALIDATION"
  | "MUTATION_POLICY"
  | "MUTATION_CONFINEMENT"
  | "MUTATION_IO"
  | "MUTATION_LOCK";

/** A typed failure from the state-bound mutation core. */
export class MutationError extends Error {
  readonly code: MutationErrorCode;
  readonly path?: string;

  constructor(code: MutationErrorCode, message: string, opts?: { path?: string; cause?: unknown }) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "MutationError";
    this.code = code;
    if (opts?.path !== undefined) this.path = opts.path;
  }
}

/** A stale observation; no write was attempted. */
export class StaleMutationError extends MutationError {
  readonly expected: FileState;
  readonly actual: FileState;

  constructor(path: string, expected: FileState, actual: FileState) {
    super(
      STALE_MUTATION,
      `stale mutation precondition for ${path}: expected ${expected.kind}/${expected.sha256 ?? "none"}, ` +
        `found ${actual.kind}/${actual.sha256 ?? "none"}`,
      { path },
    );
    this.name = "StaleMutationError";
    this.expected = expected;
    this.actual = actual;
  }
}

/** Actor classification required for every mutation. */
export type MutationActor = "human" | "model" | "deterministic-system" | "recovery";

/** Cause classification required for every mutation. */
export type MutationCause = "human" | "model" | "deterministic-system" | "recovery";

/** Identity and attribution carried by each observation/apply call. */
export interface MutationContext {
  readonly workspaceId: string;
  readonly candidateId: string;
  readonly generationId: string;
  readonly operationId: string;
  readonly actor: MutationActor;
  readonly cause: MutationCause;
  /** Model invocation identity is optional for human/system/recovery actions. */
  readonly invocationId?: string;
  readonly requestId?: string;
  readonly attemptId?: string;
  readonly role?: string;
  /** Validated caller identity, when the surrounding authority has one. */
  readonly validatedIdentity?: string;
}

/** An exact file observation bound to one managed candidate workspace. */
export interface FileObservation extends FileState {
  readonly workspaceId: string;
  readonly candidateId: string;
  readonly generationId: string;
  readonly operationId: string;
  readonly observationId: string;
  /** Optional attribution copied from the mutation context when it exists. */
  readonly invocationId?: string;
  readonly requestId?: string;
  readonly attemptId?: string;
  readonly role?: string;
  readonly validatedIdentity?: string;
  /** Normalized path relative to the managed workspace root. */
  readonly path: string;
  /** Exact regular-file bytes retained for deriving a replacement. */
  readonly bytes: Readonly<Uint8Array> | null;
}

export type MutationBytes = Uint8Array;

/** A complete replacement, or a pure transformation of the exact observed bytes. */
export type ReplacementContent =
  | MutationBytes
  | ((observedBytes: Readonly<Uint8Array>) => MutationBytes);

export interface CreateMutation {
  readonly kind: "create";
  readonly path: string;
  readonly observation: FileObservation;
  readonly content: MutationBytes;
}

export interface ReplaceMutation {
  readonly kind: "replace";
  readonly path: string;
  readonly observation: FileObservation;
  readonly content: ReplacementContent;
}

export interface DeleteMutation {
  readonly kind: "delete";
  readonly path: string;
  readonly observation: FileObservation;
}

export type MutationOperation = CreateMutation | ReplaceMutation | DeleteMutation;

/** Before/after proof returned after a successful disk mutation. */
export interface MutationResult {
  readonly operationId: string;
  readonly observationId: string;
  readonly workspaceId: string;
  readonly candidateId: string;
  readonly generationId: string;
  readonly actor: MutationActor;
  readonly cause: MutationCause;
  readonly invocationId?: string;
  readonly requestId?: string;
  readonly attemptId?: string;
  readonly role?: string;
  readonly validatedIdentity?: string;
  readonly path: string;
  readonly kind: MutationOperation["kind"];
  readonly before: FileState;
  readonly after: FileState;
}

export interface WorkspaceMutationOptions {
  /** Dependency seam for tests or an embedding service. */
  readonly locks?: LockManager;
  /** Override only for an embedding service that owns a lock namespace. */
  readonly lockFile?: string;
  readonly lockTimeoutMs?: number;
  readonly lockStaleMs?: number;
}

/** The authoritative mutation API for one managed candidate workspace. */
export interface WorkspaceMutation {
  observe(context: MutationContext, path: string): Promise<FileObservation>;
  apply(context: MutationContext, operation: MutationOperation): Promise<MutationResult>;
  /** Apply a non-overlapping set of operations as one locked transaction. */
  applyBatch(context: MutationContext, operations: readonly MutationOperation[]): Promise<readonly MutationResult[]>;
  create(context: MutationContext, observation: FileObservation, content: MutationBytes): Promise<MutationResult>;
  replace(
    context: MutationContext,
    observation: FileObservation,
    content: ReplacementContent,
  ): Promise<MutationResult>;
  delete(context: MutationContext, observation: FileObservation): Promise<MutationResult>;
}

interface StoredObservation extends FileObservation {
  readonly bytes: Buffer | null;
}

interface PreparedMutation {
  readonly operation: MutationOperation;
  readonly stored: StoredObservation;
  readonly relativePath: string;
  readonly fullPath: string;
  readonly current: ObservedFileState;
  readonly resultBytes: Buffer | null;
}

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_STALE_MS = 120_000;

function validation(message: string, path?: string): MutationError {
  return new MutationError("MUTATION_VALIDATION", message, path === undefined ? undefined : { path });
}

function confinement(message: string, path?: string): MutationError {
  return new MutationError("MUTATION_CONFINEMENT", message, path === undefined ? undefined : { path });
}

function policy(message: string, path?: string): MutationError {
  return new MutationError("MUTATION_POLICY", message, path === undefined ? undefined : { path });
}

function ioFailure(message: string, cause: unknown, path?: string): MutationError {
  return new MutationError("MUTATION_IO", message, {
    ...(path === undefined ? {} : { path }),
    cause,
  });
}

function bytesEqual(left: Readonly<Uint8Array> | null, right: Readonly<Uint8Array> | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function validateNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw validation(`${label} must be a non-empty string without NUL bytes`);
  }
}

function validateContext(context: MutationContext): void {
  validateNonEmpty(context.workspaceId, "workspaceId");
  validateNonEmpty(context.candidateId, "candidateId");
  validateNonEmpty(context.generationId, "generationId");
  validateNonEmpty(context.operationId, "operationId");
  validateNonEmpty(context.actor, "actor");
  validateNonEmpty(context.cause, "cause");
  if (context.invocationId !== undefined) validateNonEmpty(context.invocationId, "invocationId");
  if (context.requestId !== undefined) validateNonEmpty(context.requestId, "requestId");
  if (context.attemptId !== undefined) validateNonEmpty(context.attemptId, "attemptId");
  if (context.role !== undefined) validateNonEmpty(context.role, "role");
  if (context.validatedIdentity !== undefined) validateNonEmpty(context.validatedIdentity, "validatedIdentity");
}

function normalizeRelativePath(workspaceRoot: string, requestedPath: string): string {
  validateNonEmpty(requestedPath, "path");
  if (isAbsolute(requestedPath) || win32.isAbsolute(requestedPath)) {
    throw confinement(`absolute path is outside the managed workspace: ${requestedPath}`, requestedPath);
  }

  const resolved = resolve(workspaceRoot, requestedPath);
  const relativePath = relative(workspaceRoot, resolved);
  if (
    relativePath.length === 0 ||
    relativePath === "." ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw confinement(`path escapes the managed workspace: ${requestedPath}`, requestedPath);
  }
  return relativePath;
}

async function assertRootIsStillBound(workspacePath: string, canonicalRoot: string): Promise<void> {
  let currentRoot: string;
  try {
    currentRoot = await realpath(workspacePath);
  } catch (cause) {
    throw confinement(`managed workspace is unavailable: ${workspacePath}`);
  }
  if (currentRoot !== canonicalRoot) {
    throw confinement(`managed workspace path was replaced: ${workspacePath}`);
  }
  let entry;
  try {
    entry = await lstat(workspacePath);
  } catch (cause) {
    throw confinement(`managed workspace cannot be inspected: ${workspacePath}`);
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw confinement(`managed workspace root is not a directory: ${workspacePath}`);
  }
}

/** Check every existing parent component without following a symlink. */
async function assertNoSymlinkAncestors(root: string, target: string, requestedPath: string): Promise<void> {
  const parent = dirname(target);
  const parentRelative = relative(root, parent);
  if (parentRelative.length === 0) return;

  let current = root;
  for (const component of parentRelative.split(sep)) {
    if (component.length === 0) continue;
    current = join(current, component);
    let entry;
    try {
      entry = await lstat(current);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw ioFailure(`failed to inspect parent of ${requestedPath}`, cause, requestedPath);
    }
    if (entry.isSymbolicLink()) throw confinement(`symlink parent is not allowed: ${requestedPath}`, requestedPath);
    if (!entry.isDirectory()) throw confinement(`non-directory parent is not allowed: ${requestedPath}`, requestedPath);
  }
}

function fileStateOnly(observed: FileState): FileState {
  return {
    kind: observed.kind,
    byteLength: observed.byteLength,
    sha256: observed.sha256,
    symlinkTarget: observed.symlinkTarget,
    mode: observed.mode,
  };
}

function expectedKindAllowed(operation: MutationOperation["kind"], kind: FileStateKind): boolean {
  if (operation === "create") return kind === "missing";
  if (operation === "replace") return kind === "empty" || kind === "regular";
  return kind !== "missing";
}

function operationContent(operation: CreateMutation | ReplaceMutation, observed: StoredObservation): Buffer {
  if (operation.kind === "create") return Buffer.from(operation.content);

  const observedBytes = observed.bytes;
  if (observedBytes === null) throw validation(`replace requires regular-file bytes for ${operation.path}`, operation.path);
  let result: MutationBytes;
  try {
    result = typeof operation.content === "function"
      ? operation.content(Buffer.from(observedBytes))
      : operation.content;
  } catch (cause) {
    throw validation(`replacement content computation failed for ${operation.path}`);
  }
  if (!(result instanceof Uint8Array)) throw validation(`replacement content must be bytes for ${operation.path}`, operation.path);
  return Buffer.from(result);
}

function lockIdentity(root: string): string {
  return createHash("sha256").update(root, "utf8").digest("hex").slice(0, 32);
}

class WorkspaceMutationCore implements WorkspaceMutation {
  private readonly workspace: WorkspaceHandle;
  private readonly canonicalRoot: string;
  private readonly locks: LockManager;
  private readonly lockFile: string;
  private readonly options: WorkspaceMutationOptions;
  private readonly observations = new Map<string, StoredObservation>();

  constructor(
    workspace: WorkspaceHandle,
    canonicalRoot: string,
    options: WorkspaceMutationOptions,
  ) {
    this.workspace = workspace;
    this.canonicalRoot = canonicalRoot;
    this.options = options;
    this.locks = options.locks ?? defaultLocks;
    this.lockFile = options.lockFile ?? join(dirname(canonicalRoot), ".ikbi-mutation-locks", `${lockIdentity(canonicalRoot)}.lock`);
  }

  async observe(context: MutationContext, path: string): Promise<FileObservation> {
    this.validateContextForWorkspace(context);
    const relativePath = normalizeRelativePath(this.canonicalRoot, path);
    await assertRootIsStillBound(this.workspace.path, this.canonicalRoot);
    const fullPath = join(this.canonicalRoot, ...relativePath.split(sep));
    await assertNoSymlinkAncestors(this.canonicalRoot, fullPath, relativePath);

    let state;
    try {
      state = await observeFileState(fullPath);
    } catch (cause) {
      throw ioFailure(`failed to observe ${relativePath}`, cause, relativePath);
    }

    const observation: StoredObservation = {
      ...fileStateOnly(state),
      workspaceId: context.workspaceId,
      candidateId: context.candidateId,
      generationId: context.generationId,
      operationId: context.operationId,
      observationId: randomUUID(),
      ...(context.invocationId === undefined ? {} : { invocationId: context.invocationId }),
      ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
      ...(context.attemptId === undefined ? {} : { attemptId: context.attemptId }),
      ...(context.role === undefined ? {} : { role: context.role }),
      ...(context.validatedIdentity === undefined ? {} : { validatedIdentity: context.validatedIdentity }),
      path: relativePath,
      bytes: state.bytes === null ? null : Buffer.from(state.bytes),
    };
    this.observations.set(observation.observationId, observation);
    return {
      ...observation,
      bytes: observation.bytes === null ? null : Buffer.from(observation.bytes),
    };
  }

  async create(context: MutationContext, observation: FileObservation, content: MutationBytes): Promise<MutationResult> {
    return this.apply(context, { kind: "create", path: observation.path, observation, content });
  }

  async replace(
    context: MutationContext,
    observation: FileObservation,
    content: ReplacementContent,
  ): Promise<MutationResult> {
    return this.apply(context, { kind: "replace", path: observation.path, observation, content });
  }

  async delete(context: MutationContext, observation: FileObservation): Promise<MutationResult> {
    return this.apply(context, { kind: "delete", path: observation.path, observation });
  }

  async apply(context: MutationContext, operation: MutationOperation): Promise<MutationResult> {
    const results = await this.applyBatch(context, [operation]);
    return results[0]!;
  }

  async applyBatch(context: MutationContext, operations: readonly MutationOperation[]): Promise<readonly MutationResult[]> {
    this.validateContextForWorkspace(context);
    if (operations.length === 0) throw validation("mutation batch must contain at least one operation");
    const entries = operations.map((operation) => ({
      operation,
      stored: this.validateOperation(context, operation),
    }));
    const paths = entries.map(({ stored }) => stored.path);
    for (let i = 0; i < paths.length; i += 1) {
      for (let j = i + 1; j < paths.length; j += 1) {
        const left = paths[i]!;
        const right = paths[j]!;
        if (
          left === right ||
          left.startsWith(`${right}${sep}`) ||
          right.startsWith(`${left}${sep}`)
        ) {
          throw validation(`mutation batch paths overlap: ${left} and ${right}`);
        }
      }
    }
    const lockPath = operations[0]?.path ?? "<batch>";

    try {
      return await this.locks.withLock(
        `workspace-mutation:${lockIdentity(this.canonicalRoot)}`,
        async () => this.applyBatchUnderLock(context, entries),
        {
          timeoutMs: this.options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
          staleMs: this.options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS,
          file: this.lockFile,
        },
      );
    } catch (cause) {
      if (cause instanceof MutationError) throw cause;
      if (cause instanceof SubstrateError && cause.kind === "lock_timeout") {
        throw new MutationError("MUTATION_LOCK", `failed to acquire mutation lock for ${lockPath}`, {
          path: lockPath,
          cause,
        });
      }
      throw ioFailure(`mutation batch failed for ${lockPath}`, cause, lockPath);
    }
  }

  private validateContextForWorkspace(context: MutationContext): void {
    validateContext(context);
    if (context.workspaceId !== this.workspace.id) {
      throw validation(`mutation context belongs to workspace ${context.workspaceId}, not ${this.workspace.id}`);
    }
  }

  private validateOperation(context: MutationContext, operation: MutationOperation): StoredObservation {
    if (operation === null || typeof operation !== "object") throw validation("mutation operation is required");
    validateNonEmpty(operation.path, "path");
    const supplied = operation.observation;
    if (supplied === null || typeof supplied !== "object") throw validation("mutation observation is required", operation.path);
    const stored = this.observations.get(supplied.observationId);
    if (stored === undefined) throw validation(`unknown observation ${supplied.observationId}`, operation.path);
    if (
      supplied.workspaceId !== stored.workspaceId ||
      supplied.candidateId !== stored.candidateId ||
      supplied.generationId !== stored.generationId ||
      supplied.operationId !== stored.operationId ||
      supplied.invocationId !== stored.invocationId ||
      supplied.requestId !== stored.requestId ||
      supplied.attemptId !== stored.attemptId ||
      supplied.role !== stored.role ||
      supplied.validatedIdentity !== stored.validatedIdentity ||
      supplied.path !== stored.path ||
      !sameFileState(supplied, stored) ||
      !bytesEqual(supplied.bytes, stored.bytes)
    ) {
      throw validation(`observation ${supplied.observationId} was altered`, operation.path);
    }
    if (
      stored.workspaceId !== context.workspaceId ||
      stored.candidateId !== context.candidateId ||
      stored.generationId !== context.generationId
    ) {
      throw validation(`observation ${stored.observationId} is not bound to the mutation context`, operation.path);
    }
    if (operation.path !== stored.path) throw validation(`operation path differs from observation path`, operation.path);

    const operationKind = (operation as { readonly kind?: unknown }).kind;
    if (operationKind !== "create" && operationKind !== "replace" && operationKind !== "delete") {
      throw validation(`unsupported mutation operation kind`, operation.path);
    }
    if (!expectedKindAllowed(operation.kind, stored.kind)) {
      throw validation(`${operation.kind} requires an allowed observed state at ${operation.path}`, operation.path);
    }
    if (operation.kind === "create" && !(operation.content instanceof Uint8Array)) {
      throw validation(`create content must be bytes for ${operation.path}`, operation.path);
    }
    if (operation.kind === "replace" && typeof operation.content !== "function" && !(operation.content instanceof Uint8Array)) {
      throw validation(`replace content must be bytes or a byte transformer for ${operation.path}`, operation.path);
    }
    return stored;
  }

  private async applyBatchUnderLock(
    context: MutationContext,
    entries: readonly { readonly operation: MutationOperation; readonly stored: StoredObservation }[],
  ): Promise<readonly MutationResult[]> {
    await assertRootIsStillBound(this.workspace.path, this.canonicalRoot);
    const prepared: PreparedMutation[] = [];

    // Re-confine, read, compare, and compute every result before touching any
    // path. A stale member therefore leaves the complete batch untouched.
    for (const entry of entries) {
      const relativePath = normalizeRelativePath(this.canonicalRoot, entry.operation.path);
      if (relativePath !== entry.stored.path) {
        throw validation(`operation path changed during re-confinement`, entry.operation.path);
      }
      const fullPath = join(this.canonicalRoot, ...relativePath.split(sep));
      await assertNoSymlinkAncestors(this.canonicalRoot, fullPath, relativePath);

      let current: ObservedFileState;
      try {
        current = await observeFileState(fullPath);
      } catch (cause) {
        throw ioFailure(`failed to inspect current state of ${relativePath}`, cause, relativePath);
      }
      const currentState = fileStateOnly(current);
      const expectedState = fileStateOnly(entry.stored);
      if (current.kind === "symlink" && expectedState.kind !== "symlink") {
        throw confinement(`target became a symlink after observation: ${relativePath}`, relativePath);
      }
      if (!sameFileState(currentState, expectedState)) {
        throw new StaleMutationError(relativePath, expectedState, currentState);
      }

      const resultBytes = entry.operation.kind === "delete"
        ? null
        : operationContent(entry.operation, entry.stored);
      prepared.push({
        operation: entry.operation,
        stored: entry.stored,
        relativePath,
        fullPath,
        current,
        resultBytes,
      });
    }

    const createdDirectories: string[] = [];
    try {
      for (const entry of prepared) {
        if (entry.operation.kind !== "delete") {
          createdDirectories.push(...await ensureParentDirectories(
            this.canonicalRoot,
            entry.fullPath,
            entry.relativePath,
          ));
        }
      }

      for (const entry of prepared) await applyPreparedMutation(entry);

      const afterStates: FileState[] = [];
      for (const entry of prepared) {
        let afterObserved: ObservedFileState;
        try {
          afterObserved = await observeFileState(entry.fullPath);
        } catch (cause) {
          throw ioFailure(`failed to verify ${entry.relativePath}`, cause, entry.relativePath);
        }
        const after = fileStateOnly(afterObserved);
        const expectedAfter = expectedAfterState(entry);
        if (!sameFileState(after, expectedAfter)) {
          throw ioFailure(`post-mutation state verification failed for ${entry.relativePath}`, undefined, entry.relativePath);
        }
        afterStates.push(after);
      }

      return prepared.map((entry, index) => ({
        operationId: context.operationId,
        observationId: entry.stored.observationId,
        workspaceId: context.workspaceId,
        candidateId: context.candidateId,
        generationId: context.generationId,
        actor: context.actor,
        cause: context.cause,
        ...(context.invocationId === undefined ? {} : { invocationId: context.invocationId }),
        ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
        ...(context.attemptId === undefined ? {} : { attemptId: context.attemptId }),
        ...(context.role === undefined ? {} : { role: context.role }),
        ...(context.validatedIdentity === undefined ? {} : { validatedIdentity: context.validatedIdentity }),
        path: entry.relativePath,
        kind: entry.operation.kind,
        before: fileStateOnly(entry.current),
        after: afterStates[index]!,
      }));
    } catch (cause) {
      try {
        await rollbackPreparedMutations(prepared);
        await removeCreatedDirectories(createdDirectories);
      } catch (rollbackCause) {
        throw ioFailure(
          `mutation batch failed and rollback was incomplete`,
          rollbackCause,
          prepared[0]?.relativePath,
        );
      }
      if (cause instanceof MutationError) throw cause;
      throw ioFailure(`mutation batch failed`, cause, prepared[0]?.relativePath);
    }
  }
}

async function ensureParentDirectories(root: string, target: string, requestedPath: string): Promise<string[]> {
  const parentRelative = relative(root, dirname(target));
  if (parentRelative.length === 0) return [];

  const created: string[] = [];
  let current = root;
  for (const component of parentRelative.split(sep)) {
    if (component.length === 0) continue;
    current = join(current, component);
    let entry;
    try {
      entry = await lstat(current);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        throw ioFailure(`failed to inspect parent of ${requestedPath}`, cause, requestedPath);
      }
      try {
        await mkdir(current);
        created.push(current);
      } catch (mkdirCause) {
        if ((mkdirCause as NodeJS.ErrnoException).code !== "EEXIST") {
          throw ioFailure(`failed to create parent of ${requestedPath}`, mkdirCause, requestedPath);
        }
        try {
          entry = await lstat(current);
        } catch (inspectCause) {
          throw ioFailure(`failed to recheck parent of ${requestedPath}`, inspectCause, requestedPath);
        }
      }
    }
    if (entry !== undefined) {
      if (entry.isSymbolicLink()) throw confinement(`symlink parent is not allowed: ${requestedPath}`, requestedPath);
      if (!entry.isDirectory()) throw confinement(`non-directory parent is not allowed: ${requestedPath}`, requestedPath);
    }
  }
  return created;
}

async function applyPreparedMutation(entry: PreparedMutation): Promise<void> {
  try {
    if (entry.operation.kind === "delete") {
      if (entry.current.kind === "directory") await rmdir(entry.fullPath);
      else await unlink(entry.fullPath);
      return;
    }
    const resultBytes = entry.resultBytes;
    if (resultBytes === null) throw validation(`missing result bytes for ${entry.relativePath}`, entry.relativePath);
    await atomicWriteFile(entry.fullPath, resultBytes, {
      fsync: true,
      mode: entry.current.mode === null ? 0o600 : entry.current.mode & 0o7777,
    });
  } catch (cause) {
    if (cause instanceof MutationError) throw cause;
    throw ioFailure(`failed to apply ${entry.operation.kind} at ${entry.relativePath}`, cause, entry.relativePath);
  }
}

function expectedAfterState(entry: PreparedMutation): FileState {
  if (entry.operation.kind === "delete") {
    return {
      kind: "missing",
      byteLength: null,
      sha256: null,
      symlinkTarget: null,
      mode: null,
    };
  }
  const resultBytes = entry.resultBytes;
  if (resultBytes === null) throw validation(`missing result bytes for ${entry.relativePath}`, entry.relativePath);
  return {
    kind: resultKind(resultBytes.byteLength),
    byteLength: resultBytes.byteLength,
    sha256: sha256Bytes(resultBytes),
    symlinkTarget: null,
    mode: entry.current.mode,
  };
}

async function removeExistingPath(filePath: string): Promise<void> {
  const current = await observeFileState(filePath);
  if (current.kind === "missing") return;
  if (current.kind === "directory") await rmdir(filePath);
  else await unlink(filePath);
}

async function restorePreparedMutation(entry: PreparedMutation): Promise<void> {
  if (entry.operation.kind === "create") {
    await removeExistingPath(entry.fullPath);
    return;
  }

  if (entry.operation.kind === "replace") {
    if (entry.stored.bytes === null) throw new Error(`no observed bytes to restore ${entry.relativePath}`);
    await atomicWriteFile(entry.fullPath, entry.stored.bytes, {
      fsync: true,
      mode: entry.stored.mode === null ? 0o600 : entry.stored.mode & 0o7777,
    });
    return;
  }

  if (entry.stored.kind === "directory") {
    const current = await observeFileState(entry.fullPath);
    if (current.kind === "missing") await mkdir(entry.fullPath);
    else if (current.kind !== "directory") {
      await removeExistingPath(entry.fullPath);
      await mkdir(entry.fullPath);
    }
    return;
  }
  if (entry.stored.kind === "symlink") {
    await removeExistingPath(entry.fullPath);
    if (entry.stored.symlinkTarget === null) throw new Error(`no symlink target to restore ${entry.relativePath}`);
    await symlink(entry.stored.symlinkTarget, entry.fullPath);
    return;
  }
  if (entry.stored.bytes === null) throw new Error(`no observed bytes to restore ${entry.relativePath}`);
  await atomicWriteFile(entry.fullPath, entry.stored.bytes, {
    fsync: true,
    mode: entry.stored.mode === null ? 0o600 : entry.stored.mode & 0o7777,
  });
}

async function rollbackPreparedMutations(entries: readonly PreparedMutation[]): Promise<void> {
  for (let i = entries.length - 1; i >= 0; i -= 1) await restorePreparedMutation(entries[i]!);
}

async function removeCreatedDirectories(directories: readonly string[]): Promise<void> {
  for (let i = directories.length - 1; i >= 0; i -= 1) {
    try {
      await rmdir(directories[i]!);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw cause;
    }
  }
}

function resultKind(byteLength: number | null): "empty" | "regular" {
  return byteLength === 0 ? "empty" : "regular";
}

/** Create the state-bound mutation core for an allocated managed workspace. */
export async function createWorkspaceMutation(
  workspace: WorkspaceHandle,
  options: WorkspaceMutationOptions = {},
): Promise<WorkspaceMutation> {
  // WorkspaceManager allocates IDs using its stricter public naming contract.
  // The mutation core may also be given an already-managed/injected handle by
  // replay and test harnesses, so its responsibility here is to bind the
  // exact supplied identity, not to reapply the allocation policy.  Keep the
  // identity non-empty and NUL-free because it is carried through every
  // observation and mutation result.
  validateNonEmpty(workspace.id, "workspace.id");
  if (workspace.state !== "allocated") {
    throw policy(`workspace ${workspace.id} is not allocated for candidate mutation`);
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(workspace.path);
  } catch (cause) {
    throw ioFailure(`failed to resolve managed workspace ${workspace.path}`, cause, workspace.path);
  }
  let entry;
  try {
    entry = await lstat(workspace.path);
  } catch (cause) {
    throw ioFailure(`failed to inspect managed workspace ${workspace.path}`, cause, workspace.path);
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw confinement(`managed workspace must be a real directory: ${workspace.path}`, workspace.path);
  }
  if (options.lockFile !== undefined) {
    const lockPath = resolve(options.lockFile);
    const lockRelative = relative(canonicalRoot, lockPath);
    const lockIsInsideWorkspace =
      lockRelative.length === 0 ||
      (lockRelative !== ".." && !lockRelative.startsWith(`..${sep}`));
    if (lockIsInsideWorkspace) {
      throw policy(`mutation lock file must be outside the managed workspace: ${options.lockFile}`);
    }
  }
  return new WorkspaceMutationCore(workspace, canonicalRoot, options);
}

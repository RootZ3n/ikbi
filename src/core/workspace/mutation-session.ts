/**
 * Session-scoped state-bound editing for managed candidate workspaces.
 *
 * `WorkspaceMutation` is the filesystem authority. This module is the smaller
 * observation/lifecycle layer used by textual tools: it keeps only the latest
 * complete observation for each normalized path, prevents observations from
 * crossing sessions, and turns text edits into complete byte replacements
 * before handing them to the Phase 1 core.
 */

import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

import type { WorkspaceHandle } from "./contract.js";
import {
  MutationError,
  STALE_MUTATION,
  createWorkspaceMutation,
  type FileObservation,
  type MutationActor,
  type MutationCause,
  type MutationErrorCode,
  type MutationResult,
  type WorkspaceMutation,
  type WorkspaceMutationOptions,
} from "./mutation.js";

/** Identity carried by one textual-tool observation session. */
export interface MutationSessionBinding {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly candidateId: string;
  readonly generationId: string;
  readonly actor: MutationActor;
  readonly cause: MutationCause;
  readonly requestId?: string;
  readonly attemptId?: string;
  readonly role?: string;
  readonly invocationId?: string;
  /** Stable validated identity when the caller has one; never invented for humans. */
  readonly validatedIdentity?: string;
  /** Optional in-process generation fence checked immediately before every write. */
  readonly assertActive?: () => void;
  /** Open a fresh generation for a retry or derived repair operation. */
  readonly fork?: (input: { readonly attemptId: string; readonly role: string; readonly suffix: string }) => MutationSessionBinding;
}

/** The opaque token retained by one session for one exact observation. */
export interface SessionObservation {
  readonly token: string;
  readonly observation: FileObservation;
  readonly bytes: Readonly<Uint8Array> | null;
}

/** Result of a raw observation. It may describe a missing/non-regular path. */
export interface RawObservationResult extends SessionObservation {
  readonly path: string;
}

/** Result of a textual read. `complete:false` never authorizes a whole-file edit. */
export interface TextReadResult extends RawObservationResult {
  readonly text?: string;
  readonly complete: boolean;
  readonly output: string;
}

/** A mutation result plus the exact bytes used to derive its before/after hashes. */
export interface BoundMutationResult {
  readonly mutation: MutationResult;
  readonly beforeBytes: Readonly<Uint8Array>;
  readonly afterBytes: Readonly<Uint8Array>;
}

export interface TextBatchEdit {
  readonly path: string;
  readonly transform: (observedText: string) => string;
}

export interface TextPreview {
  readonly path: string;
  readonly before: string;
  readonly content: string;
  readonly baseSha256: string;
}

/** A byte operation supplied by an immutable repair plan. */
export interface SessionByteMutation {
  readonly path: string;
  readonly observationToken: string;
  readonly observationId: string;
  readonly kind: "create" | "replace" | "delete";
  readonly content?: Readonly<Uint8Array>;
}

/** Structured, stable error data surfaced by builder and chat textual tools. */
export interface MutationToolError {
  readonly code: MutationErrorCode;
  readonly path?: string;
  readonly workspaceId: string;
  readonly candidateId: string;
  readonly generationId: string;
  readonly mutationApplied: false;
  readonly retryGuidance: string;
  readonly message: string;
}

/** The interface shared by builder, chat, notebook, and delegated text tools. */
export interface MutationSessionLike {
  readonly binding: MutationSessionBinding;
  hasObservation(path: string): boolean;
  currentObservation(path: string): RawObservationResult | undefined;
  observeBytes(path: string): Promise<RawObservationResult>;
  readText(path: string, maxBytes: number): Promise<TextReadResult>;
  discardObservation(path: string): void;
  writeText(path: string, content: string): Promise<BoundMutationResult>;
  replaceText(path: string, transform: (observedText: string) => string): Promise<BoundMutationResult>;
  replaceBytes(path: string, content: Uint8Array): Promise<BoundMutationResult>;
  applyTextBatch(edits: readonly TextBatchEdit[]): Promise<readonly BoundMutationResult[]>;
  applyByteBatch(edits: readonly SessionByteMutation[], operationId?: string): Promise<readonly BoundMutationResult[]>;
  createBytes(path: string, content: Uint8Array): Promise<BoundMutationResult>;
  deleteFile(path: string): Promise<BoundMutationResult>;
  previewText(path: string, transform: (observedText: string) => string): Promise<TextPreview>;
  previewWrite(path: string, content: string): Promise<TextPreview>;
}

interface StoredSessionObservation extends SessionObservation {
  readonly key: string;
  readonly bytes: Buffer | null;
}

function nonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new MutationError("MUTATION_VALIDATION", `${label} must be a non-empty string without NUL bytes`);
  }
}

function validation(message: string, path?: string): MutationError {
  return new MutationError("MUTATION_VALIDATION", message, path === undefined ? undefined : { path });
}

function normalizedPath(root: string, requestedPath: string): string {
  nonEmpty(requestedPath, "path");
  if (isAbsolute(requestedPath) || win32.isAbsolute(requestedPath)) {
    throw new MutationError("MUTATION_CONFINEMENT", `absolute path is outside the managed workspace: ${requestedPath}`, { path: requestedPath });
  }
  const resolved = resolve(root, requestedPath);
  const rel = relative(root, resolved);
  if (rel.length === 0 || rel === "." || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new MutationError("MUTATION_CONFINEMENT", `path escapes the managed workspace: ${requestedPath}`, { path: requestedPath });
  }
  return rel;
}

function keyFor(path: string): string {
  return path.split(sep).join("/");
}

function asBytes(value: Uint8Array, path: string): Buffer {
  if (!(value instanceof Uint8Array)) throw validation(`replacement content must be bytes for ${path}`, path);
  return Buffer.from(value);
}

function decodeText(bytes: Readonly<Uint8Array>, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw validation(`textual editing requires valid UTF-8 content at ${path}; binary content was not rewritten`, path);
  }
}

function hash(bytes: Readonly<Uint8Array>): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function retryGuidance(code: MutationErrorCode): string {
  if (code === STALE_MUTATION) return "Re-read the file and regenerate the edit; no mutation was applied.";
  if (code === "MUTATION_LOCK") return "Retry after the workspace mutation lock is available; no mutation was applied.";
  return "Correct the precondition or path and retry; no mutation was applied.";
}

/** Convert any mutation failure into stable machine-readable and human-readable output. */
export function mutationToolError(
  error: unknown,
  binding: MutationSessionBinding,
  path?: string,
): MutationToolError {
  const mutation = error instanceof MutationError ? error : undefined;
  const code = mutation?.code ?? "MUTATION_IO";
  const errorPath = mutation?.path ?? path;
  return {
    code,
    ...(errorPath === undefined ? {} : { path: errorPath }),
    workspaceId: binding.workspaceId,
    candidateId: binding.candidateId,
    generationId: binding.generationId,
    mutationApplied: false,
    retryGuidance: retryGuidance(code),
    message: error instanceof Error ? error.message : String(error),
  };
}

export function formatMutationToolError(
  error: unknown,
  binding: MutationSessionBinding,
  path?: string,
): string {
  const data = mutationToolError(error, binding, path);
  return `ERROR: ${data.code}: ${data.message}\n${JSON.stringify(data)}`;
}

/** A session that owns the observation registry for one managed candidate workspace. */
export class WorkspaceMutationSession implements MutationSessionLike {
  private readonly latestByPath = new Map<string, string>();
  private readonly observations = new Map<string, StoredSessionObservation>();

  private constructor(
    private readonly core: WorkspaceMutation,
    private readonly root: string,
    readonly binding: MutationSessionBinding,
  ) {}

  static async create(
    workspace: WorkspaceHandle,
    binding: MutationSessionBinding,
    options: WorkspaceMutationOptions = {},
  ): Promise<WorkspaceMutationSession> {
    nonEmpty(binding.sessionId, "sessionId");
    nonEmpty(binding.workspaceId, "workspaceId");
    nonEmpty(binding.candidateId, "candidateId");
    nonEmpty(binding.generationId, "generationId");
    nonEmpty(binding.actor, "actor");
    nonEmpty(binding.cause, "cause");
    if (binding.workspaceId !== workspace.id) {
      throw validation(`mutation session belongs to workspace ${binding.workspaceId}, not ${workspace.id}`);
    }
    const core = await createWorkspaceMutation(workspace, options);
    return new WorkspaceMutationSession(core, workspace.path, binding);
  }

  private context(operationId?: string): {
    workspaceId: string;
    candidateId: string;
    generationId: string;
    operationId: string;
    actor: MutationActor;
    cause: MutationCause;
    requestId?: string;
    attemptId?: string;
    role?: string;
    invocationId?: string;
    validatedIdentity?: string;
  } {
    return {
      workspaceId: this.binding.workspaceId,
      candidateId: this.binding.candidateId,
      generationId: this.binding.generationId,
      operationId: operationId ?? randomUUID(),
      actor: this.binding.actor,
      cause: this.binding.cause,
      ...(this.binding.requestId === undefined ? {} : { requestId: this.binding.requestId }),
      ...(this.binding.attemptId === undefined ? {} : { attemptId: this.binding.attemptId }),
      ...(this.binding.role === undefined ? {} : { role: this.binding.role }),
      ...(this.binding.invocationId === undefined ? {} : { invocationId: this.binding.invocationId }),
      ...(this.binding.validatedIdentity === undefined ? {} : { validatedIdentity: this.binding.validatedIdentity }),
    };
  }

  private pathKey(path: string): { key: string; normalized: string } {
    const normalized = normalizedPath(this.root, path);
    return { key: keyFor(normalized), normalized };
  }

  private latest(path: string): StoredSessionObservation | undefined {
    const { key } = this.pathKey(path);
    const token = this.latestByPath.get(key);
    if (token === undefined) return undefined;
    const record = this.observations.get(token);
    if (record === undefined || record.key !== key) return undefined;
    return record;
  }

  hasObservation(path: string): boolean {
    return this.latest(path) !== undefined;
  }

  currentObservation(path: string): RawObservationResult | undefined {
    const record = this.latest(path);
    if (record === undefined) return undefined;
    return {
      token: record.token,
      observation: { ...record.observation, bytes: record.bytes === null ? null : Buffer.from(record.bytes) },
      bytes: record.bytes === null ? null : Buffer.from(record.bytes),
      path: record.observation.path,
    };
  }

  private remember(observation: FileObservation): StoredSessionObservation {
    const token = randomUUID();
    const record: StoredSessionObservation = {
      token,
      observation: { ...observation, bytes: observation.bytes === null ? null : Buffer.from(observation.bytes) },
      bytes: observation.bytes === null ? null : Buffer.from(observation.bytes),
      key: keyFor(observation.path),
    };
    const prior = this.latestByPath.get(record.key);
    if (prior !== undefined) this.observations.delete(prior);
    this.observations.set(token, record);
    this.latestByPath.set(record.key, token);
    return record;
  }

  private consume(record: StoredSessionObservation): void {
    if (this.latestByPath.get(record.key) === record.token) this.latestByPath.delete(record.key);
    this.observations.delete(record.token);
  }

  private requireLatest(path: string): StoredSessionObservation {
    const record = this.latest(path);
    if (record === undefined) {
      throw validation(`complete read_file observation required before editing ${path}`, path);
    }
    return record;
  }

  private async observeAndGet(path: string): Promise<StoredSessionObservation> {
    await this.observeBytes(path);
    return this.requireLatest(path);
  }

  private requireRegular(record: StoredSessionObservation): Buffer {
    if ((record.observation.kind !== "empty" && record.observation.kind !== "regular") || record.bytes === null) {
      throw validation(`textual editing requires an observed regular file at ${record.observation.path}`, record.observation.path);
    }
    return Buffer.from(record.bytes);
  }

  async observeBytes(path: string): Promise<RawObservationResult> {
    const observation = await this.core.observe(this.context(), path);
    const record = this.remember(observation);
    return {
      token: record.token,
      observation: { ...record.observation, bytes: record.bytes === null ? null : Buffer.from(record.bytes) },
      bytes: record.bytes === null ? null : Buffer.from(record.bytes),
      path: observation.path,
    };
  }

  async readText(path: string, maxBytes: number): Promise<TextReadResult> {
    const raw = await this.observeBytes(path);
    if (raw.observation.kind === "missing") {
      this.discardObservation(path);
      throw validation(`read failed: file does not exist at ${raw.path}`, raw.path);
    }
    if ((raw.observation.kind !== "empty" && raw.observation.kind !== "regular") || raw.bytes === null) {
      this.discardObservation(path);
      throw validation(`read failed: ${raw.path} is not a regular text file`, raw.path);
    }
    let text: string;
    try {
      text = decodeText(raw.bytes, raw.path);
    } catch (error) {
      this.discardObservation(path);
      throw error;
    }
    if (raw.bytes.byteLength > maxBytes || text.length > maxBytes) {
      this.discardObservation(path);
      return {
        ...raw,
        complete: false,
        output: `${text.slice(0, maxBytes)}\n\n[truncated — showed the first ${maxBytes} of ${text.length} characters of ${raw.path}. A truncated read does not authorize whole-file replacement.]`,
      };
    }
    return { ...raw, text, complete: true, output: text };
  }

  discardObservation(path: string): void {
    try {
      const { key } = this.pathKey(path);
      const token = this.latestByPath.get(key);
      if (token !== undefined) {
        this.latestByPath.delete(key);
        this.observations.delete(token);
      }
    } catch {
      // The caller is already handling an invalid path; there is no authority to retain.
    }
  }

  private async applyReplace(record: StoredSessionObservation, afterBytes: Uint8Array): Promise<BoundMutationResult> {
    this.assertActive();
    const beforeBytes = this.requireRegular(record);
    const content = asBytes(afterBytes, record.observation.path);
    try {
      const mutation = await this.core.replace(this.context(), record.observation, content);
      this.consume(record);
      return { mutation, beforeBytes, afterBytes: Buffer.from(content) };
    } catch (error) {
      // A failed apply must not leave a possibly stale token available for reuse.
      if (error instanceof MutationError) this.consume(record);
      throw error;
    }
  }

  private async applyCreate(record: StoredSessionObservation, content: Uint8Array): Promise<BoundMutationResult> {
    this.assertActive();
    if (record.observation.kind !== "missing") {
      throw validation(`create requires an observed missing state at ${record.observation.path}`, record.observation.path);
    }
    const afterBytes = asBytes(content, record.observation.path);
    try {
      const mutation = await this.core.create(this.context(), record.observation, afterBytes);
      this.consume(record);
      return { mutation, beforeBytes: Buffer.alloc(0), afterBytes: Buffer.from(afterBytes) };
    } catch (error) {
      if (error instanceof MutationError) this.consume(record);
      throw error;
    }
  }

  async writeText(path: string, content: string): Promise<BoundMutationResult> {
    const bytes = Buffer.from(content, "utf8");
    let record = this.latest(path);
    if (record === undefined) {
      // This is an explicit create-intent observation. It may authorize CREATE only;
      // an existing file is never silently reread and replaced.
      record = await this.observeAndGet(path);
      if (record.observation.kind !== "missing") {
        this.discardObservation(path);
        throw validation(
          `existing file ${record.observation.path} requires a complete read_file observation before write_file`,
          record.observation.path,
        );
      }
    }
    if (record.observation.kind === "missing") return this.applyCreate(record, bytes);
    return this.applyReplace(record, bytes);
  }

  async createBytes(path: string, content: Uint8Array): Promise<BoundMutationResult> {
    let record = this.latest(path);
    if (record === undefined) record = await this.observeAndGet(path);
    return this.applyCreate(record, content);
  }

  async replaceBytes(path: string, content: Uint8Array): Promise<BoundMutationResult> {
    return this.applyReplace(this.requireLatest(path), content);
  }

  async replaceText(path: string, transform: (observedText: string) => string): Promise<BoundMutationResult> {
    const record = this.requireLatest(path);
    const before = decodeText(this.requireRegular(record), record.observation.path);
    let after: string;
    try {
      after = transform(before);
    } catch (error) {
      throw error;
    }
    if (typeof after !== "string") throw validation(`text replacement must return a string for ${record.observation.path}`, record.observation.path);
    return this.applyReplace(record, Buffer.from(after, "utf8"));
  }

  async applyTextBatch(edits: readonly TextBatchEdit[]): Promise<readonly BoundMutationResult[]> {
    if (edits.length === 0) throw validation("text mutation batch must contain at least one edit");
    const prepared = edits.map((edit) => {
      const record = this.requireLatest(edit.path);
      const beforeBytes = this.requireRegular(record);
      const before = decodeText(beforeBytes, record.observation.path);
      const after = edit.transform(before);
      if (typeof after !== "string") throw validation(`text replacement must return a string for ${record.observation.path}`, record.observation.path);
      return { record, beforeBytes, afterBytes: Buffer.from(after, "utf8") };
    });
    try {
      const mutations = await this.core.applyBatch(
        this.context(),
        prepared.map(({ record, afterBytes }) => ({
          kind: "replace" as const,
          path: record.observation.path,
          observation: record.observation,
          content: afterBytes,
        })),
      );
      for (const entry of prepared) this.consume(entry.record);
      return mutations.map((mutation, index) => ({
        mutation,
        beforeBytes: prepared[index]!.beforeBytes,
        afterBytes: prepared[index]!.afterBytes,
      }));
    } catch (error) {
      if (error instanceof MutationError) for (const entry of prepared) this.consume(entry.record);
      throw error;
    }
  }

  async deleteFile(path: string): Promise<BoundMutationResult> {
    this.assertActive();
    const record = this.requireLatest(path);
    const beforeBytes = record.bytes === null ? Buffer.alloc(0) : Buffer.from(record.bytes);
    try {
      const mutation = await this.core.delete(this.context(), record.observation);
      this.consume(record);
      return { mutation, beforeBytes, afterBytes: Buffer.alloc(0) };
    } catch (error) {
      if (error instanceof MutationError) this.consume(record);
      throw error;
    }
  }

  private assertActive(): void {
    try {
      this.binding.assertActive?.();
    } catch (error) {
      if (error instanceof MutationError) throw error;
      throw new MutationError("MUTATION_POLICY", error instanceof Error ? error.message : String(error));
    }
  }

  async applyByteBatch(edits: readonly SessionByteMutation[], operationId?: string): Promise<readonly BoundMutationResult[]> {
    if (edits.length === 0) throw validation("byte mutation batch must contain at least one edit");
    this.assertActive();
    const prepared = edits.map((edit) => {
      const record = this.latest(edit.path);
      if (record === undefined || record.token !== edit.observationToken || record.observation.observationId !== edit.observationId) {
        throw validation(`repair plan observation is not the latest observation for ${edit.path}`, edit.path);
      }
      const content = edit.kind === "delete" ? undefined : asBytes(edit.content ?? new Uint8Array(), record.observation.path);
      if (edit.kind === "create" && record.observation.kind !== "missing") {
        throw validation(`create requires an observed missing state at ${record.observation.path}`, record.observation.path);
      }
      if (edit.kind === "replace" && record.observation.kind !== "empty" && record.observation.kind !== "regular") {
        throw validation(`replace requires an observed regular file at ${record.observation.path}`, record.observation.path);
      }
      if (edit.kind === "delete" && record.observation.kind === "missing") {
        throw validation(`delete requires an observed existing state at ${record.observation.path}`, record.observation.path);
      }
      return { edit, record, content };
    });
    try {
      const mutations = await this.core.applyBatch(
        this.context(operationId),
        prepared.map(({ edit, record, content }) => edit.kind === "create"
          ? { kind: "create" as const, path: record.observation.path, observation: record.observation, content: content! }
          : edit.kind === "replace"
            ? { kind: "replace" as const, path: record.observation.path, observation: record.observation, content: content! }
            : { kind: "delete" as const, path: record.observation.path, observation: record.observation }),
      );
      for (const { record } of prepared) this.consume(record);
      return mutations.map((mutation, index) => ({
        mutation,
        beforeBytes: prepared[index]!.record.bytes === null ? Buffer.alloc(0) : Buffer.from(prepared[index]!.record.bytes!),
        afterBytes: prepared[index]!.content === undefined ? Buffer.alloc(0) : Buffer.from(prepared[index]!.content!),
      }));
    } catch (error) {
      if (error instanceof MutationError) for (const { record } of prepared) this.consume(record);
      throw error;
    }
  }

  async previewText(path: string, transform: (observedText: string) => string): Promise<TextPreview> {
    let record = this.latest(path);
    if (record === undefined) {
      record = await this.observeAndGet(path);
      if (record.observation.kind !== "missing") {
        this.discardObservation(path);
        throw validation(
          `existing file ${record.observation.path} requires a complete read_file observation before a proposal`,
          record.observation.path,
        );
      }
    }
    if (record.observation.kind === "missing") {
      const content = transform("");
      return { path: record.observation.path, before: "", content, baseSha256: hash(Buffer.alloc(0)) };
    }
    const before = decodeText(this.requireRegular(record), record.observation.path);
    const content = transform(before);
    if (typeof content !== "string") {
      throw validation(
        `text replacement must return a string for ${record.observation.path}`,
        record.observation.path,
      );
    }
    return {
      path: record.observation.path,
      before,
      content,
      baseSha256: hash(Buffer.from(record.bytes!)),
    };
  }

  async previewWrite(path: string, content: string): Promise<TextPreview> {
    return this.previewText(path, () => content);
  }
}

/** Create one state-bound observation session for an allocated managed workspace. */
export async function createWorkspaceMutationSession(
  workspace: WorkspaceHandle,
  binding: MutationSessionBinding,
  options: WorkspaceMutationOptions = {},
): Promise<WorkspaceMutationSession> {
  return WorkspaceMutationSession.create(workspace, binding, options);
}

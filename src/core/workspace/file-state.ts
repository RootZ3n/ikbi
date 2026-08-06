/**
 * Exact filesystem state used by the state-bound workspace mutation core.
 *
 * This module deliberately observes a path without following the final
 * symlink. Regular-file bytes are retained in the observation so a mutation
 * can derive its complete result from the bytes that were actually observed.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";

/** The filesystem kinds that the mutation core distinguishes. */
export type FileStateKind = "missing" | "empty" | "regular" | "directory" | "symlink";

/** A hash-and-size identity for a path, including its non-regular kind. */
export interface FileState {
  readonly kind: FileStateKind;
  /** Raw byte length for regular files and symlink targets; null otherwise. */
  readonly byteLength: number | null;
  /** SHA-256 of raw file bytes or raw symlink-target bytes; null otherwise. */
  readonly sha256: string | null;
  /** The raw symlink target, retained only for symlink observations. */
  readonly symlinkTarget: string | null;
  /** Existing regular-file mode, used to preserve permissions on replacement. */
  readonly mode: number | null;
}

/** A state plus the exact bytes read for a regular file. */
export interface ObservedFileState extends FileState {
  /** A defensive copy of the exact bytes observed, or null for non-regular paths. */
  readonly bytes: Readonly<Uint8Array> | null;
}

/** SHA-256 of exactly the supplied bytes. */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Compare state identities without treating file mode as content identity. */
export function sameFileState(left: FileState, right: FileState): boolean {
  return (
    left.kind === right.kind &&
    left.byteLength === right.byteLength &&
    left.sha256 === right.sha256 &&
    left.symlinkTarget === right.symlinkTarget
  );
}

function missingState(): ObservedFileState {
  return {
    kind: "missing",
    byteLength: null,
    sha256: null,
    symlinkTarget: null,
    mode: null,
    bytes: null,
  };
}

/**
 * Observe a path using lstat semantics. A regular file is opened with
 * O_NOFOLLOW and read through its descriptor; a final symlink is represented
 * as a symlink rather than being followed.
 */
export async function observeFileState(filePath: string): Promise<ObservedFileState> {
  let entry;
  try {
    entry = await lstat(filePath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return missingState();
    throw cause;
  }

  if (entry.isSymbolicLink()) {
    const bytes = Buffer.from(await readlink(filePath, { encoding: "buffer" }));
    const target = bytes.toString("utf8");
    return {
      kind: "symlink",
      byteLength: bytes.byteLength,
      sha256: sha256Bytes(bytes),
      symlinkTarget: target,
      mode: entry.mode,
      bytes: null,
    };
  }

  if (entry.isDirectory()) {
    return {
      kind: "directory",
      byteLength: null,
      sha256: null,
      symlinkTarget: null,
      mode: entry.mode,
      bytes: null,
    };
  }

  if (!entry.isFile()) {
    // The mutation contract does not silently treat sockets, devices, or
    // FIFOs as regular files. They are represented as an unsupported regular
    // kind at the boundary by failing closed.
    throw new Error(`unsupported filesystem entry at ${filePath}`);
  }

  const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollow);
    const descriptorState = await handle.stat();
    if (!descriptorState.isFile()) throw new Error(`path changed while observing ${filePath}`);
    const bytes = Buffer.from(await handle.readFile());
    return {
      kind: bytes.byteLength === 0 ? "empty" : "regular",
      byteLength: bytes.byteLength,
      sha256: sha256Bytes(bytes),
      symlinkTarget: null,
      mode: descriptorState.mode,
      bytes,
    };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return missingState();
    throw cause;
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
}

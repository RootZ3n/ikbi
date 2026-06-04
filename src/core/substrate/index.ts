/**
 * ikbi concurrency-safe substrate — public surface (frozen core).
 *
 * The canonical, process-wide mechanism for safe shared-state access. Use:
 *
 *     await atomicWriteJson(path, value);                    // never a torn write
 *     await locks.withLock(key, fn, { file });               // serialize callers
 *     await readModifyWrite(path, (cur) => next, deps);      // no lost updates
 *     const store = createDocumentStore<T>({ dir });         // JSON doc store
 *
 * The default `locks` (in-process mutex + file-lock manager) and the store/log
 * factories are wired from `config`. Nothing in the engine hand-rolls file writes
 * or locks — the receipt store, trust store, registry persistence and workspace
 * allocation all build on this.
 *
 * Cross-process semantics (precise): the DEFAULT provides in-process mutual
 * exclusion + atomic writes, which makes cross-process READS safe (a reader, even
 * in another process, never sees a torn write). Cross-process WRITE serialization
 * (no lost update across separate processes) is OPT-IN via `crossProcess: true` /
 * a `file` lock — used when the CLI and the service may write the same state.
 *
 * Two canonical persistence primitives:
 *   - `DocumentStore` / `createDocumentStore` — full-document RMW for small,
 *     document-oriented state (trust, workspace, registry snapshots).
 *   - `AtomicAppendLog` / `createAppendLog` — O(1) line-delimited-JSON appends for
 *     append-heavy ordered/audit state (receipts, event logs).
 */

import { config } from "../config.js";
import { childLogger } from "../log.js";
import { AtomicAppendLog, type AppendLogOptions } from "./append.js";
import { LockManager } from "./lock.js";
import { DocumentStore, type DocumentStoreOptions, readModifyWrite, type RmwDeps } from "./store.js";

const log = childLogger("substrate");

/** The process-wide lock manager (shared in-process mutex + file locks). */
export const locks = new LockManager({
  logger: log,
  defaultTimeoutMs: config.substrate.lockTimeoutMs,
  defaultStaleMs: config.substrate.lockStaleMs,
});

/** Create a document store wired to the default lock manager + logger + config. */
export function createDocumentStore<T>(
  opts: Omit<DocumentStoreOptions, "locks" | "logger"> & {
    locks?: DocumentStoreOptions["locks"];
    logger?: DocumentStoreOptions["logger"];
  },
): DocumentStore<T> {
  return new DocumentStore<T>({
    fsync: config.substrate.fsync,
    locks: opts.locks ?? locks,
    logger: opts.logger ?? log,
    ...opts,
  });
}

/** Create an append log wired to the default lock manager + logger + config. */
export function createAppendLog<T>(
  opts: Omit<AppendLogOptions, "locks" | "logger"> & {
    locks?: AppendLogOptions["locks"];
    logger?: AppendLogOptions["logger"];
  },
): AtomicAppendLog<T> {
  return new AtomicAppendLog<T>({
    fsync: config.substrate.fsync,
    locks: opts.locks ?? locks,
    logger: opts.logger ?? log,
    ...opts,
  });
}

/** A `readModifyWrite` bound to the default lock manager + logger + config. */
export function safeUpdate<T>(
  path: string,
  mutate: (current: T | undefined) => T | Promise<T>,
  opts?: Parameters<typeof readModifyWrite<T>>[3],
): Promise<T> {
  const deps: RmwDeps = { locks, logger: log, defaultFsync: config.substrate.fsync };
  return readModifyWrite<T>(path, mutate, deps, opts);
}

// --- re-export the canonical primitives + contract ---
export { atomicWriteFile, atomicWriteJson, sweepTempFiles, isTempFile, isCorruptSidecar, classifyDirFsyncError } from "./atomic.js";
export type { SweepOptions, AtomicWriteInternals } from "./atomic.js";
export { KeyedMutex, LockManager, acquireFileLock } from "./lock.js";
export type { AcquireOptions, LockManagerDeps, FileLockDeps } from "./lock.js";
export { DocumentStore, readModifyWrite, readJsonFile } from "./store.js";
export type { DocumentStoreOptions, RmwDeps } from "./store.js";
export { AtomicAppendLog } from "./append.js";
export type { AppendLogOptions, AppendResult, ReadResult } from "./append.js";
export {
  SUBSTRATE_CONTRACT_VERSION,
  SubstrateError,
  type AtomicWriteOptions,
  type CorruptPolicy,
  type LockOptions,
  type Release,
  type RmwOptions,
  type SubstrateErrorKind,
  type AppendReadOptions,
  type LogOffset,
} from "./contract.js";

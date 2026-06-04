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
 * The default `locks` (in-process mutex + file-lock manager) and `createDocumentStore`
 * are wired from `config`. Nothing in the engine hand-rolls file writes or locks —
 * the receipt store, trust store, registry persistence and workspace allocation
 * all build on this.
 */

import { config } from "../config.js";
import { childLogger } from "../log.js";
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
export { atomicWriteFile, atomicWriteJson, sweepTempFiles, isTempFile } from "./atomic.js";
export { KeyedMutex, LockManager, acquireFileLock } from "./lock.js";
export type { AcquireOptions, LockManagerDeps, FileLockDeps } from "./lock.js";
export { DocumentStore, readModifyWrite, readJsonFile } from "./store.js";
export type { DocumentStoreOptions, RmwDeps } from "./store.js";
export {
  SUBSTRATE_CONTRACT_VERSION,
  SubstrateError,
  type AtomicWriteOptions,
  type CorruptPolicy,
  type LockOptions,
  type Release,
  type RmwOptions,
  type SubstrateErrorKind,
} from "./contract.js";

/**
 * ikbi substrate — safe read-modify-write + a minimal document store.
 *
 * `readModifyWrite` is the canonical pattern the stateful stores (receipts,
 * trust, ...) use: read current -> modify -> atomic write, ALL under the lock, so
 * concurrent updates never lose a write (the classic "two callers increment, one
 * update lost" bug).
 *
 * `DocumentStore` is a thin, contract-clean JSON document store over a directory,
 * built on the atomic-write + locking primitives. Higher-level stores compose it
 * or use the primitives directly; nothing hand-rolls file writes or locks.
 */

import { readFile, unlink, readdir, rename } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Logger } from "pino";

import { atomicWriteJson, isTempFile, sweepTempFiles } from "./atomic.js";
import {
  type CorruptPolicy,
  type RmwOptions,
  SubstrateError,
} from "./contract.js";
import type { LockManager } from "./lock.js";

/** Read + parse a JSON file. Missing => undefined. Corrupt => per `policy`. */
export async function readJsonFile<T>(
  path: string,
  policy: CorruptPolicy,
  logger: Logger,
  now: () => number = Date.now,
): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SubstrateError("io", `failed to read ${path}`, { path, cause: err });
  }
  try {
    return JSON.parse(raw) as T;
  } catch (cause) {
    if (policy === "quarantine") {
      const aside = `${path}.corrupt.${now()}`;
      try {
        await rename(path, aside);
      } catch (renameCause) {
        // Quarantine FAILED — the corrupt file is still in place. Fail-closed:
        // higher layers must not treat a still-present corrupt file as "missing".
        logger.error({ event: "corrupt_state_quarantine_failed", path }, "failed to quarantine corrupt state file");
        throw new SubstrateError("corrupt_state", `failed to quarantine corrupt state file ${path}`, {
          path,
          cause: renameCause,
        });
      }
      logger.warn({ event: "corrupt_state_quarantined", path, aside }, "quarantined corrupt state file");
      return undefined;
    }
    logger.error({ event: "corrupt_state", path }, "corrupt state file (fail-closed)");
    throw new SubstrateError("corrupt_state", `corrupt JSON state file ${path}`, { path, cause });
  }
}

export interface RmwDeps {
  readonly locks: LockManager;
  readonly logger: Logger;
  readonly defaultFsync: boolean;
  readonly now?: () => number;
}

/**
 * Read the JSON at `path`, apply `mutate`, and write the result atomically — all
 * under the lock for `path`. Returns the new value. No lost updates under
 * concurrency. `mutate` receives `undefined` when the file does not yet exist.
 */
export async function readModifyWrite<T>(
  path: string,
  mutate: (current: T | undefined) => T | Promise<T>,
  deps: RmwDeps,
  opts?: RmwOptions,
): Promise<T> {
  const key = resolve(path);
  const corruptPolicy = opts?.corruptPolicy ?? "throw";
  const fsync = opts?.fsync ?? deps.defaultFsync;
  const acquire = {
    ...(opts?.lockTimeoutMs !== undefined ? { timeoutMs: opts.lockTimeoutMs } : {}),
    ...(opts?.crossProcess === true ? { file: `${key}.lock` } : {}),
  };
  return deps.locks.withLock(
    key,
    async () => {
      const current = await readJsonFile<T>(path, corruptPolicy, deps.logger, deps.now);
      const next = await mutate(current);
      await atomicWriteJson(path, next, { fsync });
      return next;
    },
    acquire,
  );
}

// ---------------------------------------------------------------------------
// DocumentStore
// ---------------------------------------------------------------------------

const DEFAULT_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const DOC_EXT = ".json";
/** Short lock budget for tolerant read-only reads before falling back to a lockless read. */
const READ_TOLERANT_LOCK_TIMEOUT_MS = 750;

export interface DocumentStoreOptions {
  readonly dir: string;
  readonly locks: LockManager;
  readonly logger: Logger;
  /** fsync writes. Defaults to true. */
  readonly fsync?: boolean;
  /** Also take cross-process file locks (when the CLI may touch the same store). Default false. */
  readonly crossProcess?: boolean;
  /** Corrupt-file handling. Default "throw" (fail-closed). */
  readonly corruptPolicy?: CorruptPolicy;
  /** Override the allowed id pattern (must reject path traversal). */
  readonly idPattern?: RegExp;
  readonly now?: () => number;
}

/** A minimal, concurrency-safe JSON document store keyed by id. */
export class DocumentStore<T> {
  private readonly dir: string;
  private readonly locks: LockManager;
  private readonly log: Logger;
  private readonly fsync: boolean;
  private readonly crossProcess: boolean;
  private readonly corruptPolicy: CorruptPolicy;
  private readonly idPattern: RegExp;
  private readonly now: () => number;

  constructor(opts: DocumentStoreOptions) {
    this.dir = opts.dir;
    this.locks = opts.locks;
    this.log = opts.logger;
    this.fsync = opts.fsync ?? true;
    this.crossProcess = opts.crossProcess ?? false;
    this.corruptPolicy = opts.corruptPolicy ?? "throw";
    this.idPattern = opts.idPattern ?? DEFAULT_ID_PATTERN;
    this.now = opts.now ?? Date.now;
  }

  /** Remove orphaned temp files from a prior crash. Safe to call on startup. */
  async sweep(): Promise<number> {
    return sweepTempFiles(this.dir);
  }

  /** Read a document. Missing => undefined. Corrupt => per policy. */
  async get(id: string): Promise<T | undefined> {
    const path = this.pathFor(id);
    return this.locks.withLock(path, () => readJsonFile<T>(path, this.corruptPolicy, this.log, this.now), this.acquireOpts(path));
  }

  /**
   * READ-ONLY tolerant read for status/inspection commands (Codex blocker 2). A document write is an
   * atomic rename, so a reader can never observe a torn file — the cross-process lock on a READ only
   * serializes against a writer that is mid-RMW. So under a LIVE cross-process lock (a running build
   * holding the registry) a read-only CLI must NOT hang for the full timeout and then crash with a raw
   * lock-acquisition error: it tries the lock with a SHORT timeout and, on contention, falls back to a
   * direct lockless read (still atomic-safe). Stale locks are recovered by the lock layer as usual.
   * Non-cross-process stores behave exactly like `get`.
   */
  async getTolerant(id: string): Promise<T | undefined> {
    const path = this.pathFor(id);
    if (!this.crossProcess) return this.get(id);
    try {
      return await this.locks.withLock(
        path,
        () => readJsonFile<T>(path, this.corruptPolicy, this.log, this.now),
        { file: `${path}.lock`, timeoutMs: READ_TOLERANT_LOCK_TIMEOUT_MS },
      );
    } catch (err) {
      if (err instanceof SubstrateError && err.kind === "lock_timeout") {
        // A LIVE writer holds the lock — degrade to a lockless read rather than crashing. The
        // atomic-rename write guarantees we still see a whole (old-or-new) document, never a torn one.
        this.log.warn({ event: "read_tolerant_lockless_fallback", path }, "read-only access fell back to a lockless read under a live lock");
        return readJsonFile<T>(path, this.corruptPolicy, this.log, this.now);
      }
      throw err;
    }
  }

  /** True if a document exists (does not validate its contents). */
  async has(id: string): Promise<boolean> {
    const v = await this.get(id).catch((e: unknown) => {
      if (e instanceof SubstrateError && e.kind === "corrupt_state") return undefined;
      throw e;
    });
    return v !== undefined;
  }

  /** Atomically write a document. */
  async put(id: string, value: T): Promise<void> {
    const path = this.pathFor(id);
    await this.locks.withLock(path, () => atomicWriteJson(path, value, { fsync: this.fsync }), this.acquireOpts(path));
  }

  /** Read-modify-write a document under its lock (no lost updates). */
  async update(id: string, mutate: (current: T | undefined) => T | Promise<T>): Promise<T> {
    const path = this.pathFor(id);
    return readModifyWrite<T>(
      path,
      mutate,
      { locks: this.locks, logger: this.log, defaultFsync: this.fsync, now: this.now },
      { corruptPolicy: this.corruptPolicy, crossProcess: this.crossProcess, fsync: this.fsync },
    );
  }

  /** Delete a document. Returns true if it existed. */
  async delete(id: string): Promise<boolean> {
    const path = this.pathFor(id);
    return this.locks.withLock(
      path,
      async () => {
        try {
          await unlink(path);
          return true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw new SubstrateError("io", `failed to delete ${path}`, { path, cause: err });
        }
      },
      this.acquireOpts(path),
    );
  }

  /**
   * List document ids (excludes temp/corrupt sidecar files).
   * KNOWN FUTURE CONCERN: this is O(directory size) — fine for the small
   * document-oriented stores this is meant for; a large/indexed listing is a
   * later concern if a store ever grows big.
   */
  async list(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new SubstrateError("io", `failed to list ${this.dir}`, { path: this.dir, cause: err });
    }
    return entries
      .filter((n) => n.endsWith(DOC_EXT) && !isTempFile(n) && !n.includes(".corrupt."))
      .map((n) => n.slice(0, -DOC_EXT.length))
      .filter((id) => {
        try {
          this.pathFor(id);
          return true;
        } catch (err) {
          if (err instanceof SubstrateError && err.kind === "invalid_key") return false;
          throw err;
        }
      });
  }

  private acquireOpts(path: string): { timeoutMs?: number; file?: string } {
    return this.crossProcess ? { file: `${path}.lock` } : {};
  }

  private pathFor(id: string): string {
    if (typeof id !== "string" || id.length === 0 || id === "." || id === ".." || !this.idPattern.test(id)) {
      throw new SubstrateError("invalid_key", `invalid document id: ${JSON.stringify(id)}`);
    }
    // STRUCTURAL confinement: regardless of how permissive idPattern is, the
    // resolved path MUST remain under the store directory. This is the real
    // traversal guard — the pattern is only a first filter.
    const root = resolve(this.dir);
    const full = resolve(this.dir, id + DOC_EXT);
    if (full !== root && !full.startsWith(root + sep)) {
      throw new SubstrateError("invalid_key", `document id escapes the store directory: ${JSON.stringify(id)}`);
    }
    return full;
  }
}

/**
 * ikbi substrate — locking.
 *
 * Two layers, combined by `LockManager`:
 *   - `KeyedMutex`: an in-process, FIFO, per-key async mutex. The engine is one
 *     Node process, but `await` interleaves concurrent async operations, so two
 *     RMW operations on the same key can interleave and lose an update. The mutex
 *     serializes them. Non-reentrant by design.
 *   - `FileLock`: a cross-process advisory lock (a `.lock` file carrying pid/host/
 *     time/nonce). Serializes separate OS processes (e.g. the CLI vs the service).
 *     Recovers stale locks left by a dead process (dead PID, same host) or by age.
 *
 * Everything is fail-closed and releases cleanly on failure: acquiring the file
 * lock after the mutex but failing releases the mutex; the combined release frees
 * both even if the protected function throws.
 */

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { open, readFile, rename, unlink } from "node:fs/promises";
import type { Logger } from "pino";

import { type Release, SubstrateError } from "./contract.js";

type Clock = () => number;

// ---------------------------------------------------------------------------
// In-process FIFO mutex
// ---------------------------------------------------------------------------

interface Waiter {
  settled: boolean;
  grant: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface KeyState {
  locked: boolean;
  queue: Waiter[];
}

export class KeyedMutex {
  private readonly state = new Map<string, KeyState>();

  /**
   * Acquire the mutex for `key`. Resolves with a release function once held, or
   * rejects with a `lock_timeout` SubstrateError if `timeoutMs` elapses while
   * queued. `onContend` is invoked if the call has to wait.
   */
  acquire(key: string, timeoutMs: number | undefined, onContend?: () => void): Promise<Release> {
    const s = this.getState(key);
    return new Promise<Release>((resolve, reject) => {
      let released = false;
      const release: Release = async () => {
        if (released) return;
        released = true;
        this.next(key);
      };
      const waiter: Waiter = {
        settled: false,
        grant: () => {
          if (waiter.settled) return;
          waiter.settled = true;
          if (waiter.timer !== undefined) clearTimeout(waiter.timer);
          resolve(release);
        },
      };

      if (!s.locked) {
        s.locked = true;
        waiter.settled = true;
        resolve(release);
        return;
      }

      // Contended: queue, optionally with a timeout.
      onContend?.();
      s.queue.push(waiter);
      if (timeoutMs !== undefined && timeoutMs >= 0) {
        waiter.timer = setTimeout(() => {
          if (waiter.settled) return;
          waiter.settled = true;
          const i = s.queue.indexOf(waiter);
          if (i >= 0) s.queue.splice(i, 1);
          reject(new SubstrateError("lock_timeout", `timed out acquiring in-process lock "${key}"`));
        }, timeoutMs);
      }
    });
  }

  /** Hand the lock to the next queued waiter, or release it. */
  private next(key: string): void {
    const s = this.state.get(key);
    if (s === undefined) return;
    let w = s.queue.shift();
    while (w !== undefined && w.settled) w = s.queue.shift();
    if (w === undefined) {
      s.locked = false;
      if (s.queue.length === 0) this.state.delete(key);
      return;
    }
    w.grant(); // lock stays held, handed to w
  }

  private getState(key: string): KeyState {
    let s = this.state.get(key);
    if (s === undefined) {
      s = { locked: false, queue: [] };
      this.state.set(key, s);
    }
    return s;
  }

  /** Test/diagnostic: is the key currently held? */
  isLocked(key: string): boolean {
    return this.state.get(key)?.locked ?? false;
  }
}

// ---------------------------------------------------------------------------
// Cross-process file lock
// ---------------------------------------------------------------------------

interface LockFileBody {
  pid: number;
  host: string;
  acquiredAt: number;
  nonce: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH => no such process (dead). EPERM => exists but not ours (alive).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface FileLockDeps {
  readonly logger: Logger;
  readonly now?: Clock;
  readonly staleMs: number;
}

/**
 * Acquire a cross-process advisory lock at `lockPath`. Polls with backoff until
 * `timeoutMs`. Recovers a stale lock (dead PID on this host, or older than
 * staleMs, or unreadable/corrupt) by atomically stealing it (rename-then-remove,
 * so only one stealer wins). Returns a guarded release that only removes the lock
 * if we still own it (nonce match).
 */
export async function acquireFileLock(
  lockPath: string,
  timeoutMs: number,
  deps: FileLockDeps,
): Promise<Release> {
  const now = deps.now ?? Date.now;
  const nonce = randomBytes(12).toString("hex");
  const body: LockFileBody = { pid: process.pid, host: hostname(), acquiredAt: now(), nonce };
  const deadline = now() + timeoutMs;
  let backoff = 5;

  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(body));
        await handle.sync();
      } finally {
        await handle.close();
      }
      return makeFileRelease(lockPath, nonce);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new SubstrateError("io", `failed to acquire file lock ${lockPath}`, { path: lockPath, cause: err });
      }
      // Held by someone — check staleness.
      const stale = await isStaleLock(lockPath, deps.staleMs, now);
      if (stale && (await tryStealLock(lockPath, nonce, deps.logger))) {
        continue; // try to create immediately
      }
      if (now() >= deadline) {
        throw new SubstrateError("lock_timeout", `timed out acquiring file lock ${lockPath}`, { path: lockPath });
      }
      await sleep(Math.min(backoff, 100));
      backoff = Math.min(backoff * 2, 100);
    }
  }
}

async function isStaleLock(lockPath: string, staleMs: number, now: Clock): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch {
    return true; // disappeared or unreadable — treat as recoverable
  }
  let body: LockFileBody;
  try {
    body = JSON.parse(raw) as LockFileBody;
  } catch {
    return true; // corrupt lock file — recoverable
  }
  if (typeof body.acquiredAt === "number" && now() - body.acquiredAt > staleMs) return true;
  if (body.host === hostname() && typeof body.pid === "number" && !isProcessAlive(body.pid)) return true;
  return false;
}

/** Atomically steal a stale lock: rename it aside (only one winner) then remove it. */
async function tryStealLock(lockPath: string, nonce: string, logger: Logger): Promise<boolean> {
  const aside = `${lockPath}.stale.${nonce}`;
  try {
    await rename(lockPath, aside);
  } catch {
    return false; // someone else already moved/removed it
  }
  await unlink(aside).catch(() => undefined);
  logger.warn({ event: "stale_lock_recovered", lockPath }, "recovered a stale cross-process lock");
  return true;
}

function makeFileRelease(lockPath: string, nonce: string): Release {
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      const raw = await readFile(lockPath, "utf8");
      const body = JSON.parse(raw) as LockFileBody;
      if (body.nonce === nonce) await unlink(lockPath).catch(() => undefined);
    } catch {
      // Lock file gone or unreadable — nothing to release.
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// LockManager — combines mutex + file lock, logs, guarantees clean release
// ---------------------------------------------------------------------------

export interface LockManagerDeps {
  readonly logger: Logger;
  readonly defaultTimeoutMs: number;
  readonly defaultStaleMs: number;
  readonly now?: Clock;
}

export interface AcquireOptions {
  readonly timeoutMs?: number;
  readonly file?: string;
  readonly staleMs?: number;
}

export class LockManager {
  private readonly mutex = new KeyedMutex();
  private readonly log: Logger;
  private readonly defaultTimeoutMs: number;
  private readonly defaultStaleMs: number;
  private readonly now: Clock;

  constructor(deps: LockManagerDeps) {
    this.log = deps.logger;
    this.defaultTimeoutMs = deps.defaultTimeoutMs;
    this.defaultStaleMs = deps.defaultStaleMs;
    this.now = deps.now ?? Date.now;
  }

  /** Acquire the in-process mutex (and optional cross-process file lock) for `key`. */
  async acquire(key: string, opts?: AcquireOptions): Promise<Release> {
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    const start = this.now();

    const releaseMutex = await this.mutex.acquire(key, timeoutMs, () => {
      this.log.debug({ event: "lock_contended", key }, "in-process lock contended; queued");
    }).catch((err: unknown) => {
      if (err instanceof SubstrateError && err.kind === "lock_timeout") {
        this.log.warn({ event: "lock_timeout", key, timeoutMs }, "timed out acquiring in-process lock");
      }
      throw err;
    });

    let releaseFile: Release | undefined;
    if (opts?.file !== undefined) {
      const remaining = Math.max(0, timeoutMs - (this.now() - start));
      try {
        releaseFile = await acquireFileLock(opts.file, remaining, {
          logger: this.log,
          now: this.now,
          staleMs: opts.staleMs ?? this.defaultStaleMs,
        });
      } catch (err) {
        await releaseMutex(); // clean release of the mutex if the file lock fails
        if (err instanceof SubstrateError && err.kind === "lock_timeout") {
          this.log.warn({ event: "lock_timeout", key, file: opts.file }, "timed out acquiring file lock");
        }
        throw err;
      }
    }

    this.log.debug({ event: "lock_acquired", key, file: opts?.file }, "lock acquired");
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        if (releaseFile) await releaseFile();
      } finally {
        await releaseMutex();
        this.log.debug({ event: "lock_released", key, file: opts?.file }, "lock released");
      }
    };
  }

  /** Run `fn` while holding the lock; release on every path (incl. throw). */
  async withLock<T>(key: string, fn: () => Promise<T>, opts?: AcquireOptions): Promise<T> {
    const release = await this.acquire(key, opts);
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  /** Test/diagnostic. */
  isLocked(key: string): boolean {
    return this.mutex.isLocked(key);
  }
}

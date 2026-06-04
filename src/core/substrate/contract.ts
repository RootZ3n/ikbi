/**
 * ikbi concurrency-safe substrate — THE FROZEN CORE primitive.
 *
 * The SINGLE canonical mechanism for safe access to shared state. Every
 * persisted-state write and every guarded read-modify-write in the engine goes
 * through here — receipts, trust, the store, the identity registry, workspace
 * allocation all build ON this rather than hand-rolling locks or file writes.
 *
 * This phase builds the SAFETY primitive (atomic writes, locking, safe RMW). It
 * does NOT build the concurrency FEATURE (parallel multi-agent dispatch) — the
 * substrate merely makes that possible later.
 *
 * Guarantees:
 *   - Atomic writes: write-to-temp + fsync + atomic rename. A reader never sees a
 *     partial write; a crash mid-write leaves the previous file intact.
 *   - Locking: an in-process async mutex serializes concurrent async callers; an
 *     optional cross-process file lock serializes separate processes (CLI vs
 *     service). Acquire with timeout; clean release on failure; stale-lock
 *     recovery (dead PID / age).
 *   - Safe RMW: read -> modify -> atomic write, all under the lock — no lost
 *     updates from interleaved operations.
 *   - Fail-closed on corruption / unrecoverable state where safety requires it.
 */

/** Semantic version of the substrate contract. Bump on breaking change. */
export const SUBSTRATE_CONTRACT_VERSION = "1.0.0";

/** Classification of a substrate failure. */
export type SubstrateErrorKind =
  | "lock_timeout" // could not acquire a lock within the timeout
  | "corrupt_state" // a state file failed to parse/validate (fail-closed)
  | "write_failed" // an atomic write could not be completed durably
  | "invalid_key" // an unsafe document id / key (e.g. path traversal)
  | "io"; // an underlying filesystem error

/** A typed substrate failure. */
export class SubstrateError extends Error {
  readonly kind: SubstrateErrorKind;
  readonly path?: string;
  constructor(kind: SubstrateErrorKind, message: string, opts?: { path?: string; cause?: unknown }) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "SubstrateError";
    this.kind = kind;
    if (opts?.path !== undefined) this.path = opts.path;
  }
}

/** Options for an atomic file write. */
export interface AtomicWriteOptions {
  /** fsync the file (and best-effort the directory) for durability. Default true. */
  readonly fsync?: boolean;
  /** File mode for the created file. Default 0o600. */
  readonly mode?: number;
}

/** Options for acquiring a lock. */
export interface LockOptions {
  /** Max time to wait to acquire (ms). Defaults to config. */
  readonly timeoutMs?: number;
  /**
   * Also take a cross-process advisory file lock at this path (in addition to the
   * in-process mutex). Use when other OS processes (e.g. the CLI) may touch the
   * same state.
   */
  readonly file?: string;
  /** Age after which a held file lock is considered stale and recoverable (ms). */
  readonly staleMs?: number;
}

/** An async release function — idempotent; safe to call once on every path. */
export type Release = () => Promise<void>;

/** How a store handles a corrupt (unparseable) state file. */
export type CorruptPolicy =
  | "throw" // fail-closed: surface a SubstrateError (default)
  | "quarantine"; // move the bad file aside (.corrupt.<ts>) and treat as missing

/** Options for a read-modify-write. */
export interface RmwOptions {
  readonly lockTimeoutMs?: number;
  /** Also take a cross-process file lock on the target path. Default false (in-process only). */
  readonly crossProcess?: boolean;
  /** fsync the write. Defaults to config. */
  readonly fsync?: boolean;
  /** Corrupt-state handling on the read step. Default "throw". */
  readonly corruptPolicy?: CorruptPolicy;
}

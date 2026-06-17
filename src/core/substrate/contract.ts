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
 * Guarantees (read carefully — the cross-process boundary is precise):
 *   - Atomic writes: write-to-temp + fsync + atomic rename. A reader — even in a
 *     SEPARATE process — never sees a partial write; a crash mid-write leaves the
 *     previous file intact. (This is what makes cross-process READS always safe.)
 *   - In-process locking (DEFAULT): an in-process async mutex serializes
 *     concurrent async callers WITHIN this process. By default the substrate
 *     provides in-process mutual exclusion + atomic writes — that is exactly what
 *     the real consumers (the single service process) need.
 *   - Cross-process WRITE safety is OPT-IN (`crossProcess: true` / a `file` lock).
 *     Only then are two separate OS processes (e.g. the CLI and the service)
 *     serialized against each other. The default does NOT claim cross-process
 *     no-lost-update — it claims cross-process safe READS (no torn reads).
 *   - Safe RMW: read -> modify -> atomic write, all under the lock — no lost
 *     updates from interleaved operations (in-process by default; cross-process
 *     when opted in).
 *   - Stale-lock recovery NEVER victimizes a live holder: only a dead-PID (same
 *     host) or a long-broken/corrupt lock file is reclaimed. A slow but live
 *     holder keeps its lock (no split-brain writes).
 *   - Fail-closed on corruption / unrecoverable state where safety requires it.
 */

import type { Logger } from "pino";

/** Semantic version of the substrate contract. Bump on breaking change. */
export const SUBSTRATE_CONTRACT_VERSION = "1.0.0";

/** Classification of a substrate failure. */
export type SubstrateErrorKind =
  | "lock_timeout" // could not acquire a lock within the timeout
  | "corrupt_state" // a state file failed to parse/validate (fail-closed)
  | "write_failed" // an atomic write could not be completed durably
  | "disk_full" // ENOSPC — disk full during write (Bubbles LOW-1)
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
  /** fsync the file (and the directory) for durability. Default true. A real dir-fsync failure fails the write. */
  readonly fsync?: boolean;
  /** File mode for the created file. Default 0o600. */
  readonly mode?: number;
  /** Optional logger for best-effort/diagnostic events (e.g. unsupported dir fsync). */
  readonly logger?: Logger;
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

/** A byte offset into an append log (for incremental tailing). */
export type LogOffset = number;

/** Options for an append-log read. */
export interface AppendReadOptions {
  /** How to handle a corrupt (unparseable, non-trailing) line. Default "throw" (fail-closed). */
  readonly corruptPolicy?: CorruptPolicy;
}

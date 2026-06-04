/**
 * ikbi substrate — atomic append log (line-delimited JSON).
 *
 * The canonical primitive for append-heavy, ordered, audit-style state — what the
 * receipt store (next phase) and any append-only consumer builds on. Distinct
 * from `DocumentStore` (full-document RMW for small document-oriented state like
 * trust/workspace/registry): an append is O(1) (open in append mode, write one
 * line, fsync) — it does NOT rewrite the whole file.
 *
 * Safety:
 *   - Appends are serialized under the substrate lock (in-process by default;
 *     cross-process when opted in), so concurrent appends never interleave bytes
 *     and never lose an entry.
 *   - Each entry is one line: `JSON.stringify(entry) + "\n"`, fsync'd. A reader
 *     parses complete lines only.
 *   - Torn-tail repair: a crash mid-append can leave an unterminated partial line
 *     (never confirmed durable to the caller). Before the next append, the file
 *     is truncated back to the last newline so the partial cannot merge into the
 *     next entry and corrupt it.
 *
 * Known future concern (documented, not built now): compaction/rotation of large
 * logs — left to the consumer / a later phase.
 */

import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Logger } from "pino";

import type { AppendReadOptions, CorruptPolicy, LogOffset } from "./contract.js";
import { SubstrateError } from "./contract.js";
import type { LockManager } from "./lock.js";

const NEWLINE = 0x0a;
const TAIL_SCAN_BYTES = 1 << 20; // how far back we look to repair a torn tail

export interface AppendLogOptions {
  readonly path: string;
  readonly locks: LockManager;
  readonly logger: Logger;
  /** fsync each append for durability. Default true. */
  readonly fsync?: boolean;
  /** Also serialize across processes via a file lock. Default false (in-process only). */
  readonly crossProcess?: boolean;
}

/** Result of an append: where the entry began and where the next entry will begin. */
export interface AppendResult {
  readonly offset: LogOffset;
  readonly bytes: number;
  readonly nextOffset: LogOffset;
}

/** Result of reading from an offset: the entries and the offset to resume from. */
export interface ReadResult<T> {
  readonly entries: T[];
  readonly nextOffset: LogOffset;
}

export class AtomicAppendLog<T> {
  private readonly path: string;
  private readonly locks: LockManager;
  private readonly log: Logger;
  private readonly fsync: boolean;
  private readonly crossProcess: boolean;

  constructor(opts: AppendLogOptions) {
    this.path = opts.path;
    this.locks = opts.locks;
    this.log = opts.logger;
    this.fsync = opts.fsync ?? true;
    this.crossProcess = opts.crossProcess ?? false;
  }

  /** Append one entry. Returns its byte offset. O(1) — does not rewrite the file. */
  async append(entry: T): Promise<AppendResult> {
    return this.appendBatch([entry]);
  }

  /** Append multiple entries atomically (single open + single fsync), serialized. */
  async appendBatch(entries: readonly T[]): Promise<AppendResult> {
    const key = resolve(this.path);
    return this.locks.withLock(
      key,
      async () => {
        await mkdir(dirname(this.path), { recursive: true });
        const handle = await open(this.path, "a+", 0o600);
        try {
          const start = await this.repairTail(handle);
          const payload = entries.map((e) => JSON.stringify(e) + "\n").join("");
          if (payload.length === 0) return { offset: start, bytes: 0, nextOffset: start };
          const buf = Buffer.from(payload, "utf8");
          await handle.write(buf); // append mode => goes to end
          if (this.fsync) await handle.sync();
          return { offset: start, bytes: buf.length, nextOffset: start + buf.length };
        } finally {
          await handle.close();
        }
      },
      this.acquireOpts(key),
    );
  }

  /** Read every entry. */
  async readAll(opts?: AppendReadOptions): Promise<T[]> {
    return (await this.readFrom(0, opts)).entries;
  }

  /** Read entries starting at byte `offset`; returns them and the next resume offset. */
  async readFrom(offset: LogOffset, opts?: AppendReadOptions): Promise<ReadResult<T>> {
    const key = resolve(this.path);
    const policy: CorruptPolicy = opts?.corruptPolicy ?? "throw";
    return this.locks.withLock(
      key,
      async () => {
        let handle;
        try {
          handle = await open(this.path, "r");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], nextOffset: 0 };
          throw new SubstrateError("io", `failed to open append log ${this.path}`, { path: this.path, cause: err });
        }
        try {
          const size = (await handle.stat()).size;
          if (offset >= size) return { entries: [], nextOffset: size };
          const length = size - offset;
          const buf = Buffer.alloc(length);
          await handle.read(buf, 0, length, offset);
          return this.parse(buf, offset, policy);
        } finally {
          await handle.close();
        }
      },
      this.acquireOpts(key),
    );
  }

  /** Current byte size of the log (0 if it does not exist). */
  async size(): Promise<LogOffset> {
    try {
      const handle = await open(this.path, "r");
      try {
        return (await handle.stat()).size;
      } finally {
        await handle.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw new SubstrateError("io", `failed to stat append log ${this.path}`, { path: this.path, cause: err });
    }
  }

  /** Parse complete lines from `buf`; a trailing partial line is NOT consumed. */
  private parse(buf: Buffer, baseOffset: LogOffset, policy: CorruptPolicy): ReadResult<T> {
    const entries: T[] = [];
    let lineStart = 0;
    let consumed = 0;
    for (let i = 0; i < buf.length; i += 1) {
      if (buf[i] !== NEWLINE) continue;
      const line = buf.subarray(lineStart, i).toString("utf8").trim();
      lineStart = i + 1;
      consumed = lineStart; // bytes up to and including this newline
      if (line.length === 0) continue;
      try {
        entries.push(JSON.parse(line) as T);
      } catch (cause) {
        if (policy === "quarantine") {
          this.log.warn({ event: "append_log_line_skipped", path: this.path, offset: baseOffset + i }, "skipped corrupt append-log line");
          continue;
        }
        throw new SubstrateError("corrupt_state", `corrupt line in append log ${this.path}`, { path: this.path, cause });
      }
    }
    return { entries, nextOffset: baseOffset + consumed };
  }

  /**
   * Ensure the file ends on a line boundary before appending. If a prior crash
   * left an unterminated partial line (never confirmed durable), truncate it away
   * so it cannot merge into the next entry. Returns the (post-repair) size, which
   * is where the next append begins.
   */
  private async repairTail(handle: Awaited<ReturnType<typeof open>>): Promise<number> {
    const size = (await handle.stat()).size;
    if (size === 0) return 0;
    const tailLen = Math.min(size, TAIL_SCAN_BYTES);
    const buf = Buffer.alloc(tailLen);
    await handle.read(buf, 0, tailLen, size - tailLen);
    if (buf[tailLen - 1] === NEWLINE) return size; // properly terminated

    const lastNl = buf.lastIndexOf(NEWLINE);
    if (lastNl === -1 && size > tailLen) {
      // Partial line longer than our scan window — cannot safely repair; leave it.
      this.log.warn({ event: "append_log_tail_unrepairable", path: this.path }, "append log has an over-long unterminated tail");
      return size;
    }
    const truncateTo = lastNl === -1 ? 0 : size - tailLen + lastNl + 1;
    await handle.truncate(truncateTo);
    this.log.warn(
      { event: "append_log_tail_repaired", path: this.path, droppedBytes: size - truncateTo },
      "repaired torn append-log tail (dropped an unconfirmed partial line)",
    );
    return truncateTo;
  }

  private acquireOpts(key: string): { file?: string } {
    return this.crossProcess ? { file: `${key}.lock` } : {};
  }
}

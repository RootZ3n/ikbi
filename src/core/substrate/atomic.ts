/**
 * ikbi substrate — atomic file writes.
 *
 * THE canonical write primitive: write to a unique temp file, fsync it, then
 * atomically rename it over the target, then (best-effort, but honestly reported)
 * fsync the directory.
 *
 * Why this is safe:
 *   - rename(2) on the same filesystem is atomic — a concurrent reader (even in
 *     another process) opens either the complete old file or the complete new
 *     file, NEVER a partial one.
 *   - The target is only ever replaced by a fully-written, fsync'd temp file, so
 *     a crash mid-write leaves the previous file fully intact (the half-written
 *     temp is orphaned, not the target).
 *
 * Callers must NOT hand-roll fs.writeFile for persisted state — use this.
 */

import { randomBytes } from "node:crypto";
import { open, mkdir, rename, stat, unlink, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Logger } from "pino";

import { SubstrateError, type AtomicWriteOptions } from "./contract.js";

const TEMP_SUFFIX = ".ikbi-tmp.";
const CORRUPT_MARKER = ".corrupt.";
const DEFAULT_MODE = 0o600;
/** Default minimum age before a temp/corrupt sidecar is reaped (avoids killing in-flight writes). */
const DEFAULT_SWEEP_AGE_MS = 60_000;

/** errno codes meaning "this filesystem/platform cannot fsync a directory" — not a real failure. */
const DIR_FSYNC_UNSUPPORTED = new Set(["EINVAL", "EISDIR", "EPERM", "ENOTSUP", "EOPNOTSUPP", "EACCES", "EBADF"]);

function tempName(filePath: string): string {
  const rnd = randomBytes(6).toString("hex");
  return `${filePath}${TEMP_SUFFIX}${process.pid}.${rnd}`;
}

/** Classify a directory-fsync error: "ignore" (unsupported platform) or "throw" (real failure). */
export function classifyDirFsyncError(code: string | undefined): "ignore" | "throw" {
  return code !== undefined && DIR_FSYNC_UNSUPPORTED.has(code) ? "ignore" : "throw";
}

/**
 * fsync a directory so a rename into it is durable. On platforms that cannot
 * fsync a directory this is a documented best-effort no-op; a REAL I/O failure is
 * surfaced (thrown) so durability is never falsely reported.
 */
async function fsyncDir(dir: string, logger?: Logger): Promise<void> {
  let handle;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (classifyDirFsyncError(code) === "ignore") {
      logger?.debug({ event: "dir_fsync_unsupported", dir, code }, "directory fsync unsupported; continuing");
      return;
    }
    throw err; // real failure — caller surfaces it
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

/** Internal seam so tests can inject directory-fsync behavior. */
export interface AtomicWriteInternals {
  readonly fsyncDir?: (dir: string, logger?: Logger) => Promise<void>;
}

/**
 * Atomically write `data` to `filePath`. Creates parent dirs as needed. On any
 * failure the temp file is cleaned up and a SubstrateError is thrown; the target
 * is never left partially written. When `fsync` is requested, a directory-fsync
 * failure FAILS the write (durability is not falsely reported).
 */
export async function atomicWriteFile(
  filePath: string,
  data: string | Buffer,
  opts?: AtomicWriteOptions,
  internal?: AtomicWriteInternals,
): Promise<void> {
  const dir = dirname(filePath);
  const doFsync = opts?.fsync ?? true;
  const mode = opts?.mode ?? DEFAULT_MODE;
  const dirFsync = internal?.fsyncDir ?? fsyncDir;

  await mkdir(dir, { recursive: true });
  const tmp = tempName(filePath);

  try {
    const handle = await open(tmp, "wx", mode);
    try {
      await handle.writeFile(data);
      if (doFsync) await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (cause) {
    await unlink(tmp).catch(() => undefined);
    // Surface disk-full as a distinct error code so callers can distinguish it from
    // permission/I/O errors (Bubbles LOW-1).
    const isEnospc = cause instanceof Error && (cause as NodeJS.ErrnoException).code === "ENOSPC";
    throw new SubstrateError(
      isEnospc ? "disk_full" : "write_failed",
      isEnospc ? `disk full writing temp file for ${filePath}` : `failed to write temp file for ${filePath}`,
      { path: filePath, cause },
    );
  }

  try {
    await rename(tmp, filePath); // atomic replace
  } catch (cause) {
    await unlink(tmp).catch(() => undefined);
    throw new SubstrateError("write_failed", `failed to atomically rename into ${filePath}`, { path: filePath, cause });
  }

  if (doFsync) {
    try {
      await dirFsync(dir, opts?.logger);
    } catch (cause) {
      if (cause instanceof SubstrateError) throw cause;
      throw new SubstrateError("write_failed", `directory fsync failed for ${filePath} (durability not guaranteed)`, {
        path: filePath,
        cause,
      });
    }
  }
}

/** Atomically write a value as pretty JSON (newline-terminated). */
export async function atomicWriteJson(
  filePath: string,
  value: unknown,
  opts?: AtomicWriteOptions,
): Promise<void> {
  await atomicWriteFile(filePath, JSON.stringify(value, null, 2) + "\n", opts);
}

export interface SweepOptions {
  /** Only reap sidecars older than this many ms (avoids killing in-flight writes). Default 60000. */
  readonly olderThanMs?: number;
  readonly now?: () => number;
}

/**
 * Reap orphaned ikbi temp files (crash mid-write) and quarantined `.corrupt.`
 * sidecars in `dir`. Only files OLDER than `olderThanMs` are removed, so an
 * in-flight write's temp is never unlinked. Safe on startup. Returns count swept.
 */
export async function sweepTempFiles(dir: string, opts?: SweepOptions): Promise<number> {
  const olderThanMs = opts?.olderThanMs ?? DEFAULT_SWEEP_AGE_MS;
  const now = opts?.now ?? Date.now;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0; // dir does not exist yet
  }
  let swept = 0;
  for (const name of entries) {
    if (!name.includes(TEMP_SUFFIX) && !name.includes(CORRUPT_MARKER)) continue;
    const full = join(dir, name);
    try {
      const st = await stat(full);
      if (now() - st.mtimeMs <= olderThanMs) continue; // too fresh — may be in-flight
    } catch {
      continue; // vanished
    }
    await unlink(full).catch(() => undefined);
    swept += 1;
  }
  return swept;
}

/** True if a path looks like an ikbi temp file (for callers that list directories). */
export function isTempFile(p: string): boolean {
  return basename(p).includes(TEMP_SUFFIX);
}

/** True if a path looks like a quarantined corrupt sidecar. */
export function isCorruptSidecar(p: string): boolean {
  return basename(p).includes(CORRUPT_MARKER);
}

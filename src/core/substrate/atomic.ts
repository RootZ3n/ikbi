/**
 * ikbi substrate — atomic file writes.
 *
 * THE canonical write primitive: write to a unique temp file, fsync it, then
 * atomically rename it over the target, then best-effort fsync the directory.
 *
 * Why this is safe:
 *   - rename(2) on the same filesystem is atomic — a concurrent reader opens
 *     either the complete old file or the complete new file, NEVER a partial one.
 *   - The target is only ever replaced by a fully-written, fsync'd temp file, so
 *     a crash mid-write leaves the previous file fully intact (the half-written
 *     temp is orphaned, not the target).
 *
 * Callers must NOT hand-roll fs.writeFile for persisted state — use this.
 */

import { randomBytes } from "node:crypto";
import { open, mkdir, rename, unlink, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { SubstrateError, type AtomicWriteOptions } from "./contract.js";

const TEMP_SUFFIX = ".ikbi-tmp.";
const DEFAULT_MODE = 0o600;

function tempName(filePath: string): string {
  const rnd = randomBytes(6).toString("hex");
  return `${filePath}${TEMP_SUFFIX}${process.pid}.${rnd}`;
}

/** Best-effort directory fsync so the rename is durable. Unsupported on some platforms. */
async function fsyncDir(dir: string): Promise<void> {
  let handle;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch {
    // Some platforms/filesystems (e.g. Windows) cannot fsync a directory — ignore.
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

/**
 * Atomically write `data` to `filePath`. Creates parent dirs as needed. On any
 * failure the temp file is cleaned up and a SubstrateError is thrown; the target
 * is never left partially written.
 */
export async function atomicWriteFile(
  filePath: string,
  data: string | Buffer,
  opts?: AtomicWriteOptions,
): Promise<void> {
  const dir = dirname(filePath);
  const doFsync = opts?.fsync ?? true;
  const mode = opts?.mode ?? DEFAULT_MODE;

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
    throw new SubstrateError("write_failed", `failed to write temp file for ${filePath}`, {
      path: filePath,
      cause,
    });
  }

  try {
    await rename(tmp, filePath); // atomic replace
  } catch (cause) {
    await unlink(tmp).catch(() => undefined);
    throw new SubstrateError("write_failed", `failed to atomically rename into ${filePath}`, {
      path: filePath,
      cause,
    });
  }

  if (doFsync) await fsyncDir(dir);
}

/** Atomically write a value as pretty JSON (newline-terminated). */
export async function atomicWriteJson(
  filePath: string,
  value: unknown,
  opts?: AtomicWriteOptions,
): Promise<void> {
  await atomicWriteFile(filePath, JSON.stringify(value, null, 2) + "\n", opts);
}

/**
 * Sweep orphaned ikbi temp files left by a crash mid-write in `dir`. Safe to run
 * on startup: temp files are never the source of truth (the target is), so
 * removing them only reclaims space. Returns the number swept.
 */
export async function sweepTempFiles(dir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0; // dir does not exist yet
  }
  let swept = 0;
  for (const name of entries) {
    if (name.includes(TEMP_SUFFIX)) {
      await unlink(join(dir, name)).catch(() => undefined);
      swept += 1;
    }
  }
  return swept;
}

/** True if a path looks like an ikbi temp file (for callers that list directories). */
export function isTempFile(p: string): boolean {
  return basename(p).includes(TEMP_SUFFIX);
}

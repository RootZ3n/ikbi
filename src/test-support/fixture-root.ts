/**
 * THE TEST-FACING FIXTURE HELPER — a thin layer over the governed temporary-root authority.
 *
 * Root resolution, validation, ownership records, liveness, reaping and force-removal all live in
 * `src/core/temp-root.ts` and are NOT duplicated here. There was a second copy of that logic for a
 * while, and a reaper that deletes directories is the last thing that should exist twice: the two
 * would drift, and the drift would only show when one of them removed something it should not have.
 *
 * What remains here is the part that is genuinely about TESTS:
 *
 *   withFixtureDir   a scratch directory removed whatever happens — return, throw, or rejection.
 *                    The `finally` is the whole point; it is the shape ~600 hand-rolled
 *                    `mkdtempSync` call sites were missing.
 *   the ledger       created vs removed vs survived. Containment means a leaked fixture can no
 *                    longer threaten the machine, but it does not make the leak invisible — a
 *                    suite that never cleans up still shows up here, measurably.
 *
 * Fixtures land under the GOVERNED root, never `/tmp`: `labTempDir()` is what `tmpdir()` resolves
 * to across this repository, and it has no fallback to the platform temp directory.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { forceRemoveTree, labTempDir } from "../core/temp-root.js";

// Re-exported so the runner and its suites have ONE import for the whole mechanism while the
// implementation stays in the authority.
export {
  TEMP_RECORDS_DIRNAME,
  TEMP_RECORD_MARKER,
  TEMP_RECORD_VERSION,
  TEMP_ROOT_ENV,
  TEMP_RUN_ID_ENV,
  censusChildren,
  classifyChild,
  countEntries,
  createTempChild,
  forceRemoveTree,
  hostLivenessFacts,
  labTempDir,
  readOwnershipRecord,
  reapTempChildren,
  recordPathFor,
  removeOwnedChild,
  resolveTempRoot,
  rootFingerprint,
  validateTempRoot,
  type ChildCensusEntry,
  type ChildDisposition,
  type HostLivenessFacts,
  type ReapReport,
  type TempChildHandle,
  type TempOwnershipRecord,
} from "../core/temp-root.js";

// ---------------------------------------------------------------------------
// The created/removed ledger
// ---------------------------------------------------------------------------

const created = new Set<string>();
const removed = new Set<string>();

export interface FixtureLedger {
  readonly created: readonly string[];
  readonly removed: readonly string[];
  /** Created, never removed, still on disk. The honest leak count. */
  readonly survivors: readonly string[];
}

export function fixtureLedger(): FixtureLedger {
  const survivors = [...created].filter((p) => !removed.has(p) && existsSync(p));
  return { created: [...created].sort(), removed: [...removed].sort(), survivors: survivors.sort() };
}

export function resetFixtureLedger(): void {
  created.clear();
  removed.clear();
}

/** Make one fixture directory beneath the governed root, and remember it. */
export function makeFixtureDir(prefix: string): string {
  const safe = prefix.replace(/[^A-Za-z0-9._-]/g, "-");
  const path = join(labTempDir(), `${safe}-${randomUUID().slice(0, 8)}`);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  created.add(path);
  return path;
}

/** Remove one fixture directory and mark it collected. Safe to call twice. */
export function removeFixtureDir(path: string): void {
  try {
    // Through the force-removing walk: a suite that chmodded a directory read-only would
    // otherwise defeat its own cleanup, which is one of the two ways fixtures leaked.
    forceRemoveTree(path);
  } finally {
    removed.add(path);
  }
}

/**
 * Run `fn` with a fixture directory that is removed WHATEVER happens — return, throw, or a
 * rejected promise.
 */
export async function withFixtureDir<T>(prefix: string, fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = makeFixtureDir(prefix);
  try {
    return await fn(dir);
  } finally {
    removeFixtureDir(dir);
  }
}

/** Synchronous sibling, for suites with no async body. */
export function withFixtureDirSync<T>(prefix: string, fn: (dir: string) => T): T {
  const dir = makeFixtureDir(prefix);
  try {
    return fn(dir);
  } finally {
    removeFixtureDir(dir);
  }
}

// ---------------------------------------------------------------------------
// Inode accounting
// ---------------------------------------------------------------------------

/** A filesystem's inode budget, as the preflight understands it. */
export interface InodeUsage {
  readonly filesystem: string;
  readonly total: number;
  readonly used: number;
  readonly free: number;
  readonly usedPercent: number;
}

/**
 * Parse `df -i -P <path>` output.
 *
 * `-P` pins the POSIX single-line format; without it a long device name wraps onto its own line
 * and the numbers land in the wrong columns.
 */
export function parseDfInodes(output: string): InodeUsage | undefined {
  const lines = output.trim().split("\n").filter((l) => l.trim().length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined || lines.length < 2) return undefined;
  const cols = last.trim().split(/\s+/);
  if (cols.length < 5) return undefined;
  const total = Number(cols[1]);
  const used = Number(cols[2]);
  const free = Number(cols[3]);
  if (!Number.isFinite(total) || !Number.isFinite(used) || !Number.isFinite(free)) return undefined;
  return { filesystem: cols[0] ?? "", total, used, free, usedPercent: total > 0 ? (used / total) * 100 : 0 };
}

/**
 * THE TEST FIXTURE ROOT AUTHORITY — one owned root per test run, and a reaper that can
 * only remove roots it can PROVE are abandoned.
 *
 * WHY THIS EXISTS. Suites create scratch directories with `mkdtempSync(join(tmpdir(), …))`.
 * A suite that throws before its cleanup leaks the directory, and nothing ever collected
 * them: a real incident left 65,645 entries in a 16 GB tmpfs and exhausted its 1,048,576
 * INODES while `df` still reported 13 GB free. Every subsequent write — including the test
 * runner's own — failed `ENOSPC`, and the suite reported hundreds of "failures" that were
 * nothing but a full filesystem. Disk bytes were never the constraint; directory entries were.
 *
 * THE FIX IS CONTAINMENT, NOT DISCIPLINE. Asking ~600 call sites to remember `finally` is a
 * policy that fails the first time someone forgets. Instead the runner creates ONE root per
 * run and points `TMPDIR`/`TMP`/`TEMP` at it, so every `os.tmpdir()` fixture lands beneath it
 * by construction, and the wrapper removes that one root when the run ends — normally, on
 * assertion failure, on SIGINT and on SIGTERM. A leaked fixture then dies with its run
 * instead of outliving the machine's inode budget.
 *
 * WHAT SIGKILL COSTS, AND WHY THE REAPER IS CAREFUL. A killed runner runs no trap, so its
 * root survives. The next run must be able to collect it — but a reaper that deletes by NAME
 * PREFIX is a footgun aimed at a concurrent run, at a developer's own scratch directory, and
 * (given one bad base path) at real data. So this reaper never deletes by prefix. It removes
 * a root only when a well-formed OWNERSHIP RECORD claims it AND the reaper can positively
 * disprove that the owner is still running:
 *
 *   different boot id      the owning process cannot exist any more            → reapable
 *   same boot, no /proc    the pid is gone                                     → reapable
 *   same boot, ticks moved the pid was RECYCLED; the original owner is gone    → reapable
 *   same boot, ticks match the owner is ALIVE — possibly a parallel run        → live, never
 *   anything unreadable    the owner cannot be DISPROVEN                       → undecidable
 *
 * `undecidable` is retained, never removed. Fail-closed: an uncollected directory costs an
 * inode, and a wrongly collected one costs someone's running test or their data.
 *
 * PORTABILITY. Boot id and process start ticks come from `/proc`, which is Linux-only. Where
 * they are unavailable NOTHING is reapable — the reaper degrades to doing nothing rather than
 * to guessing. That is the correct direction for a destructive operation.
 *
 * NO MACHINE-SPECIFIC PATH LIVES HERE. The base directory is chosen by environment
 * (`IKBI_TEST_FIXTURE_BASE`) and falls back to `os.tmpdir()`. An operator who wants fixtures
 * on a roomier filesystem sets that variable; the committed source names no host's layout.
 */

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// The ownership record
// ---------------------------------------------------------------------------

/**
 * Records live in a SIDECAR directory beside the run roots, never inside them.
 *
 * They were inside at first, and a real run destroyed its own: `rmSync` deleted the record
 * and then died on a fixture directory a suite had left mode 0555, leaving a root that
 * could no longer prove whose it was. Authority for a destructive act must not sit in the
 * tree the act is dismantling — nor anywhere a test fixture can reach, since the run root
 * is exactly where every suite is writing.
 */
export const FIXTURE_RECORDS_DIRNAME = ".ikbi-test-runs";
export const FIXTURE_RECORD_MARKER = "ikbi-test-run-root";
export const FIXTURE_RECORD_VERSION = 1;

/** Where one run's ownership record lives. */
export function recordPathFor(base: string, runId: string): string {
  return join(base, FIXTURE_RECORDS_DIRNAME, `${encodeURIComponent(runId)}.json`);
}

/**
 * Who owns one run root, in enough detail to later DISPROVE that they are alive.
 *
 * `bootId` and `processStartTicks` are the two fields that make pid reuse survivable: a pid
 * alone is ambiguous across a reboot and across recycling, and both happen on a busy box.
 */
export interface FixtureOwnershipRecord {
  readonly marker: typeof FIXTURE_RECORD_MARKER;
  readonly version: number;
  /** The run this root belongs to. Free-form, supplied by the runner. */
  readonly runId: string;
  /** The root this record claims. Kept in the record so a sidecar names its own subject. */
  readonly rootPath: string;
  /** The host that created it. A base on shared storage must not be reaped from elsewhere. */
  readonly hostname: string;
  /** Linux boot id, when readable. Absent ⇒ liveness can never be disproven here. */
  readonly bootId?: string;
  /** The OWNING process — the test wrapper, not the tool that wrote this file. */
  readonly pid: number;
  /** `/proc/<pid>/stat` field 22. Absent ⇒ pid recycling cannot be ruled out. */
  readonly processStartTicks?: number;
  readonly createdAt: number;
}

/** Read this boot's id. `undefined` off Linux, or when /proc is not readable. */
export function readBootId(): string | undefined {
  try {
    const raw = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read a process's start time in clock ticks since boot.
 *
 * `/proc/<pid>/stat` field 22. The command name is field 2 and may itself contain spaces and
 * parentheses, so the fields are counted from AFTER the last `)` — splitting the whole line
 * on whitespace is the classic way to misparse this file.
 */
export function readProcessStartTicks(pid: number): number | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    if (close < 0) return undefined;
    // After "pid (comm)" the next field is state; starttime is field 22 overall, so it is
    // index 19 of what follows (22 - 3 fields already consumed).
    const rest = raw.slice(close + 1).trim().split(/\s+/);
    const ticks = Number(rest[19]);
    return Number.isFinite(ticks) ? ticks : undefined;
  } catch {
    return undefined;
  }
}

/** Is there a process with this pid at all? Distinguishes "gone" from "not permitted". */
export function processExists(pid: number): boolean {
  return existsSync(`/proc/${pid}`);
}

/** The live facts a classification is made against. Injected so the tests need no real pids. */
export interface HostLivenessFacts {
  readonly hostname: string;
  readonly bootId: string | undefined;
  readonly processExists: (pid: number) => boolean;
  readonly processStartTicks: (pid: number) => number | undefined;
}

/** The real host. */
export function hostLivenessFacts(): HostLivenessFacts {
  return {
    hostname: hostname(),
    bootId: readBootId(),
    processExists,
    processStartTicks: readProcessStartTicks,
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 *   live         the owning process is running — a parallel run, or this one. NEVER remove.
 *   reapable     the owner is positively disproven. Safe to remove.
 *   undecidable  we could not prove either way. RETAINED, and reported.
 */
export type RunRootDisposition = "live" | "reapable" | "undecidable";

export interface RunRootClassification {
  readonly disposition: RunRootDisposition;
  /** Why — recorded so a retained root can be explained rather than silently accumulating. */
  readonly reason: string;
}

/**
 * Decide what may be done with one run root. PURE — it takes the record and the host facts
 * and returns a disposition; it removes nothing and reads no filesystem of its own.
 */
export function classifyRunRoot(record: FixtureOwnershipRecord | undefined, host: HostLivenessFacts): RunRootClassification {
  if (record === undefined) {
    return { disposition: "undecidable", reason: "no readable ownership record — not ours to remove" };
  }
  if (record.marker !== FIXTURE_RECORD_MARKER || record.version !== FIXTURE_RECORD_VERSION) {
    return { disposition: "undecidable", reason: `ownership record is not a v${FIXTURE_RECORD_VERSION} ${FIXTURE_RECORD_MARKER}` };
  }
  if (record.hostname !== host.hostname) {
    // A base on shared storage: this machine cannot probe another machine's process table,
    // so it cannot disprove liveness there.
    return { disposition: "undecidable", reason: `owned by host ${record.hostname}, not ${host.hostname}` };
  }
  if (host.bootId === undefined || record.bootId === undefined) {
    return { disposition: "undecidable", reason: "no boot id available — pid liveness cannot be established" };
  }
  if (record.bootId !== host.bootId) {
    // The owner belonged to a previous boot, so it cannot be running now, whatever its pid
    // has since been reassigned to.
    return { disposition: "reapable", reason: "created before the current boot — the owner cannot be running" };
  }
  if (!host.processExists(record.pid)) {
    return { disposition: "reapable", reason: `owner pid ${record.pid} is gone` };
  }
  if (record.processStartTicks === undefined) {
    return { disposition: "undecidable", reason: `owner pid ${record.pid} exists and the record has no start ticks — pid reuse cannot be ruled out` };
  }
  const ticks = host.processStartTicks(record.pid);
  if (ticks === undefined) {
    return { disposition: "undecidable", reason: `owner pid ${record.pid} exists but its start time is unreadable` };
  }
  if (ticks !== record.processStartTicks) {
    return { disposition: "reapable", reason: `pid ${record.pid} was recycled (start ticks ${ticks} ≠ ${record.processStartTicks}) — the original owner is gone` };
  }
  return { disposition: "live", reason: `owner pid ${record.pid} is running` };
}

// ---------------------------------------------------------------------------
// The base directory
// ---------------------------------------------------------------------------

/**
 * Where per-run roots live.
 *
 * Environment first so a constrained tmpfs can be swapped for a roomier filesystem without
 * editing code, and NO host's directory layout is committed here.
 */
export function resolveFixtureBase(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.IKBI_TEST_FIXTURE_BASE?.trim();
  if (configured !== undefined && configured.length > 0) return resolve(configured);
  return join(tmpdir(), "ikbi-test-fixtures");
}

// ---------------------------------------------------------------------------
// Removal that actually removes
// ---------------------------------------------------------------------------

/**
 * Remove a tree, restoring the write permission a fixture may have taken away.
 *
 * THE SECOND LEAK CAUSE, and the subtler one. Suites that exercise read-only behaviour leave
 * directories at mode 0555. A file cannot be unlinked from a directory its owner cannot
 * write, so a plain `rmSync` dies partway through with `EACCES` — one real run left 43 such
 * directories, and every cleanup that touched them failed. A suite with a perfectly correct
 * `finally` still leaked, which is why "just remember to clean up" was never going to be the
 * fix on its own.
 *
 * So the walk re-adds owner `rwx` to each DIRECTORY on the way down. Only directories, and
 * only the owner bits: the point is to be able to unlink the children, not to launder
 * whatever a fixture was testing. Symlinks are never followed — a fixture that symlinks
 * somewhere real must not have that target chmodded or removed.
 */
export function forceRemoveTree(path: string): void {
  const relax = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* best effort — the rm below will report what it truly cannot remove */
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) relax(join(dir, entry.name));
    }
  };

  try {
    if (!lstatSync(path).isSymbolicLink()) relax(path);
  } catch {
    return; // already gone
  }
  rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

// ---------------------------------------------------------------------------
// Creating a run root
// ---------------------------------------------------------------------------

export interface CreateRunRootInput {
  readonly base: string;
  readonly runId?: string;
  /**
   * The process whose liveness governs this root — the TEST WRAPPER, not whatever short-lived
   * helper happens to create the directory. Getting this wrong would let a root be reaped the
   * instant its creator exited, while the run it belongs to was still going.
   */
  readonly ownerPid?: number;
  readonly host?: HostLivenessFacts;
  readonly now?: () => number;
}

export interface RunRootHandle {
  readonly path: string;
  readonly runId: string;
  readonly record: FixtureOwnershipRecord;
}

/** Create one owned run root, mode 0700, with its ownership record written before use. */
export function createRunRoot(input: CreateRunRootInput): RunRootHandle {
  const host = input.host ?? hostLivenessFacts();
  const now = input.now ?? Date.now;
  const runId = input.runId ?? `run-${randomUUID()}`;
  const ownerPid = input.ownerPid ?? process.pid;
  const path = join(input.base, runId);

  mkdirSync(path, { recursive: true, mode: 0o700 });
  mkdirSync(join(input.base, FIXTURE_RECORDS_DIRNAME), { recursive: true, mode: 0o700 });

  const startTicks = host.processStartTicks(ownerPid);
  const record: FixtureOwnershipRecord = {
    marker: FIXTURE_RECORD_MARKER,
    version: FIXTURE_RECORD_VERSION,
    runId,
    rootPath: path,
    hostname: host.hostname,
    ...(host.bootId !== undefined ? { bootId: host.bootId } : {}),
    pid: ownerPid,
    ...(startTicks !== undefined ? { processStartTicks: startTicks } : {}),
    createdAt: now(),
  };
  // The record is written BEFORE the root is used, and outside it, so the root is never
  // in a state where it exists but nothing can say whose it is.
  writeFileSync(recordPathFor(input.base, runId), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return { path, runId, record };
}

/** Parse one record file, or `undefined` when it is absent or not one of ours. */
export function readRecordFile(recordPath: string): FixtureOwnershipRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(recordPath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const r = parsed as Record<string, unknown>;
    if (typeof r["marker"] !== "string" || typeof r["pid"] !== "number" || typeof r["runId"] !== "string") return undefined;
    if (typeof r["rootPath"] !== "string" || typeof r["hostname"] !== "string") return undefined;
    if (typeof r["version"] !== "number" || typeof r["createdAt"] !== "number") return undefined;
    return parsed as FixtureOwnershipRecord;
  } catch {
    return undefined;
  }
}

/** Read the ownership record claiming `runId` under `base`. */
export function readOwnershipRecord(base: string, runId: string): FixtureOwnershipRecord | undefined {
  return readRecordFile(recordPathFor(base, runId));
}

// ---------------------------------------------------------------------------
// Census and reaping
// ---------------------------------------------------------------------------

/** One root seen by the census, with the evidence for what may be done to it. */
export interface RunRootCensusEntry {
  readonly path: string;
  readonly record?: FixtureOwnershipRecord;
  readonly classification: RunRootClassification;
  /** Directory entries beneath it — the inode cost this root is carrying. */
  readonly entryCount: number;
  readonly ageMs?: number;
  /** The sidecar that claims this root, when one does. */
  readonly recordPath?: string;
}

/** Count entries beneath a path, bounded so a pathological tree cannot stall the census. */
export function countEntries(path: string, limit = 500_000): number {
  let seen = 0;
  const stack: string[] = [path];
  while (stack.length > 0 && seen < limit) {
    const current = stack.pop()!;
    let children: import("node:fs").Dirent[];
    try {
      children = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      seen += 1;
      if (seen >= limit) break;
      if (child.isDirectory() && !child.isSymbolicLink()) stack.push(join(current, child.name));
    }
  }
  return seen;
}

/**
 * Enumerate every run root under `base` and classify it. Reads only — removes nothing.
 *
 * Two populations, deliberately kept apart. A root CLAIMED by a sidecar record can be
 * classified against its owner's liveness. A directory with no record claiming it is an
 * ORPHAN: it might be a killed run whose record never landed, or someone's unrelated
 * directory that happens to live here. Orphans are reported and never reaped — the reaper
 * has no evidence, and "no evidence" must not resolve to "delete".
 */
export function censusRunRoots(base: string, host: HostLivenessFacts = hostLivenessFacts(), now: () => number = Date.now): readonly RunRootCensusEntry[] {
  const entries: RunRootCensusEntry[] = [];
  const claimed = new Set<string>();

  let recordNames: string[] = [];
  try {
    recordNames = readdirSync(join(base, FIXTURE_RECORDS_DIRNAME)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    recordNames = [];
  }

  for (const name of recordNames) {
    const recordPath = join(base, FIXTURE_RECORDS_DIRNAME, name);
    const record = readRecordFile(recordPath);
    if (record === undefined) {
      entries.push({
        path: recordPath,
        classification: { disposition: "undecidable", reason: "record file is unreadable or not one of ours" },
        entryCount: 0,
        recordPath,
      });
      continue;
    }
    // A record must claim a root INSIDE the base it lives in. One that points elsewhere is
    // not authority to delete elsewhere — that is the whole shape of a path-traversal bug.
    const rootPath = resolve(record.rootPath);
    if (rootPath !== resolve(join(base, record.runId)) && !rootPath.startsWith(`${resolve(base)}/`)) {
      entries.push({
        path: rootPath,
        record,
        classification: { disposition: "undecidable", reason: `record claims ${rootPath}, which is outside ${base}` },
        entryCount: 0,
        recordPath,
      });
      continue;
    }
    claimed.add(rootPath);
    if (!existsSync(rootPath)) {
      // The root is already gone; only the record is left to collect.
      entries.push({
        path: rootPath,
        record,
        classification: classifyRunRoot(record, host),
        entryCount: 0,
        recordPath,
        ...(record !== undefined ? { ageMs: Math.max(0, now() - record.createdAt) } : {}),
      });
      continue;
    }
    entries.push({
      path: rootPath,
      record,
      classification: classifyRunRoot(record, host),
      entryCount: countEntries(rootPath),
      recordPath,
      ageMs: Math.max(0, now() - record.createdAt),
    });
  }

  let names: string[] = [];
  try {
    names = readdirSync(base).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    if (name === FIXTURE_RECORDS_DIRNAME) continue;
    const path = join(base, name);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    if (claimed.has(resolve(path))) continue;
    entries.push({
      path,
      classification: { disposition: "undecidable", reason: "no ownership record claims this directory" },
      entryCount: countEntries(path),
    });
  }

  return entries;
}

/** What one reap pass did. Every retained root is explained, never silently skipped. */
export interface ReapReport {
  readonly base: string;
  readonly examined: number;
  readonly reaped: readonly { readonly path: string; readonly runId: string; readonly entryCount: number; readonly reason: string; readonly ageMs?: number }[];
  readonly retained: readonly { readonly path: string; readonly disposition: RunRootDisposition; readonly reason: string; readonly entryCount: number }[];
  readonly entriesFreed: number;
  readonly failures: readonly { readonly path: string; readonly error: string }[];
}

/**
 * Remove every root whose owner is positively disproven, and NOTHING else.
 *
 * The evidence for each removal — run id, age, and the inode cost it was holding — is
 * captured BEFORE the directory goes, so a SIGKILLed run still leaves a trace of what
 * happened even though the directory itself does not survive.
 */
export function reapStaleRunRoots(input: {
  readonly base: string;
  readonly host?: HostLivenessFacts;
  readonly now?: () => number;
  /** Classify and report, remove nothing. */
  readonly dryRun?: boolean;
  /** Never reap this root even if it classifies as reapable (the caller's own). */
  readonly protectPath?: string;
}): ReapReport {
  const host = input.host ?? hostLivenessFacts();
  const census = censusRunRoots(input.base, host, input.now ?? Date.now);
  const reaped: { path: string; runId: string; entryCount: number; reason: string; ageMs?: number }[] = [];
  const retained: { path: string; disposition: RunRootDisposition; reason: string; entryCount: number }[] = [];
  const failures: { path: string; error: string }[] = [];
  let entriesFreed = 0;

  for (const entry of census) {
    const protectedRoot = input.protectPath !== undefined && resolve(entry.path) === resolve(input.protectPath);
    if (entry.classification.disposition !== "reapable" || protectedRoot) {
      retained.push({
        path: entry.path,
        disposition: entry.classification.disposition,
        reason: protectedRoot ? "this run's own root" : entry.classification.reason,
        entryCount: entry.entryCount,
      });
      continue;
    }
    if (input.dryRun === true) {
      reaped.push({ path: entry.path, runId: entry.record?.runId ?? "(unknown)", entryCount: entry.entryCount, reason: entry.classification.reason, ...(entry.ageMs !== undefined ? { ageMs: entry.ageMs } : {}) });
      entriesFreed += entry.entryCount;
      continue;
    }
    try {
      // The root first, its record second: if the removal fails partway, the record must
      // still be there to claim what is left, so the NEXT run can finish the job.
      forceRemoveTree(entry.path);
      if (entry.recordPath !== undefined) rmSync(entry.recordPath, { force: true });
      reaped.push({ path: entry.path, runId: entry.record?.runId ?? "(unknown)", entryCount: entry.entryCount, reason: entry.classification.reason, ...(entry.ageMs !== undefined ? { ageMs: entry.ageMs } : {}) });
      entriesFreed += entry.entryCount;
    } catch (err) {
      failures.push({ path: entry.path, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { base: input.base, examined: census.length, reaped, retained, entriesFreed, failures };
}

/**
 * Remove ONE run root, refusing anything that is not a verified root of this run.
 *
 * The wrapper's cleanup path. It re-reads the ownership record and compares the run id
 * rather than trusting the path it was handed — the one place a stray argument could turn
 * a cleanup into data loss.
 */
export function removeOwnedRunRoot(input: {
  readonly base: string;
  readonly rootPath: string;
  readonly runId: string;
}): { readonly ok: true; readonly entryCount: number } | { readonly ok: false; readonly reason: string } {
  const { base, rootPath, runId } = input;
  const record = readOwnershipRecord(base, runId);
  if (record === undefined) return { ok: false, reason: `no ownership record for run ${runId} under ${base} — refusing to remove ${rootPath}` };
  if (record.marker !== FIXTURE_RECORD_MARKER) return { ok: false, reason: `the record for ${runId} is not an ikbi test run root — refusing to remove` };
  if (resolve(record.rootPath) !== resolve(rootPath)) {
    return { ok: false, reason: `run ${runId} owns ${record.rootPath}, not ${rootPath} — refusing to remove` };
  }
  const entryCount = countEntries(rootPath);
  forceRemoveTree(rootPath);
  rmSync(recordPathFor(base, runId), { force: true });
  return { ok: true, entryCount };
}

// ---------------------------------------------------------------------------
// The per-suite fixture helper
// ---------------------------------------------------------------------------

/**
 * The created/removed ledger.
 *
 * Containment means a leaked fixture no longer threatens the machine, but it does not make
 * the leak invisible: a suite that never cleans up still shows here, which is how the
 * hygiene problem stays measurable instead of being absorbed by the run root.
 */
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

/** Reset the ledger. For the tests that exercise the ledger itself. */
export function resetFixtureLedger(): void {
  created.clear();
  removed.clear();
}

/**
 * Make one fixture directory beneath the ambient temp root, and remember it.
 *
 * Deliberately built on `os.tmpdir()` rather than on the run root directly: the runner points
 * `TMPDIR` at the run root, so this lands inside it automatically AND a suite run bare (a
 * developer invoking `node --test` on one file) still works, just without containment.
 */
export function makeFixtureDir(prefix: string): string {
  const safe = prefix.replace(/[^A-Za-z0-9._-]/g, "-");
  const path = join(tmpdir(), `${safe}-${randomUUID().slice(0, 8)}`);
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
 * Run `fn` with a fixture directory that is removed WHATEVER happens — return, throw,
 * or rejected promise. The `finally` is the whole point: this is the shape the ~600
 * hand-rolled `mkdtempSync` call sites were missing.
 */
export async function withFixtureDir<T>(prefix: string, fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = makeFixtureDir(prefix);
  try {
    return await fn(dir);
  } finally {
    removeFixtureDir(dir);
  }
}

/** Synchronous sibling of `withFixtureDir`, for suites with no async body. */
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
 * `-P` pins the POSIX single-line format; without it a long device name wraps onto its own
 * line and the numbers land in the wrong columns.
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
  return {
    filesystem: cols[0] ?? "",
    total,
    used,
    free,
    usedPercent: total > 0 ? (used / total) * 100 : 0,
  };
}

/** A stable short id for a base path, for logs that must not leak a full host path. */
export function baseFingerprint(base: string): string {
  return createHash("sha256").update(resolve(base), "utf8").digest("hex").slice(0, 12);
}

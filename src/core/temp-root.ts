/**
 * THE GOVERNED TEMPORARY-ROOT AUTHORITY — the one place ikbi decides where scratch lives.
 *
 * THE LAB RULE THIS ENFORCES: no ikbi code uses `/tmp`. Not production runtime state, not test
 * fixtures, not subprocess scratch, not formatter shadows, not snapshots, not downloads, and not
 * the implicit `os.tmpdir()` fallback. "Contained use" of `/tmp` is not an exception, so this
 * module has NO fallback to it — a root that cannot be resolved and validated is a typed
 * preflight failure, never a quiet `/tmp`.
 *
 * WHY AN AUTHORITY AND NOT A CONSTANT. Four things have to be true at once, and only a resolver
 * can establish them: the root must be discovered (never a machine path baked into the source),
 * validated (a wrong root is a data-loss hazard, since this module deletes things), governable
 * (bindable into the OS sandbox so a subprocess writes to the SAME place its parent does), and
 * collectable (a run that is SIGKILLed must be reapable by the next one, without a reaper that
 * could ever remove something it does not own).
 *
 * THE SHAPE:
 *
 *   <root>/                       governed, validated, lab-owned, outside every git worktree
 *     .ikbi-temp-runs/            ownership records — a SIDECAR, never inside the child
 *       <runId>.json              pid, process start ticks, boot id, run id, created, purpose
 *     <runId>/                    mode 0700, one per run, everything scratch lives here
 *
 * The record is a sidecar because an earlier version put it inside the child and a partial
 * removal destroyed the very authority needed to finish the job: `rmSync` deleted the record,
 * then died on a fixture directory a suite had left mode 0555, leaving a tree that could no
 * longer prove whose it was.
 *
 * THE REAPER NEVER DELETES BY PREFIX. It removes a child only when a well-formed record claims
 * it, the record's root is governed by THIS authority, and the owning process can be positively
 * DISPROVEN — a different boot, a dead pid, or a recycled pid. Live owners and anything it cannot
 * decide are retained and reported. Fail-closed: an uncollected directory costs an inode; a
 * wrongly collected one costs someone's running work or their data.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants as FS,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** The sidecar directory holding ownership records, beside the run children. */
export const TEMP_RECORDS_DIRNAME = ".ikbi-temp-runs";
export const TEMP_RECORD_MARKER = "ikbi-governed-temp-child";
export const TEMP_RECORD_VERSION = 1;

/** The environment variable an operator sets to choose the root explicitly. */
export const TEMP_ROOT_ENV = "IKBI_TEMP_ROOT";
/** Set by the test runner / CLI so every child process shares ONE governed run child. */
export const TEMP_RUN_ID_ENV = "IKBI_TEMP_RUN_ID";

/** Below this many free inodes a root is refused (skipped where the fs allocates dynamically). */
export const MIN_FREE_INODES = 50_000;
/** Below this many free bytes a root is refused. */
export const MIN_FREE_BYTES = 512 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Why a candidate root was refused. Closed set — every refusal is explainable to an operator. */
export type TempRootRejectionCode =
  | "not_absolute"
  | "is_tmp"
  | "under_tmp"
  | "inside_git_worktree"
  | "symlink_path"
  | "not_a_directory"
  | "not_owned_by_user"
  | "group_or_world_writable"
  | "not_writable"
  | "insufficient_inodes"
  | "insufficient_bytes"
  | "not_creatable"
  | "no_candidate";

export interface TempRootRejection {
  readonly candidate: string;
  readonly code: TempRootRejectionCode;
  readonly detail: string;
}

export type TempRootResolution =
  | { readonly ok: true; readonly root: string; readonly source: "env" | "state_root" | "runtime_dir" }
  | { readonly ok: false; readonly code: TempRootRejectionCode; readonly detail: string; readonly rejected: readonly TempRootRejection[] };

/** The system temp directory, named ONLY so it can be refused. Never used as a location. */
const FORBIDDEN_TMP = "/tmp";

function isUnder(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Is any component of `path` a symlink?
 *
 * Walked component by component with `lstat` rather than compared against `realpath`, because a
 * root that does not exist yet still has to be checked: its ANCESTORS are what a symlink attack
 * would use, and they exist even when the leaf does not.
 */
function hasSymlinkAncestor(path: string): string | undefined {
  const parts = path.split(sep).filter((p) => p.length > 0);
  let current: string = sep;
  for (const part of parts) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return current;
    } catch {
      return undefined; // does not exist yet — nothing to traverse
    }
  }
  return undefined;
}

/**
 * Is `path` inside a git working tree?
 *
 * Walked upward looking for `.git` rather than shelled out to `git rev-parse`: this runs during
 * preflight of every process, a subprocess per call would be absurd, and the filesystem answer is
 * the authoritative one anyway. A scratch root inside a worktree is refused because git then sees
 * every fixture as repository content — which, on a real machine, made 29 suites that assert "this
 * is NOT a git repository" fail for a reason having nothing to do with the code under test.
 */
export function gitWorktreeAncestor(path: string): string | undefined {
  let current = existsSync(path) ? path : dirname(path);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Free space, tolerating filesystems that allocate inodes dynamically (btrfs, xfs report 0). */
export interface Headroom {
  readonly freeBytes: number;
  /** `undefined` when the filesystem has no fixed inode budget. */
  readonly freeInodes: number | undefined;
}

export function headroomOf(path: string): Headroom | undefined {
  try {
    const s = statfsSync(path);
    const freeBytes = Number(s.bavail) * Number(s.bsize);
    const files = Number(s.files);
    return { freeBytes, freeInodes: files > 0 ? Number(s.ffree) : undefined };
  } catch {
    return undefined;
  }
}

/**
 * Validate ONE candidate root. Pure of policy decisions elsewhere: every rule the lab states is
 * checked here, in one place, so a caller cannot accidentally accept a root by a different route.
 */
export function validateTempRoot(candidate: string, opts: { readonly uid?: number } = {}): TempRootRejection | undefined {
  const reject = (code: TempRootRejectionCode, detail: string): TempRootRejection => ({ candidate, code, detail });

  if (!isAbsolute(candidate)) return reject("not_absolute", "a temporary root must be an absolute path");

  /*
    THE LAB RULE, checked before anything else and on the REAL path, so a symlink to /tmp is
    refused as surely as /tmp itself.

    The candidate's OWN real path is what gets judged. Resolving its parent and comparing THAT to
    /tmp would report `/tmp/ikbi` as "is /tmp" — the right refusal for the wrong reason, and a
    confusing one to act on. When the leaf does not exist yet its parent is resolved and the
    basename re-appended, so the answer still describes the candidate.
  */
  const realCandidate = ((): string => {
    try {
      if (existsSync(candidate)) return realpathSync(candidate);
      return join(realpathSync(dirname(candidate)), candidate.slice(dirname(candidate).length + 1));
    } catch {
      return candidate; // unresolvable — the literal path is what gets checked
    }
  })();
  if (candidate === FORBIDDEN_TMP || realCandidate === FORBIDDEN_TMP) {
    return reject("is_tmp", "/tmp is forbidden for all ikbi scratch");
  }
  if (isUnder(candidate, FORBIDDEN_TMP) || isUnder(realCandidate, FORBIDDEN_TMP)) {
    return reject("under_tmp", `${candidate} descends from /tmp, which is forbidden for all ikbi scratch`);
  }

  const link = hasSymlinkAncestor(candidate);
  if (link !== undefined) return reject("symlink_path", `${link} is a symlink; a temporary root must not traverse one`);

  const worktree = gitWorktreeAncestor(candidate);
  if (worktree !== undefined) return reject("inside_git_worktree", `${candidate} is inside the git working tree at ${worktree}`);

  if (existsSync(candidate)) {
    let stat: import("node:fs").Stats;
    try {
      stat = statSync(candidate);
    } catch (err) {
      return reject("not_a_directory", `${candidate} could not be inspected: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!stat.isDirectory()) return reject("not_a_directory", `${candidate} is not a directory`);

    const uid = opts.uid ?? process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) return reject("not_owned_by_user", `${candidate} is owned by uid ${stat.uid}, not ${uid}`);
    // Group or world WRITE means someone else can plant or swap a child under a path this module
    // later deletes recursively. Read/execute bits are irrelevant and are not checked.
    if ((stat.mode & 0o022) !== 0) return reject("group_or_world_writable", `${candidate} is group/world writable (mode ${(stat.mode & 0o777).toString(8)})`);
    try {
      accessSync(candidate, FS.W_OK);
    } catch {
      return reject("not_writable", `${candidate} is not writable`);
    }
  } else {
    // Creatable? The nearest existing ancestor has to be a writable directory we own.
    let probe = dirname(candidate);
    while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
    try {
      accessSync(probe, FS.W_OK);
    } catch {
      return reject("not_creatable", `${candidate} does not exist and ${probe} is not writable`);
    }
  }

  const room = headroomOf(existsSync(candidate) ? candidate : dirname(candidate));
  if (room !== undefined) {
    if (room.freeInodes !== undefined && room.freeInodes < MIN_FREE_INODES) {
      return reject("insufficient_inodes", `${candidate} has ${room.freeInodes} free inodes, below the ${MIN_FREE_INODES} floor`);
    }
    if (room.freeBytes < MIN_FREE_BYTES) {
      return reject("insufficient_bytes", `${candidate} has ${room.freeBytes} free bytes, below the ${MIN_FREE_BYTES} floor`);
    }
  }
  return undefined;
}

/**
 * Candidate roots, in order of preference. DISCOVERED, never hardcoded to a machine's layout:
 *
 *   1. `IKBI_TEMP_ROOT`      the operator's explicit choice; if it is set and invalid, that is an
 *                            error rather than a reason to fall through — an operator who names a
 *                            root is owed a refusal, not a silent substitution.
 *   2. `<state root>/tmp`    ikbi's own state directory (`IKBI_STATE_ROOT`, else `~/.ikbi/state`),
 *                            derived from the running user's home. Lab-owned, on real storage, and
 *                            outside every worktree.
 *   3. `$XDG_RUNTIME_DIR`    a per-user runtime directory, for a machine with no usable home.
 */
/**
 * ikbi's state root, derived the same way the temp candidates derive it.
 *
 * Exported so a module that needs a DURABLE lab-owned location (a run artifact, not scratch) can
 * have one without importing `core/config` — which runs a trust-key preflight on load and would
 * make a leaf module fail to start for reasons unrelated to what it does.
 */
export function labStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.IKBI_STATE_ROOT?.trim();
  if (explicit !== undefined && explicit.length > 0) return resolve(explicit);
  return join(env.HOME ?? homedir(), ".ikbi", "state");
}

export function tempRootCandidates(env: NodeJS.ProcessEnv = process.env): readonly { readonly path: string; readonly source: "env" | "state_root" | "runtime_dir" }[] {
  const out: { path: string; source: "env" | "state_root" | "runtime_dir" }[] = [];

  const explicit = env[TEMP_ROOT_ENV]?.trim();
  if (explicit !== undefined && explicit.length > 0) return [{ path: resolve(explicit), source: "env" }];

  const stateRoot = env.IKBI_STATE_ROOT?.trim();
  const home = env.HOME ?? homedir();
  if (stateRoot !== undefined && stateRoot.length > 0) out.push({ path: join(resolve(stateRoot), "tmp"), source: "state_root" });
  else if (home.length > 0) out.push({ path: join(home, ".ikbi", "state", "tmp"), source: "state_root" });

  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  if (runtimeDir !== undefined && runtimeDir.length > 0) out.push({ path: join(resolve(runtimeDir), "ikbi-temp"), source: "runtime_dir" });

  return out;
}

/** Resolve THE governed temporary root, or explain precisely why none is usable. */
export function resolveTempRoot(env: NodeJS.ProcessEnv = process.env): TempRootResolution {
  const candidates = tempRootCandidates(env);
  if (candidates.length === 0) {
    return { ok: false, code: "no_candidate", detail: temproothelp("no candidate temporary root could be derived"), rejected: [] };
  }
  const rejected: TempRootRejection[] = [];
  for (const candidate of candidates) {
    const problem = validateTempRoot(candidate.path);
    if (problem === undefined) return { ok: true, root: candidate.path, source: candidate.source };
    rejected.push(problem);
    // An EXPLICIT root is never fallen through: the operator named it.
    if (candidate.source === "env") {
      return { ok: false, code: problem.code, detail: temproothelp(`${TEMP_ROOT_ENV}=${candidate.path} is unusable: ${problem.detail}`), rejected };
    }
  }
  const first = rejected[0];
  return {
    ok: false,
    code: first?.code ?? "no_candidate",
    detail: temproothelp(rejected.map((r) => `${r.candidate}: ${r.detail}`).join("; ")),
    rejected,
  };
}

function temproothelp(reason: string): string {
  return (
    `no governed temporary root is available (${reason}). ikbi never falls back to /tmp. ` +
    `Set ${TEMP_ROOT_ENV} to an absolute directory that you own, that is mode 0700 or at least not ` +
    `group/world writable, that is NOT /tmp and not inside a git working tree, and that has free space.`
  );
}

/** Thrown when scratch is needed and no governed root exists. Typed, so callers can report it. */
export class TempRootUnavailableError extends Error {
  readonly code: TempRootRejectionCode;
  constructor(code: TempRootRejectionCode, detail: string) {
    super(detail);
    this.name = "TempRootUnavailableError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

export interface TempOwnershipRecord {
  readonly marker: typeof TEMP_RECORD_MARKER;
  readonly version: number;
  readonly runId: string;
  /** The child this record claims. A record naming a path outside its own root is refused. */
  readonly childPath: string;
  readonly root: string;
  readonly hostname: string;
  readonly bootId?: string;
  readonly pid: number;
  readonly processStartTicks?: number;
  readonly createdAt: number;
  /** What this child is for — "test-run", "cli", "formatter-shadow", … Reported, never parsed. */
  readonly purpose: string;
}

/** This boot's id. `undefined` off Linux; the reaper then proves nothing and removes nothing. */
export function readBootId(): string | undefined {
  try {
    const raw = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A process's start time in clock ticks since boot — `/proc/<pid>/stat` field 22.
 *
 * Counted from AFTER the last `)`: field 2 is the command name and may itself contain spaces and
 * parentheses, so splitting the whole line on whitespace is the classic way to misparse this.
 */
export function readProcessStartTicks(pid: number): number | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    if (close < 0) return undefined;
    const rest = raw.slice(close + 1).trim().split(/\s+/);
    const ticks = Number(rest[19]);
    return Number.isFinite(ticks) ? ticks : undefined;
  } catch {
    return undefined;
  }
}

export function processExists(pid: number): boolean {
  return existsSync(`/proc/${pid}`);
}

export interface HostLivenessFacts {
  readonly hostname: string;
  readonly bootId: string | undefined;
  readonly processExists: (pid: number) => boolean;
  readonly processStartTicks: (pid: number) => number | undefined;
}

export function hostLivenessFacts(): HostLivenessFacts {
  return { hostname: hostname(), bootId: readBootId(), processExists, processStartTicks: readProcessStartTicks };
}

/**
 *   live         the owning process is running — possibly a parallel run. NEVER remove.
 *   reapable     the owner is positively disproven. Safe to remove.
 *   undecidable  neither could be established. RETAINED, and reported.
 */
export type ChildDisposition = "live" | "reapable" | "undecidable";
export interface ChildClassification {
  readonly disposition: ChildDisposition;
  readonly reason: string;
}

/** Decide what may be done with one child. PURE — takes the record and host facts, touches nothing. */
export function classifyChild(record: TempOwnershipRecord | undefined, host: HostLivenessFacts): ChildClassification {
  if (record === undefined) return { disposition: "undecidable", reason: "no readable ownership record — not ours to remove" };
  if (record.marker !== TEMP_RECORD_MARKER || record.version !== TEMP_RECORD_VERSION) {
    return { disposition: "undecidable", reason: `not a v${TEMP_RECORD_VERSION} ${TEMP_RECORD_MARKER} record` };
  }
  if (record.hostname !== host.hostname) {
    return { disposition: "undecidable", reason: `owned by host ${record.hostname}, not ${host.hostname}` };
  }
  if (host.bootId === undefined || record.bootId === undefined) {
    return { disposition: "undecidable", reason: "no boot id available — pid liveness cannot be established" };
  }
  if (record.bootId !== host.bootId) {
    return { disposition: "reapable", reason: "created before the current boot — the owner cannot be running" };
  }
  if (!host.processExists(record.pid)) return { disposition: "reapable", reason: `owner pid ${record.pid} is gone` };
  if (record.processStartTicks === undefined) {
    return { disposition: "undecidable", reason: `owner pid ${record.pid} exists and the record has no start ticks — pid reuse cannot be ruled out` };
  }
  const ticks = host.processStartTicks(record.pid);
  if (ticks === undefined) return { disposition: "undecidable", reason: `owner pid ${record.pid} exists but its start time is unreadable` };
  if (ticks !== record.processStartTicks) {
    return { disposition: "reapable", reason: `pid ${record.pid} was recycled (start ticks ${ticks} ≠ ${record.processStartTicks}) — the original owner is gone` };
  }
  return { disposition: "live", reason: `owner pid ${record.pid} is running` };
}

export function recordPathFor(root: string, runId: string): string {
  return join(root, TEMP_RECORDS_DIRNAME, `${encodeURIComponent(runId)}.json`);
}

export function readRecordFile(recordPath: string): TempOwnershipRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(recordPath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const r = parsed as Record<string, unknown>;
    for (const key of ["marker", "runId", "childPath", "root", "hostname", "purpose"]) {
      if (typeof r[key] !== "string") return undefined;
    }
    if (typeof r["pid"] !== "number" || typeof r["version"] !== "number" || typeof r["createdAt"] !== "number") return undefined;
    return parsed as TempOwnershipRecord;
  } catch {
    return undefined;
  }
}

export function readOwnershipRecord(root: string, runId: string): TempOwnershipRecord | undefined {
  return readRecordFile(recordPathFor(root, runId));
}

// ---------------------------------------------------------------------------
// Removal that actually removes
// ---------------------------------------------------------------------------

/**
 * Remove a tree, restoring the write permission a fixture may have taken away.
 *
 * Suites that exercise read-only behaviour leave directories at mode 0555, and a file cannot be
 * unlinked from a directory its owner cannot write — so a plain `rmSync` dies partway with
 * `EACCES`. One real run stranded 43 such directories, and every cleanup that reached one failed:
 * a suite with a perfectly correct `finally` still leaked.
 *
 * The walk re-adds owner `rwx` to each DIRECTORY on the way down — only directories, and only the
 * owner bits. Symlinks are never followed, so a fixture that links somewhere real cannot have that
 * target chmodded or removed.
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
      /* best effort — the rm below reports what truly cannot be removed */
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) relax(join(dir, entry.name));
    }
  };
  try {
    if (lstatSync(path).isSymbolicLink()) return;
  } catch {
    return; // already gone
  }
  relax(path);
  rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

// ---------------------------------------------------------------------------
// Children
// ---------------------------------------------------------------------------

export interface TempChildHandle {
  readonly path: string;
  readonly runId: string;
  readonly root: string;
  readonly record: TempOwnershipRecord;
}

export interface CreateTempChildInput {
  readonly root: string;
  readonly purpose: string;
  readonly runId?: string;
  /** The process whose liveness governs this child — the WRAPPER, not a short-lived helper. */
  readonly ownerPid?: number;
  readonly host?: HostLivenessFacts;
  readonly now?: () => number;
}

/** Create one owned, mode-0700 child with its ownership record written BEFORE it is used. */
export function createTempChild(input: CreateTempChildInput): TempChildHandle {
  const host = input.host ?? hostLivenessFacts();
  const now = input.now ?? Date.now;
  const runId = input.runId ?? `ikbi-${process.pid}-${randomUUID().slice(0, 8)}`;
  const ownerPid = input.ownerPid ?? process.pid;
  const path = join(input.root, runId);

  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  mkdirSync(join(input.root, TEMP_RECORDS_DIRNAME), { recursive: true, mode: 0o700 });

  const startTicks = host.processStartTicks(ownerPid);
  const record: TempOwnershipRecord = {
    marker: TEMP_RECORD_MARKER,
    version: TEMP_RECORD_VERSION,
    runId,
    childPath: path,
    root: input.root,
    hostname: host.hostname,
    ...(host.bootId !== undefined ? { bootId: host.bootId } : {}),
    pid: ownerPid,
    ...(startTicks !== undefined ? { processStartTicks: startTicks } : {}),
    createdAt: now(),
    purpose: input.purpose,
  };
  writeFileSync(recordPathFor(input.root, runId), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return { path, runId, root: input.root, record };
}

/** Remove ONE child, refusing anything the record does not vouch for. */
export function removeOwnedChild(input: { readonly root: string; readonly childPath: string; readonly runId: string }):
  | { readonly ok: true; readonly entryCount: number }
  | { readonly ok: false; readonly reason: string } {
  const record = readOwnershipRecord(input.root, input.runId);
  if (record === undefined) return { ok: false, reason: `no ownership record for run ${input.runId} under ${input.root} — refusing to remove ${input.childPath}` };
  if (record.marker !== TEMP_RECORD_MARKER) return { ok: false, reason: `the record for ${input.runId} is not an ikbi governed temp child — refusing to remove` };
  if (resolve(record.childPath) !== resolve(input.childPath)) {
    return { ok: false, reason: `run ${input.runId} owns ${record.childPath}, not ${input.childPath} — refusing to remove` };
  }
  if (!isUnder(resolve(input.childPath), resolve(input.root))) {
    return { ok: false, reason: `${input.childPath} is not under the governed root ${input.root} — refusing to remove` };
  }
  const entryCount = countEntries(input.childPath);
  forceRemoveTree(input.childPath);
  rmSync(recordPathFor(input.root, input.runId), { force: true });
  return { ok: true, entryCount };
}

/** Count entries beneath a path, bounded so a pathological tree cannot stall a census. */
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

// ---------------------------------------------------------------------------
// Census and reaping
// ---------------------------------------------------------------------------

export interface ChildCensusEntry {
  readonly path: string;
  readonly record?: TempOwnershipRecord;
  readonly classification: ChildClassification;
  readonly entryCount: number;
  readonly ageMs?: number;
  readonly recordPath?: string;
}

/**
 * Enumerate the children under a root and classify each.
 *
 * Two populations, kept apart. A child CLAIMED by a record can be judged against its owner's
 * liveness. A directory nothing claims is an ORPHAN — possibly a killed run whose record never
 * landed, possibly something else entirely — and is reported but never reaped, because "no
 * evidence" must not resolve to "delete".
 */
export function censusChildren(root: string, host: HostLivenessFacts = hostLivenessFacts(), now: () => number = Date.now): readonly ChildCensusEntry[] {
  const entries: ChildCensusEntry[] = [];
  const claimed = new Set<string>();

  let recordNames: string[] = [];
  try {
    recordNames = readdirSync(join(root, TEMP_RECORDS_DIRNAME)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    recordNames = [];
  }

  for (const name of recordNames) {
    const recordPath = join(root, TEMP_RECORDS_DIRNAME, name);
    const record = readRecordFile(recordPath);
    if (record === undefined) {
      entries.push({ path: recordPath, classification: { disposition: "undecidable", reason: "record unreadable or not ours" }, entryCount: 0, recordPath });
      continue;
    }
    const childPath = resolve(record.childPath);
    // A record must claim a child INSIDE the root it lives in. One pointing elsewhere is not
    // authority to delete elsewhere — that is the shape of a path-traversal bug.
    if (!isUnder(childPath, resolve(root)) || resolve(record.root) !== resolve(root)) {
      entries.push({
        path: childPath,
        record,
        classification: { disposition: "undecidable", reason: `record claims ${childPath}, which is not governed by ${root}` },
        entryCount: 0,
        recordPath,
      });
      continue;
    }
    claimed.add(childPath);
    entries.push({
      path: childPath,
      record,
      classification: classifyChild(record, host),
      entryCount: existsSync(childPath) ? countEntries(childPath) : 0,
      recordPath,
      ageMs: Math.max(0, now() - record.createdAt),
    });
  }

  let names: string[] = [];
  try {
    names = readdirSync(root).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    if (name === TEMP_RECORDS_DIRNAME) continue;
    const path = join(root, name);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    if (claimed.has(resolve(path))) continue;
    entries.push({ path, classification: { disposition: "undecidable", reason: "no ownership record claims this directory" }, entryCount: countEntries(path) });
  }
  return entries;
}

export interface ReapReport {
  readonly root: string;
  readonly examined: number;
  readonly reaped: readonly { readonly path: string; readonly runId: string; readonly purpose: string; readonly entryCount: number; readonly reason: string; readonly ageMs?: number }[];
  readonly retained: readonly { readonly path: string; readonly disposition: ChildDisposition; readonly reason: string; readonly entryCount: number }[];
  readonly entriesFreed: number;
  readonly failures: readonly { readonly path: string; readonly error: string }[];
}

/**
 * Remove every child whose owner is positively disproven, and NOTHING else.
 *
 * The evidence for each removal — run id, purpose, age, and the inode cost it was holding — is
 * captured BEFORE the directory goes, so a SIGKILLed run still leaves a trace of what happened.
 */
export function reapTempChildren(input: {
  readonly root: string;
  readonly host?: HostLivenessFacts;
  readonly now?: () => number;
  readonly dryRun?: boolean;
  /** Never reap this child even if it classifies as reapable (the caller's own). */
  readonly protectPath?: string;
}): ReapReport {
  const host = input.host ?? hostLivenessFacts();
  const census = censusChildren(input.root, host, input.now ?? Date.now);
  const reaped: ReapReport["reaped"][number][] = [];
  const retained: ReapReport["retained"][number][] = [];
  const failures: { path: string; error: string }[] = [];
  let entriesFreed = 0;

  for (const entry of census) {
    const isOwn = input.protectPath !== undefined && resolve(entry.path) === resolve(input.protectPath);
    if (entry.classification.disposition !== "reapable" || isOwn) {
      retained.push({
        path: entry.path,
        disposition: entry.classification.disposition,
        reason: isOwn ? "this run's own child" : entry.classification.reason,
        entryCount: entry.entryCount,
      });
      continue;
    }
    const evidence = {
      path: entry.path,
      runId: entry.record?.runId ?? "(unknown)",
      purpose: entry.record?.purpose ?? "(unknown)",
      entryCount: entry.entryCount,
      reason: entry.classification.reason,
      ...(entry.ageMs !== undefined ? { ageMs: entry.ageMs } : {}),
    };
    if (input.dryRun === true) {
      reaped.push(evidence);
      entriesFreed += entry.entryCount;
      continue;
    }
    try {
      // The child first, its record second: a removal that fails partway must leave the record
      // behind to claim what remains, so the NEXT run can finish the job.
      forceRemoveTree(entry.path);
      if (entry.recordPath !== undefined) rmSync(entry.recordPath, { force: true });
      reaped.push(evidence);
      entriesFreed += entry.entryCount;
    } catch (err) {
      failures.push({ path: entry.path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { root: input.root, examined: census.length, reaped, retained, entriesFreed, failures };
}

// ---------------------------------------------------------------------------
// The per-process governed scratch directory
// ---------------------------------------------------------------------------

let cachedChild: TempChildHandle | undefined;
let exitHookInstalled = false;

/**
 * THE replacement for `os.tmpdir()`, everywhere in ikbi.
 *
 * Returns this process's governed scratch directory, creating it on first use. It NEVER returns
 * `/tmp` and never falls back to one: when no governed root can be validated it throws
 * `TempRootUnavailableError`, whose message tells the operator exactly how to set `IKBI_TEMP_ROOT`.
 *
 * A process that inherits `IKBI_TEMP_ROOT` + `IKBI_TEMP_RUN_ID` JOINS its parent's child rather
 * than making its own — that is what lets a spawned CLI, a sandboxed check and the test runner all
 * write to the same governed place, and lets one wrapper clean up after all of them. A process
 * with no inherited run id mints its own and removes it at exit.
 *
 * It also exports TMPDIR/TMP/TEMP into this process's environment, so third-party code that calls
 * the platform temp directory lands here too rather than escaping to /tmp.
 */
export function labTempDir(env: NodeJS.ProcessEnv = process.env): string {
  if (cachedChild !== undefined) return cachedChild.path;

  const resolution = resolveTempRoot(env);
  if (!resolution.ok) throw new TempRootUnavailableError(resolution.code, resolution.detail);
  mkdirSync(resolution.root, { recursive: true, mode: 0o700 });

  const inherited = env[TEMP_RUN_ID_ENV]?.trim();
  if (inherited !== undefined && inherited.length > 0) {
    const path = join(resolution.root, inherited);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const existing = readOwnershipRecord(resolution.root, inherited);
    cachedChild = {
      path,
      runId: inherited,
      root: resolution.root,
      record: existing ?? createTempChild({ root: resolution.root, runId: inherited, purpose: "inherited" }).record,
    };
  } else {
    cachedChild = createTempChild({ root: resolution.root, purpose: "process" });
    if (!exitHookInstalled) {
      exitHookInstalled = true;
      // A process that OWNS its child cleans it up. One that joined an inherited child does not:
      // that belongs to the wrapper, and removing it would delete a sibling's scratch.
      process.once("exit", () => {
        try {
          if (cachedChild !== undefined) removeOwnedChild({ root: cachedChild.root, childPath: cachedChild.path, runId: cachedChild.runId });
        } catch {
          /* exit handlers must not throw */
        }
      });
    }
  }

  env.TMPDIR = cachedChild.path;
  env.TMP = cachedChild.path;
  env.TEMP = cachedChild.path;
  return cachedChild.path;
}

/** The handle for this process's scratch, when one has been established. For wrappers and tests. */
export function currentTempChild(): TempChildHandle | undefined {
  return cachedChild;
}

/** Forget the cached child. Tests only — production resolves once per process by design. */
export function resetTempDirForTests(): void {
  cachedChild = undefined;
}

/** A stable short id for a root, for logs that must not print a full host path. */
export function rootFingerprint(root: string): string {
  return createHash("sha256").update(resolve(root), "utf8").digest("hex").slice(0, 12);
}

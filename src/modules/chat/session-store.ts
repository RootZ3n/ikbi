/**
 * ikbi chat — PERSISTENT SESSION STORE (resume across REPL restarts).
 *
 * The in-memory `sessionStore` (session.ts) is RAM-only and dies with the process. This
 * store mirrors each session to a JSON file under a sessions directory so a conversation
 * survives a quit/crash and can be RESUMED later (`ikbi repl --continue` / `--resume <id>`).
 *
 * Layout: one `<id>.json` file per session under the sessions dir
 *   (default `~/.ikbi/sessions/`, overridable via `IKBI_SESSIONS_DIR`). The file is the
 *   `PersistedSession` shape (id, worktree, model, messages, memory, timestamps, label).
 *   Each live session also gets a `<id>.lock` directory while a write is in flight (BLOCKER-2).
 *
 * The store is the production `autosave` sink: ChatSession calls `save(this)` after every
 * turn (wired in cli.ts / routes.ts), so persistence needs no clean exit.
 *
 * Two operational guards (senior-engineer audit):
 *   BLOCKER-2 — concurrency: `save()` takes a per-session file lock (atomic `mkdir`) so two REPLs
 *               on the same session can't silently clobber each other's writes.
 *   BLOCKER-3 — growth: `list()` is capped to MAX_SESSIONS and lazily `prune()`s the oldest files
 *               once the directory grows past 1.5× the cap, so it never has to scan 500 files.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { childLogger } from "../../core/log.js";
import { atomicWriteFile } from "../../core/substrate/atomic.js";
import { ChatSession, type ChatSessionDeps, type PersistedSession } from "./session.js";

const log = childLogger("chat-store");

/** Default cap on how many sessions `list()` returns / the store retains (BLOCKER-3). */
export const DEFAULT_MAX_SESSIONS = 100;

/** Resolve the session cap: explicit override → `IKBI_MAX_SESSIONS` env → default. */
function resolveMaxSessions(override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) return Math.floor(override);
  const env = process.env.IKBI_MAX_SESSIONS;
  if (env !== undefined) {
    const n = Number.parseInt(env.trim(), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MAX_SESSIONS;
}

/** The sessions directory (IKBI_SESSIONS_DIR overrides the `~/.ikbi/sessions` default). */
export function sessionsDir(): string {
  const override = process.env.IKBI_SESSIONS_DIR;
  if (override !== undefined && override.trim().length > 0) return override.trim();
  return join(homedir(), ".ikbi", "sessions");
}

/** The minimal surface `save()` needs — any object that can name itself and serialize. */
export interface Persistable {
  readonly id: string;
  toPersisted(): PersistedSession;
}

/** A session's metadata, for listing without fully reconstructing the conversation. */
export interface SessionMeta {
  readonly id: string;
  readonly label?: string;
  readonly worktree: string;
  readonly messageCount: number;
  readonly createdAt: number;
  readonly lastUsedAt: number;
}

/** Options for a single `save()` call. */
export interface SaveOptions {
  /** Break (force-unlock) a lock held by another process before writing (the `--force` escape). */
  readonly force?: boolean;
}

export interface PersistentSessionStoreDeps {
  readonly atomicWriteFile?: typeof atomicWriteFile;
}

/**
 * Thrown by `save()` when the session is locked by ANOTHER live process (BLOCKER-2). Carries the
 * holder's pid + start time so the REPL can print an actionable message instead of silently losing
 * the write. A stale lock (dead pid) is reclaimed automatically and never raises this.
 */
export class SessionLockedError extends Error {
  readonly sessionId: string;
  readonly holderPid: number;
  readonly startedAt: number;
  constructor(sessionId: string, holderPid: number, startedAt: number) {
    const when = Number.isFinite(startedAt) ? new Date(startedAt).toISOString() : "unknown";
    super(
      `Session ${sessionId} is locked by PID ${holderPid} (started at ${when}). ` +
        `Another ikbi process is using it. Force-unlock with --force or use a different session.`,
    );
    this.name = "SessionLockedError";
    this.sessionId = sessionId;
    this.holderPid = holderPid;
    this.startedAt = startedAt;
  }
}

/** Map an arbitrary session id to a safe, collision-resistant file stem. */
function fileStem(id: string): string {
  // Keep readable ids readable; escape anything filesystem-unsafe deterministically. The escape
  // char is `_`, so we MUST escape literal `_` first (L8) — otherwise the raw id "a_2f" and the
  // id "a/" (which escapes to "a_2f") would collide on the same file. Escaping `_`→`_5f` makes the
  // mapping injective.
  return id.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(16)}`);
}

function isPersistedSession(value: unknown): value is PersistedSession {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    typeof s.worktree === "string" &&
    typeof s.model === "string" &&
    Array.isArray(s.messages) &&
    typeof s.memory === "object" &&
    s.memory !== null &&
    typeof s.createdAt === "number" &&
    Number.isFinite(s.createdAt) &&
    typeof s.lastUsedAt === "number" &&
    Number.isFinite(s.lastUsedAt) &&
    (s.label === undefined || typeof s.label === "string")
  );
}

/** Is `pid` a live process? `kill(pid, 0)` probes existence without signalling. EPERM ⇒ alive
 *  (exists but not ours); ESRCH ⇒ gone. Used to distinguish a held lock from a stale one. */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A disk-backed session store: save/load/list/delete/latest under the sessions directory. */
export class PersistentSessionStore {
  private readonly dir: string;
  private readonly maxSessions: number;
  private readonly atomicWriteFile: typeof atomicWriteFile;

  constructor(dir: string = sessionsDir(), maxSessions?: number, deps: PersistentSessionStoreDeps = {}) {
    this.dir = dir;
    this.maxSessions = resolveMaxSessions(maxSessions);
    this.atomicWriteFile = deps.atomicWriteFile ?? atomicWriteFile;
  }

  private ensureDir(): void {
    // M7: session files hold the full conversation (and any secrets it discussed). Lock the
    // directory to the owner (0700) so other local users can't enumerate or read sessions.
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private fileFor(id: string): string {
    return join(this.dir, `${fileStem(id)}.json`);
  }

  private lockDirFor(id: string): string {
    return join(this.dir, `${fileStem(id)}.lock`);
  }

  /**
   * Acquire the per-session write lock (BLOCKER-2). `mkdir` is atomic on POSIX, so it doubles as a
   * test-and-set: the first process to create `<id>.lock` owns it. If the directory already exists
   * we inspect its owner — a LIVE pid ⇒ refuse (throw `SessionLockedError`); a dead pid (or
   * `force`) ⇒ reclaim the stale lock and proceed. Throws only on genuine contention.
   */
  private acquireLock(id: string, force: boolean): void {
    const lockDir = this.lockDirFor(id);
    const ownerFile = join(lockDir, "owner.json");
    // At most two passes: try to create, and if reclaiming a stale lock, try once more.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        mkdirSync(lockDir, { mode: 0o700 }); // non-recursive ⇒ throws EEXIST if already held
        writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { encoding: "utf8", mode: 0o600 });
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; // unexpected fs error — surface it
        const owner = this.readLockOwner(ownerFile);
        if (!force && owner !== undefined && isPidAlive(owner.pid)) {
          throw new SessionLockedError(id, owner.pid, owner.startedAt);
        }
        // Stale (dead/unknown owner) or force: clear the lock and retry the create.
        log.warn({ sessionId: id, holderPid: owner?.pid, forced: force }, "chat-store: reclaiming stale/forced session lock");
        rmSync(lockDir, { recursive: true, force: true });
      }
    }
  }

  private readLockOwner(ownerFile: string): { pid: number; startedAt: number } | undefined {
    try {
      const parsed = JSON.parse(readFileSync(ownerFile, "utf8")) as { pid?: unknown; startedAt?: unknown };
      if (typeof parsed.pid !== "number") return undefined;
      return { pid: parsed.pid, startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : Number.NaN };
    } catch {
      return undefined; // missing/corrupt owner ⇒ treat as stale
    }
  }

  private releaseLock(id: string): void {
    try {
      rmSync(this.lockDirFor(id), { recursive: true, force: true });
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e), sessionId: id }, "chat-store: lock release failed");
    }
  }

  /**
   * Persist a session (overwrites its file) under a per-session lock (BLOCKER-2). Ordinary I/O
   * failures are logged, not thrown (the long-standing contract); a live-process LOCK conflict,
   * however, THROWS `SessionLockedError` so the operator learns of the collision instead of losing
   * the write silently. The lock is always released in `finally`.
   */
  async save(session: Persistable, opts: SaveOptions = {}): Promise<void> {
    this.ensureDir();
    this.acquireLock(session.id, opts.force === true); // throws SessionLockedError on live contention
    try {
      const data: PersistedSession = session.toPersisted();
      // M7: owner-only (0600) — the file is a transcript, not world-readable data.
      await this.atomicWriteFile(this.fileFor(session.id), JSON.stringify(data, null, 2), { mode: 0o600, logger: log });
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e), sessionId: session.id }, "chat-store: save failed");
    } finally {
      this.releaseLock(session.id);
    }
  }

  /** Read a session's raw persisted state from disk (undefined when absent/corrupt). */
  loadState(id: string): PersistedSession | undefined {
    const file = this.fileFor(id);
    if (!existsSync(file)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!isPersistedSession(parsed)) {
        log.warn({ sessionId: id }, "chat-store: load failed (invalid session shape)");
        return undefined;
      }
      return parsed;
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e), sessionId: id }, "chat-store: load failed (corrupt file?)");
      return undefined;
    }
  }

  /** Reconstruct a live ChatSession from disk (undefined when absent). `deps` lets callers
   *  inject an invoker/autosave; the persisted state is merged in as `restore`. */
  load(id: string, deps: ChatSessionDeps = {}): ChatSession | undefined {
    const state = this.loadState(id);
    if (state === undefined) return undefined;
    return new ChatSession(state.id, { ...deps, restore: state });
  }

  /** The `.json` session filenames currently in the directory ([] when the dir is absent). */
  private jsonFiles(): string[] {
    try {
      return readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    } catch {
      return []; // dir doesn't exist yet ⇒ nothing persisted
    }
  }

  /**
   * All persisted sessions' metadata, most-recently-used first, CAPPED at `maxSessions` (BLOCKER-3).
   * Lazily `prune()`s first when the directory has grown past 1.5× the cap, so a long-lived store
   * never has to parse hundreds of stale files on every list.
   */
  list(): SessionMeta[] {
    if (this.jsonFiles().length > this.maxSessions * 1.5) this.prune();
    const metas: SessionMeta[] = [];
    for (const f of this.jsonFiles()) {
      try {
        const s = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as unknown;
        if (!isPersistedSession(s)) continue;
        metas.push({
          id: s.id,
          ...(s.label !== undefined ? { label: s.label } : {}),
          worktree: s.worktree,
          messageCount: s.messages.length,
          createdAt: s.createdAt,
          lastUsedAt: s.lastUsedAt,
        });
      } catch {
        continue; // skip a corrupt file rather than failing the whole listing
      }
    }
    metas.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    return metas.slice(0, this.maxSessions);
  }

  /**
   * Bound the store to `maxSessions` (BLOCKER-3): keep the newest sessions, delete the rest (each
   * session's JSON + any leftover `.lock`). "Newest" is by the persisted `lastUsedAt` when readable,
   * falling back to file mtime (so a corrupt/unparseable file still gets ordered and pruned). Never
   * throws. Returns the number of sessions pruned.
   */
  prune(): number {
    const files = this.jsonFiles();
    if (files.length <= this.maxSessions) return 0;
    const ranked = files
      .map((f) => ({ f, key: this.recencyKey(join(this.dir, f)) }))
      .sort((a, b) => b.key - a.key);
    const doomed = ranked.slice(this.maxSessions);
    let pruned = 0;
    for (const { f } of doomed) {
      try {
        rmSync(join(this.dir, f), { force: true });
        // Also drop the matching lock dir (stem.lock) if one was left behind.
        const lockDir = join(this.dir, `${f.slice(0, -".json".length)}.lock`);
        rmSync(lockDir, { recursive: true, force: true });
        pruned += 1;
      } catch (e) {
        log.warn({ err: e instanceof Error ? e.message : String(e), file: f }, "chat-store: prune failed for file");
      }
    }
    if (pruned > 0) log.info({ pruned, kept: this.maxSessions, dir: this.dir }, "chat-store: pruned oldest sessions");
    return pruned;
  }

  /** Recency key for ordering during prune: persisted `lastUsedAt`, else file mtime, else 0. */
  private recencyKey(path: string): number {
    try {
      const s = JSON.parse(readFileSync(path, "utf8")) as PersistedSession;
      if (typeof s.lastUsedAt === "number" && Number.isFinite(s.lastUsedAt)) return s.lastUsedAt;
    } catch {
      // fall through to mtime
    }
    try {
      return statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  }

  /** Delete a persisted session. Returns true if a file was removed. */
  delete(id: string): boolean {
    const file = this.fileFor(id);
    if (!existsSync(file)) return false;
    try {
      rmSync(file);
      this.releaseLock(id); // drop any leftover lock so the id is fully reclaimable
      return true;
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e), sessionId: id }, "chat-store: delete failed");
      return false;
    }
  }

  /** Reconstruct the most-recently-used session, or undefined when none are persisted. */
  latest(deps: ChatSessionDeps = {}): ChatSession | undefined {
    const top = this.list()[0];
    if (top === undefined) return undefined;
    return this.load(top.id, deps);
  }
}

/** The process-wide persistent session store (default directory). */
export const persistentStore = new PersistentSessionStore();

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
 * BLOCKER-2 (concurrency): `save()` takes a per-session file lock (atomic `mkdir`) so two REPLs
 * on the same session can't silently clobber each other's writes.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { childLogger } from "../../core/log.js";
import { ChatSession, type ChatSessionDeps, type PersistedSession } from "./session.js";

const log = childLogger("chat-store");

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

  constructor(dir: string = sessionsDir()) {
    this.dir = dir;
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
  save(session: Persistable, opts: SaveOptions = {}): void {
    this.ensureDir();
    this.acquireLock(session.id, opts.force === true); // throws SessionLockedError on live contention
    try {
      const data: PersistedSession = session.toPersisted();
      // M7: owner-only (0600) — the file is a transcript, not world-readable data.
      writeFileSync(this.fileFor(session.id), JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
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
      return JSON.parse(readFileSync(file, "utf8")) as PersistedSession;
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

  /** All persisted sessions' metadata, most-recently-used first. */
  list(): SessionMeta[] {
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    } catch {
      return []; // dir doesn't exist yet ⇒ nothing persisted
    }
    const metas: SessionMeta[] = [];
    for (const f of files) {
      try {
        const s = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as PersistedSession;
        if (typeof s.id !== "string" || !Array.isArray(s.messages)) continue;
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
    return metas.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
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

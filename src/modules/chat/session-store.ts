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
 *
 * The store is the production `autosave` sink: ChatSession calls `save(this)` after every
 * turn (wired in cli.ts / routes.ts), so persistence needs no clean exit.
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

/** Map an arbitrary session id to a safe, collision-resistant file stem. */
function fileStem(id: string): string {
  // Keep readable ids readable; escape anything filesystem-unsafe deterministically.
  return id.replace(/[^A-Za-z0-9_-]/g, (c) => `_${c.charCodeAt(0).toString(16)}`);
}

/** A disk-backed session store: save/load/list/delete/latest under the sessions directory. */
export class PersistentSessionStore {
  private readonly dir: string;

  constructor(dir: string = sessionsDir()) {
    this.dir = dir;
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true });
  }

  private fileFor(id: string): string {
    return join(this.dir, `${fileStem(id)}.json`);
  }

  /** Persist a session (overwrites its file). Never throws — a failed write is logged, not fatal. */
  save(session: Persistable): void {
    try {
      this.ensureDir();
      const data: PersistedSession = session.toPersisted();
      writeFileSync(this.fileFor(session.id), JSON.stringify(data, null, 2), "utf8");
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e), sessionId: session.id }, "chat-store: save failed");
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

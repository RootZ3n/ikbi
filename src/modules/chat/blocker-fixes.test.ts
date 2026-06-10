/**
 * Senior-engineer audit blockers — runtime regression tests (the issues Fable 5's code-only pass
 * missed because they only manifest at runtime / across processes).
 *
 *   BLOCKER-1  /rollback injects a stale-context notice into the conversation so the model re-reads
 *              the reverted file instead of operating on its now-stale tool results.
 *   BLOCKER-2  the session store takes a per-session write lock — a write blocked by a LIVE holder
 *              fails loudly (SessionLockedError) instead of silently clobbering, and a stale lock is
 *              reclaimed so the write succeeds after cleanup.
 *   BLOCKER-3  the session store is bounded: list() caps at MAX_SESSIONS and prunes the oldest files,
 *              and the cap is configurable.
 *
 * Driven through a SCRIPTED invoker (no network, no real model), same harness style as the other
 * chat tests.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// EGRESS FIRST — ChatSession transits the provider singleton (see chat.test.ts).
import "../egress/index.js";

import type { ModelResponse, ToolCall } from "../../core/provider/contract.js";
import { ChatSession, type PersistedSession } from "./session.js";
import { PersistentSessionStore, SessionLockedError } from "./session-store.js";

function base(): Omit<ModelResponse, "content" | "finishReason" | "toolCalls"> {
  return {
    contractVersion: "1.1.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
    usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    cost: { usd: 0.0001, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
const stop = (content: string): ModelResponse => ({ ...base(), content, finishReason: "stop" });
const toolTurn = (...calls: ToolCall[]): ModelResponse => ({ ...base(), content: "", finishReason: "tool_calls", toolCalls: calls });
function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `c-${name}`, name, arguments: JSON.stringify(args) };
}
type Invoke = ConstructorParameters<typeof ChatSession>[1] extends { invoke?: infer F } ? F : never;
function queued(responses: ModelResponse[]): Invoke {
  let i = 0;
  return (async () => responses[Math.min(i++, responses.length - 1)] ?? stop("")) as unknown as Invoke;
}
const wt = (): string => mkdtempSync(join(tmpdir(), "ikbi-blocker-"));

// ── BLOCKER-1: rollback tells the model its tool results are stale ─────────────────

test("BLOCKER-1: /rollback injects a stale-context notice naming the reverted file", async () => {
  const dir = wt();
  // Turn 1: the model writes a file (records a mutation + leaves a tool result in the history).
  const s = new ChatSession("b1", { invoke: queued([toolTurn(call("write_file", { path: "src/auth.ts", content: "export const v = 2;\n" })), stop("done")]), worktree: dir });
  const res = await s.send("change auth", undefined, "agent");
  assert.ok(res.tools.some((t) => t.name === "write_file" && t.ok), "write_file ran and recorded a mutation");
  const before = s.toPersisted().messages.length;

  // Rollback the write. The file reverts on disk AND a notice must enter the conversation.
  const rolled = s.rollback(1);
  assert.equal(rolled.length, 1, "one mutation rolled back");

  const msgs = s.toPersisted().messages;
  assert.equal(msgs.length, before + 1, "exactly one notification message was appended");
  const notice = msgs[msgs.length - 1]!;
  assert.match(notice.content, /ROLLBACK NOTICE/i, "the notice is clearly a rollback notification");
  assert.match(notice.content, /stale/i, "the notice tells the model its prior results are stale");
  assert.match(notice.content, /re-read/i, "the notice instructs the model to re-read the file");
  assert.ok(notice.content.includes("src/auth.ts"), "the notice references the correct file path");
  assert.equal(notice.untrusted, true, "the notice is carried as isolated untrusted data, never a trusted slot");
  assert.notEqual(notice.role, "system", "the notice is not a system message (so restore keeps it)");
});

test("BLOCKER-1: a failed/empty rollback injects no notice", () => {
  const s = new ChatSession("b1-empty", { invoke: queued([stop("ok")]), worktree: wt() });
  const before = s.toPersisted().messages.length;
  const rolled = s.rollback(1); // nothing in the file history
  assert.equal(rolled.length, 0, "nothing to roll back");
  assert.equal(s.toPersisted().messages.length, before, "no spurious notification when nothing reverted");
});

// ── BLOCKER-2: session store write lock ────────────────────────────────────────────

test("BLOCKER-2: save() refuses when a LIVE process holds the lock, then succeeds after cleanup", () => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-lock-"));
  const store = new PersistentSessionStore(dir);
  const sess = new ChatSession("locked", { invoke: queued([stop("ok")]), worktree: dir });
  const persistable = { id: sess.id, toPersisted: () => sess.toPersisted() };

  // (1) plant a lock owned by a LIVE pid (this very process — guaranteed alive).
  const lockDir = join(dir, "locked.lock");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf8");

  // (2)+(3) the write is refused with a clear, actionable error.
  assert.throws(
    () => store.save(persistable),
    (e: unknown) => {
      assert.ok(e instanceof SessionLockedError, "a SessionLockedError is thrown");
      assert.equal((e as SessionLockedError).sessionId, "locked");
      assert.equal((e as SessionLockedError).holderPid, process.pid);
      assert.match((e as Error).message, /locked by PID/i, "the message names the holding PID");
      assert.match((e as Error).message, /--force/, "the message points at the --force escape hatch");
      return true;
    },
  );
  assert.ok(!existsSync(join(dir, "locked.json")), "no session file was written while locked");

  // (4) clean up the lock, (5) the write now succeeds.
  rmSync(lockDir, { recursive: true, force: true });
  store.save(persistable);
  assert.equal(store.load("locked")?.id, "locked", "write succeeds once the lock is gone");
});

test("BLOCKER-2: a STALE lock (dead pid) is reclaimed automatically; --force breaks a live lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-lock2-"));
  const store = new PersistentSessionStore(dir);
  const sess = new ChatSession("stale", { invoke: queued([stop("ok")]), worktree: dir });
  const persistable = { id: sess.id, toPersisted: () => sess.toPersisted() };

  // A lock owned by a pid that cannot be alive (a huge pid is reliably dead).
  const lockDir = join(dir, "stale.lock");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: 2147483646, startedAt: Date.now() }), "utf8");
  store.save(persistable); // must NOT throw — the stale lock is reclaimed
  assert.equal(store.load("stale")?.id, "stale", "stale lock reclaimed and write succeeded");

  // A LIVE lock is normally refused, but --force breaks it.
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf8");
  assert.throws(() => store.save(persistable), SessionLockedError, "live lock refused without force");
  store.save(persistable, { force: true }); // force breaks it
  assert.equal(store.load("stale")?.id, "stale", "force-unlock allowed the write");
});

// ── BLOCKER-3: bounded session store with pruning ──────────────────────────────────

function seedSessions(dir: string, count: number): void {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    const persisted: PersistedSession = {
      id: `sess-${i}`,
      worktree: dir,
      model: "mimo-v2.5",
      // lastUsedAt increases with i ⇒ higher i = newer. The OLDEST are the low-i sessions.
      messages: [{ role: "system", content: "x" }],
      memory: { facts: [], decisions: [], openQuestions: [] } as unknown as PersistedSession["memory"],
      createdAt: 1000 + i,
      lastUsedAt: 1000 + i,
      tokensIn: 0, tokensOut: 0, costUsd: 0, cachedTokens: 0, cacheSavedUsd: 0,
    };
    writeFileSync(join(dir, `sess-${i}.json`), JSON.stringify(persisted), "utf8");
  }
}

test("BLOCKER-3: list() caps at MAX_SESSIONS and prunes the oldest files", () => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-prune-"));
  const store = new PersistentSessionStore(dir, 100);
  // 160 > 100 * 1.5 (=150) ⇒ list() trips the lazy auto-prune (which fires only when the count
  // EXCEEDS 1.5× the cap, so the store doesn't prune on every single list).
  seedSessions(dir, 160);

  const metas = store.list();
  assert.equal(metas.length, 100, "list() returns at most MAX_SESSIONS");

  // The newest 100 (ids sess-60 .. sess-159) survive; the oldest 60 (sess-0 .. sess-59) are gone.
  const onDisk = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.equal(onDisk.length, 100, "the directory itself was pruned to the cap");
  assert.ok(!existsSync(join(dir, "sess-0.json")), "the oldest session file was deleted");
  assert.ok(!existsSync(join(dir, "sess-59.json")), "the 60th-oldest session file was deleted");
  assert.ok(existsSync(join(dir, "sess-159.json")), "the newest session file survived");
  assert.equal(metas[0]!.id, "sess-159", "newest sorts first");
  assert.ok(!metas.some((m) => m.id === "sess-0"), "the pruned oldest is absent from the listing");
});

test("BLOCKER-3: the max-sessions cap is configurable (constructor / IKBI_MAX_SESSIONS)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-prune2-"));
  seedSessions(dir, 40);

  // Constructor override: cap of 10 ⇒ list() returns 10 and prunes (40 > 10 * 1.5).
  const store = new PersistentSessionStore(dir, 10);
  assert.equal(store.list().length, 10, "constructor override caps the listing");
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 10, "and prunes to that cap");

  // Env override picked up by a default-cap store on a fresh dir.
  const dir2 = mkdtempSync(join(tmpdir(), "ikbi-prune3-"));
  seedSessions(dir2, 20);
  const prev = process.env.IKBI_MAX_SESSIONS;
  process.env.IKBI_MAX_SESSIONS = "5";
  try {
    const envStore = new PersistentSessionStore(dir2);
    assert.equal(envStore.list().length, 5, "IKBI_MAX_SESSIONS caps the listing");
  } finally {
    if (prev === undefined) delete process.env.IKBI_MAX_SESSIONS;
    else process.env.IKBI_MAX_SESSIONS = prev;
  }
});

test("BLOCKER-3: prune() also removes a pruned session's leftover lock dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-prune4-"));
  const store = new PersistentSessionStore(dir, 5);
  seedSessions(dir, 8); // 8 > 5 ⇒ prune deletes the 3 oldest
  // Leave a stray lock dir behind for the oldest session.
  mkdirSync(join(dir, "sess-0.lock"), { recursive: true });

  const pruned = store.prune();
  assert.equal(pruned, 3, "the three oldest sessions were pruned");
  assert.ok(!existsSync(join(dir, "sess-0.json")), "oldest session JSON removed");
  assert.ok(!existsSync(join(dir, "sess-0.lock")), "its leftover lock dir was removed too");
});

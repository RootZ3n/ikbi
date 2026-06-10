/**
 * P1 FIX 1 + FIX 2: PERSISTENT SESSION STORE — sessions survive a restart and can be
 * listed / labelled / deleted. Backed by JSON files under IKBI_SESSIONS_DIR.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

// EGRESS FIRST — ChatSession transits the provider singleton (see chat.test.ts).
import "../egress/index.js";

import type { ModelResponse } from "../../core/provider/contract.js";
import { ChatSession } from "./session.js";
import { PersistentSessionStore } from "./session-store.js";

function base(): Omit<ModelResponse, "content" | "finishReason" | "toolCalls"> {
  return {
    contractVersion: "1.1.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
    usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
    cost: { usd: 0.0002, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
const stop = (content: string): ModelResponse => ({ ...base(), content, finishReason: "stop" });

function scripted(responses: ModelResponse[]) {
  let i = 0;
  const invoke = (async () => {
    const r = responses[Math.min(i, responses.length - 1)] ?? stop("");
    i += 1;
    return r;
  }) as unknown as ConstructorParameters<typeof ChatSession>[1] extends { invoke?: infer F } ? F : never;
  return { invoke };
}

const wt = (): string => mkdtempSync(join(tmpdir(), "ikbi-store-wt-"));

let dir: string;
let store: PersistentSessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ikbi-sessions-"));
  store = new PersistentSessionStore(dir);
});
afterEach(() => {
  // leave the temp dirs for the OS to reap; nothing global to reset
});

test("FIX1: send() auto-saves the session to disk; load() restores the messages", async () => {
  const { invoke } = scripted([stop("Foundation is solid.")]);
  const s = new ChatSession("sess-a", { invoke, worktree: wt(), autosave: (x) => store.save(x) });
  await s.send("status?");

  // A session file now exists on disk.
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1, "exactly one session file written");

  // Reload from disk into a FRESH store instance (simulating a restart).
  const reborn = new PersistentSessionStore(dir);
  const loaded = reborn.load("sess-a", { invoke });
  assert.ok(loaded, "session loaded from disk");
  const persisted = loaded!.toPersisted();
  assert.equal(persisted.id, "sess-a");
  assert.ok(persisted.messages.some((m) => m.role === "user" && m.content.includes("status?")), "user turn restored");
  assert.ok(persisted.messages.some((m) => m.role === "assistant" && m.content.includes("Foundation is solid")), "assistant turn restored");
  // Cumulative usage survives the round-trip.
  assert.equal(persisted.tokensIn, 7);
  assert.equal(persisted.tokensOut, 3);
});

test("FIX1: a resumed session carries its history into the next turn", async () => {
  const { invoke } = scripted([stop("first reply")]);
  const s = new ChatSession("sess-b", { invoke, worktree: wt(), autosave: (x) => store.save(x) });
  await s.send("first message");

  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const invoke2 = (async (req: unknown) => {
    requests.push(req as { messages: Array<{ role: string; content: string }> });
    return stop("second reply");
  }) as unknown as ConstructorParameters<typeof ChatSession>[1] extends { invoke?: infer F } ? F : never;

  const resumed = store.load("sess-b", { invoke: invoke2 });
  assert.ok(resumed);
  await resumed!.send("second message");
  const sent = requests[0]!.messages;
  assert.ok(sent.some((m) => m.role === "user" && m.content.includes("first message")), "resumed turn carries prior user message");
  assert.ok(sent.some((m) => m.role === "assistant" && m.content.includes("first reply")), "resumed turn carries prior assistant reply");
});

test("FIX2: list() returns saved sessions sorted by lastUsedAt (most recent first)", async () => {
  const { invoke } = scripted([stop("ok")]);
  const a = new ChatSession("s1", { invoke, worktree: wt(), autosave: (x) => store.save(x) });
  await a.send("hi");
  const b = new ChatSession("s2", { invoke, worktree: wt(), autosave: (x) => store.save(x) });
  await b.send("hi");
  const c = new ChatSession("s3", { invoke, worktree: wt(), autosave: (x) => store.save(x) });
  await c.send("hi");
  // Bump s1 so it becomes most-recent.
  await new Promise((r) => setTimeout(r, 2));
  await a.send("again");

  const metas = store.list();
  assert.equal(metas.length, 3, "all three sessions listed");
  assert.equal(metas[0]!.id, "s1", "s1 (touched last) sorts first");
  assert.deepEqual([...metas.map((m) => m.id)].sort(), ["s1", "s2", "s3"], "all ids present");
});

test("FIX2: label persists and surfaces in list(); delete() removes a session", async () => {
  const { invoke } = scripted([stop("ok")]);
  const a = new ChatSession("L1", { invoke, worktree: wt(), autosave: (x) => store.save(x) });
  await a.send("hi");
  a.label = "auth-refactor";
  store.save(a);

  const meta = store.list().find((m) => m.id === "L1");
  assert.equal(meta?.label, "auth-refactor", "label surfaces in the listing");

  assert.equal(store.delete("L1"), true, "delete reports success");
  assert.equal(store.delete("L1"), false, "deleting again reports not-found");
  assert.ok(!store.list().some((m) => m.id === "L1"), "deleted session is gone from the list");
  assert.ok(!existsSync(join(dir, "L1.json")), "the file is removed");
});

test("FIX1: latest() reconstructs the most-recently-used session", async () => {
  const { invoke } = scripted([stop("ok")]);
  const a = new ChatSession("p1", { invoke, worktree: wt(), autosave: (x) => store.save(x) });
  await a.send("one");
  await new Promise((r) => setTimeout(r, 2));
  const b = new ChatSession("p2", { invoke, worktree: wt(), autosave: (x) => store.save(x) });
  await b.send("two");

  const latest = store.latest({ invoke });
  assert.equal(latest?.id, "p2", "latest is the most-recently-saved session");
});

test("FIX1: load() of an unknown id returns undefined (no throw)", () => {
  assert.equal(store.load("does-not-exist"), undefined);
  assert.equal(store.loadState("does-not-exist"), undefined);
});

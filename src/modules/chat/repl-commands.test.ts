/**
 * P1 FIX 2 + FIX 4 + FIX 5: the REPL slash-command registry — /help, /status, /cost,
 * /model, /compact, /reset, /sessions, /label, /delete, /memory — driven through runRepl
 * with injected readLine/out, a persistent store, and a fresh-session factory.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import "../egress/index.js";

import type { ModelResponse } from "../../core/provider/contract.js";
import { ChatSession } from "./session.js";
import { PersistentSessionStore } from "./session-store.js";
import { runRepl } from "./cli.js";

function base(): Omit<ModelResponse, "content" | "finishReason" | "toolCalls"> {
  return {
    contractVersion: "1.1.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
    usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    cost: { usd: 0.0005, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
const stop = (content: string): ModelResponse => ({ ...base(), content, finishReason: "stop" });

function alwaysStop(content: string) {
  const invoke = (async () => stop(content)) as unknown as ConstructorParameters<typeof ChatSession>[1] extends { invoke?: infer F } ? F : never;
  return invoke;
}

/** A readLine source over a fixed list; resolves null when exhausted. */
function lines(arr: string[]): () => Promise<string | null> {
  let i = 0;
  return () => Promise.resolve(i < arr.length ? (arr[i++] as string) : null);
}

const wt = (): string => mkdtempSync(join(tmpdir(), "ikbi-rc-wt-"));

let storeDir: string;
let store: PersistentSessionStore;
let prevInstr: string | undefined;

beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), "ikbi-rc-sessions-"));
  store = new PersistentSessionStore(storeDir);
  prevInstr = process.env.IKBI_INSTRUCTIONS_FILE;
  process.env.IKBI_INSTRUCTIONS_FILE = join(mkdtempSync(join(tmpdir(), "ikbi-rc-instr-")), "instructions.md");
});
afterEach(() => {
  if (prevInstr === undefined) delete process.env.IKBI_INSTRUCTIONS_FILE;
  else process.env.IKBI_INSTRUCTIONS_FILE = prevInstr;
});

function mkSession(id: string): ChatSession {
  return new ChatSession(id, { invoke: alwaysStop("ok reply"), worktree: wt(), autosave: (s) => store.save(s) });
}

test("FIX4: /help lists all the commands", async () => {
  let out = "";
  await runRepl({ session: mkSession("h1"), store, readLine: lines(["/help", "/exit"]), out: (s) => { out += s; } });
  for (const c of ["/help", "/status", "/cost", "/model", "/compact", "/reset", "/sessions", "/label", "/delete", "/memory", "/plan", "/agent"]) {
    assert.ok(out.includes(c), `help lists ${c}`);
  }
});

test("FIX4: /status shows session info", async () => {
  let out = "";
  await runRepl({ session: mkSession("st1"), store, readLine: lines(["/status", "/exit"]), out: (s) => { out += s; } });
  assert.match(out, /id:\s+st1/);
  assert.match(out, /model:\s+/);
  assert.match(out, /mode:\s+agent/);
});

test("FIX4: /cost shows token counts after a turn", async () => {
  let out = "";
  await runRepl({ session: mkSession("c1"), store, readLine: lines(["hello", "/cost", "/exit"]), out: (s) => { out += s; } });
  assert.match(out, /tokens — in: 5, out: 2, total: 7/);
  assert.match(out, /estimated cost: \$0\.0005/);
});

test("FIX3: a turn prints the context bar", async () => {
  let out = "";
  await runRepl({ session: mkSession("cb1"), store, readLine: lines(["hello", "/exit"]), out: (s) => { out += s; } });
  assert.match(out, /\[ctx: \d+%\]/, "context bar shown after the reply");
});

test("FIX2: /label then /sessions shows the label and a * on the current session", async () => {
  const s = mkSession("lbl1");
  let out = "";
  await runRepl({ session: s, store, readLine: lines(["hello", "/label auth-work", "/sessions", "/exit"]), out: (o) => { out += o; } });
  assert.match(out, /labelled current session: "auth-work"/);
  assert.match(out, /\*\s+lbl1 "auth-work"/, "current session marked with * and shows its label");
});

test("FIX2: /delete removes a session from the listing", async () => {
  // Pre-seed a second session on disk.
  const other = mkSession("victim");
  await other.send("seed");
  const s = mkSession("keeper");
  let out = "";
  await runRepl({ session: s, store, readLine: lines(["hello", "/delete victim", "/sessions", "/exit"]), out: (o) => { out += o; } });
  assert.match(out, /deleted session victim/);
  assert.ok(!/\bvictim\b/.test(out.split("deleted session victim")[1] ?? ""), "victim no longer listed after deletion");
});

test("FIX4: /reset confirmed swaps in a fresh session", async () => {
  let count = 0;
  const factory = (): ChatSession => mkSession(`reset-${count++}`);
  const s = factory();
  let out = "";
  await runRepl({ session: s, store, newSession: factory, readLine: lines(["/reset", "y", "/status", "/exit"]), out: (o) => { out += o; } });
  assert.match(out, /new session started: reset-1/, "a fresh session replaced the old one");
  assert.match(out, /id:\s+reset-1/, "/status now reflects the new session");
});

test("FIX4: /reset declined keeps the current session", async () => {
  let count = 0;
  const factory = (): ChatSession => mkSession(`keep-${count++}`);
  const s = factory();
  let out = "";
  await runRepl({ session: s, store, newSession: factory, readLine: lines(["/reset", "n", "/status", "/exit"]), out: (o) => { out += o; } });
  assert.match(out, /reset cancelled/);
  assert.match(out, /id:\s+keep-0/, "the original session is retained");
});

test("FIX4: /model shows current then switches", async () => {
  let out = "";
  await runRepl({ session: mkSession("m1"), store, readLine: lines(["/model", "/model deepseek-chat", "/status", "/exit"]), out: (o) => { out += o; } });
  assert.match(out, /current model: mimo-v2\.5/);
  assert.match(out, /model switched to deepseek-chat/);
  assert.match(out, /model:\s+deepseek-chat/);
});

test("FIX3: /compact reduces the message count", async () => {
  const s = mkSession("cmp1");
  for (let i = 0; i < 6; i += 1) await s.send(`turn ${i}`);
  const before = s.messageCount();
  let out = "";
  await runRepl({ session: s, store, readLine: lines(["/compact", "/exit"]), out: (o) => { out += o; } });
  assert.match(out, /compacted: \d+ → \d+ messages/);
  assert.ok(s.messageCount() < before, "history shrank");
});

test("FIX5: /memory add then /memory show round-trips", async () => {
  let out = "";
  await runRepl({ session: mkSession("mem1"), store, readLine: lines(["/memory add Always squash commits", "/memory", "/exit"]), out: (o) => { out += o; } });
  assert.match(out, /added instruction/);
  assert.match(out, /Always squash commits/);
});

test("FIX4: an unknown slash command is reported, not sent to the model", async () => {
  let out = "";
  await runRepl({ session: mkSession("u1"), store, readLine: lines(["/bogus", "/exit"]), out: (o) => { out += o; } });
  assert.match(out, /unknown command: \/bogus/);
});

test("H3: aborting an in-flight turn prints an interrupted result and exits cleanly", async () => {
  let sawSignal = false;
  const session = {
    id: "abort-1",
    currentPermissionMode: () => "confirm" as const,
    send: async (_msg: string, _images?: readonly string[], _mode?: unknown, opts?: { signal?: AbortSignal }) => {
      sawSignal = opts?.signal instanceof AbortSignal;
      await new Promise<void>((resolve) => {
        if (opts?.signal?.aborted === true) return resolve();
        opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { response: "[ikbi: interrupted]", tools: [] };
    },
  };
  let out = "";
  let controller: AbortController | undefined;
  await runRepl({
    session,
    store,
    readLine: lines(["slow turn", "/exit"]),
    out: (o) => { out += o; },
    onTurnController: (c) => {
      controller = c;
      if (c !== undefined) setImmediate(() => c.abort());
    },
  });

  assert.equal(sawSignal, true, "turn received an AbortSignal");
  assert.equal(controller, undefined, "runRepl clears the active turn controller after the turn");
  assert.match(out, /\[ikbi: interrupted\]/);
  assert.match(out, /session ended/);
});

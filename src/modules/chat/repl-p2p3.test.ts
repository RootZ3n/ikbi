/**
 * REPL P2+P3 — REPL-surface behavior driven through runRepl: progress indicators (FIX 4),
 * /rollback (FIX 1), /permissions (FIX 5), /cost cache line (FIX 7), and /model hot-swap
 * context-preserved messaging (FIX 8). Injected readLine/out, scripted invoker.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import "../egress/index.js";

import type { ModelResponse, ToolCall } from "../../core/provider/contract.js";
import { ChatSession } from "./session.js";
import { PersistentSessionStore } from "./session-store.js";
import { runRepl } from "./cli.js";

type Invoke = ConstructorParameters<typeof ChatSession>[1] extends { invoke?: infer F } ? F : never;

function base(cached?: number): Omit<ModelResponse, "content" | "finishReason" | "toolCalls"> {
  return {
    contractVersion: "1.1.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
    usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, ...(cached !== undefined ? { cachedTokens: cached } : {}) },
    cost: { usd: 0.001, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 1, completionPerMTok: 1, cachedPromptPerMTok: 0.25 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
const stop = (content: string, cached?: number): ModelResponse => ({ ...base(cached), content, finishReason: "stop" });
function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `c-${name}`, name, arguments: JSON.stringify(args) };
}
const toolTurn = (...calls: ToolCall[]): ModelResponse => ({ ...base(), content: "", finishReason: "tool_calls", toolCalls: calls });

function queued(responses: ModelResponse[]): Invoke {
  let i = 0;
  return (async () => responses[Math.min(i++, responses.length - 1)] ?? stop("")) as unknown as Invoke;
}
function lines(arr: string[]): () => Promise<string | null> {
  let i = 0;
  return () => Promise.resolve(i < arr.length ? (arr[i++] as string) : null);
}
const wt = (): string => mkdtempSync(join(tmpdir(), "ikbi-rp-wt-"));
function store(): PersistentSessionStore {
  return new PersistentSessionStore(mkdtempSync(join(tmpdir(), "ikbi-rp-store-")));
}

test("FIX4: a turn emits a progress spinner while working", async () => {
  const s = new ChatSession("prog-1", { invoke: queued([stop("answer")]), worktree: wt() });
  let out = "";
  await runRepl({ session: s, store: store(), readLine: lines(["do a thing", "/exit"]), out: (o) => { out += o; } });
  assert.match(out, /⟳ Thinking/, "the thinking spinner appeared during the turn");
  assert.match(out, /answer/, "the final reply still prints");
});

test("FIX1: /rollback through the REPL undoes the last write", async () => {
  const dir = wt();
  writeFileSync(join(dir, "r.ts"), "BEFORE\n");
  const invoke = queued([toolTurn(call("write_file", { path: "r.ts", content: "AFTER\n" })), stop("wrote it")]);
  const s = new ChatSession("rbrepl-1", { invoke, worktree: dir });
  let out = "";
  await runRepl({ session: s, store: store(), readLine: lines(["rewrite r", "/rollback", "/exit"]), out: (o) => { out += o; } });
  assert.match(out, /Rolled back: write_file r\.ts/);
  assert.equal(readFileSync(join(dir, "r.ts"), "utf8"), "BEFORE\n", "file restored via the REPL command");
});

test("FIX3: an inline diff is rendered after a file mutation", async () => {
  const dir = wt();
  writeFileSync(join(dir, "x.ts"), "old\n");
  const invoke = queued([toolTurn(call("write_file", { path: "x.ts", content: "new\n" })), stop("done")]);
  const s = new ChatSession("diffrepl-1", { invoke, worktree: dir });
  let out = "";
  await runRepl({ session: s, store: store(), readLine: lines(["edit x", "/exit"]), out: (o) => { out += o; } });
  assert.ok(out.includes("-old"), "removed line shown in the inline diff");
  assert.ok(out.includes("+new"), "added line shown in the inline diff");
});

test("FIX5: /permissions readonly blocks a subsequent write tool", async () => {
  const dir = wt();
  const invoke = queued([toolTurn(call("write_file", { path: "nope.ts", content: "x\n" })), stop("ok")]);
  const s = new ChatSession("permrepl-1", { invoke, worktree: dir });
  let out = "";
  await runRepl({ session: s, store: store(), readLine: lines(["/permissions readonly", "make an edit", "/exit"]), out: (o) => { out += o; } });
  assert.match(out, /permission mode set to readonly/);
  assert.match(out, /write_file✗/, "the blocked write is marked failed in the tool line");
  assert.ok(!existsSync(join(dir, "nope.ts")), "no file written under readonly");
});

test("FIX5: /permissions confirm + a 'n' answer blocks the write", async () => {
  const dir = wt();
  const invoke = queued([toolTurn(call("write_file", { path: "ask.ts", content: "x\n" })), stop("ok")]);
  const s = new ChatSession("permrepl-2", { invoke, worktree: dir });
  let out = "";
  await runRepl({ session: s, store: store(), readLine: lines(["/permissions confirm", "make an edit", "n", "/exit"]), out: (o) => { out += o; } });
  assert.match(out, /Allow write_file ask\.ts\? \[y\/N\]/, "the operator was prompted with default-no");
  assert.ok(!existsSync(join(dir, "ask.ts")), "the declined write never happened");
});

test("FIX5: confirm mode defaults to NO when the operator presses Enter", async () => {
  const dir = wt();
  const invoke = queued([toolTurn(call("write_file", { path: "enter.ts", content: "x\n" })), stop("ok")]);
  const s = new ChatSession("permrepl-enter", { invoke, worktree: dir, permissionMode: "confirm" });
  let out = "";
  await runRepl({ session: s, store: store(), readLine: lines(["make an edit", "", "/exit"]), out: (o) => { out += o; } });
  assert.match(out, /Allow write_file enter\.ts\? \[y\/N\]/);
  assert.ok(!existsSync(join(dir, "enter.ts")), "blank confirmation denies the mutating tool");
});

test("BLOCKER2: /diff shows pending git changes and /discard rolls back tracked chat edits", async () => {
  const dir = wt();
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "d.ts"), "old\n");
  execFileSync("git", ["add", "d.ts"], { cwd: dir, stdio: "ignore" });
  const invoke = queued([toolTurn(call("write_file", { path: "d.ts", content: "new\n" })), stop("done")]);
  const s = new ChatSession("diff-discard", { invoke, worktree: dir });
  let out = "";
  await runRepl({ session: s, store: store(), readLine: lines(["edit", "/diff", "/discard", "/exit"]), out: (o) => { out += o; } });
  assert.ok(out.includes("-old"), "diff shows the removed line");
  assert.ok(out.includes("+new"), "diff shows the added line");
  assert.match(out, /Discarded: write_file d\.ts/);
  assert.equal(readFileSync(join(dir, "d.ts"), "utf8"), "old\n");
});

test("FIX7: /cost surfaces the cache hit rate after a cached turn", async () => {
  const s = new ChatSession("costrepl-1", { invoke: queued([stop("hi", 40)]), worktree: wt() });
  let out = "";
  await runRepl({ session: s, store: store(), readLine: lines(["hello", "/cost", "/exit"]), out: (o) => { out += o; } });
  assert.match(out, /Cache hit rate: 40%/);
});

test("FIX8: /model hot-swap reports context preserved and switches the model", async () => {
  const requests: Array<{ model: string }> = [];
  const invoke = (async (req: unknown) => { requests.push(req as { model: string }); return stop("ok"); }) as unknown as Invoke;
  const s = new ChatSession("modelrepl-1", { invoke, worktree: wt(), model: "mimo-v2.5" });
  let out = "";
  await runRepl({ session: s, store: store(), readLine: lines(["/model deepseek-chat", "after swap", "/exit"]), out: (o) => { out += o; } });
  assert.match(out, /model switched to deepseek-chat — context preserved \(mimo-v2\.5 → deepseek-chat\)/);
  assert.equal(requests.at(-1)!.model, "deepseek-chat", "the next turn used the swapped model");
});

test("HIGH3: /model rejects nonexistent models and keeps the current model", async () => {
  const requests: Array<{ model: string }> = [];
  const invoke = (async (req: unknown) => { requests.push(req as { model: string }); return stop("ok"); }) as unknown as Invoke;
  const s = new ChatSession("modelrepl-fake", { invoke, worktree: wt(), model: "mimo-v2.5" });
  let out = "";
  await runRepl({ session: s, store: store(), readLine: lines(["/model fake-model-does-not-exist", "after failed swap", "/exit"]), out: (o) => { out += o; } });
  assert.match(out, /model unavailable: fake-model-does-not-exist/);
  assert.equal(requests.at(-1)!.model, "mimo-v2.5", "the failed switch did not change the active model");
});

test("FIX4/5: /help now lists /rollback and /permissions", async () => {
  const s = new ChatSession("help-1", { invoke: queued([stop("ok")]), worktree: wt() });
  let out = "";
  await runRepl({ session: s, store: store(), readLine: lines(["/help", "/exit"]), out: (o) => { out += o; } });
  assert.match(out, /\/rollback/);
  assert.match(out, /\/permissions/);
});

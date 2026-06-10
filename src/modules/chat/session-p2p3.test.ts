/**
 * REPL P2+P3 — session-level behavior: file rollback (FIX 1), inline diffs (FIX 3),
 * permission modes (FIX 5), prompt-cache counters (FIX 7), and error-recovery hints (FIX 9).
 * Driven through a SCRIPTED invoker that emits tool calls — no network, no real model.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import "../egress/index.js";

import type { ModelResponse, ToolCall } from "../../core/provider/contract.js";
import { boundDiff, ChatSession, computeLineDiff, errorRecoveryHint } from "./session.js";

type Invoke = ConstructorParameters<typeof ChatSession>[1] extends { invoke?: infer F } ? F : never;

function base(cachedTokens?: number): Omit<ModelResponse, "content" | "finishReason" | "toolCalls"> {
  return {
    contractVersion: "1.1.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
    usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, ...(cachedTokens !== undefined ? { cachedTokens } : {}) },
    cost: { usd: 0.001, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 1, completionPerMTok: 1, cachedPromptPerMTok: 0.25 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
const stop = (content: string, cached?: number): ModelResponse => ({ ...base(cached), content, finishReason: "stop" });
function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `c-${name}-${Math.round(args.n as number ?? 0)}`, name, arguments: JSON.stringify(args) };
}
const toolTurn = (...calls: ToolCall[]): ModelResponse => ({ ...base(), content: "", finishReason: "tool_calls", toolCalls: calls });

/** A queue-backed invoker: returns each scripted response in order, repeating the last. */
function queued(responses: ModelResponse[]): Invoke {
  let i = 0;
  return (async () => responses[Math.min(i++, responses.length - 1)] ?? stop("")) as unknown as Invoke;
}

const wt = (): string => mkdtempSync(join(tmpdir(), "ikbi-p2p3-"));

// ── FIX 1: file rollback ──────────────────────────────────────────────────────

test("FIX1: /rollback restores a written file to its prior content", async () => {
  const dir = wt();
  writeFileSync(join(dir, "foo.ts"), "ORIGINAL\n");
  const invoke = queued([toolTurn(call("write_file", { path: "foo.ts", content: "CHANGED\n" })), stop("done")]);
  const s = new ChatSession("rb-1", { invoke, worktree: dir });
  await s.send("rewrite foo");
  assert.equal(readFileSync(join(dir, "foo.ts"), "utf8"), "CHANGED\n", "the write happened");

  const results = s.rollback();
  assert.equal(results.length, 1);
  assert.equal(results[0]!.tool, "write_file");
  assert.match(results[0]!.action, /restored to previous content/);
  assert.equal(readFileSync(join(dir, "foo.ts"), "utf8"), "ORIGINAL\n", "rolled back to the original");
});

test("FIX1: rolling back a newly-created file deletes it", async () => {
  const dir = wt();
  const invoke = queued([toolTurn(call("write_file", { path: "new.ts", content: "hi\n" })), stop("done")]);
  const s = new ChatSession("rb-2", { invoke, worktree: dir });
  await s.send("create new");
  assert.ok(existsSync(join(dir, "new.ts")), "the file was created");
  const [r] = s.rollback();
  assert.match(r!.action, /deleted/);
  assert.ok(!existsSync(join(dir, "new.ts")), "the newly-created file was deleted on rollback");
});

test("FIX1: /rollback 3 reverses the last 3 mutations, newest first", async () => {
  const dir = wt();
  writeFileSync(join(dir, "f.ts"), "v0\n");
  const invoke = queued([
    toolTurn(call("write_file", { path: "f.ts", content: "v1\n" })), stop("1"),
    toolTurn(call("write_file", { path: "f.ts", content: "v2\n" })), stop("2"),
    toolTurn(call("write_file", { path: "f.ts", content: "v3\n" })), stop("3"),
  ]);
  const s = new ChatSession("rb-3", { invoke, worktree: dir });
  await s.send("a"); await s.send("b"); await s.send("c");
  assert.equal(readFileSync(join(dir, "f.ts"), "utf8"), "v3\n");
  const results = s.rollback(3);
  assert.equal(results.length, 3, "three steps reported");
  assert.equal(readFileSync(join(dir, "f.ts"), "utf8"), "v0\n", "back to the original after 3 rollbacks");
});

test("FIX1: rollback with nothing to undo returns an empty result", async () => {
  const s = new ChatSession("rb-4", { invoke: queued([stop("hi")]), worktree: wt() });
  await s.send("just talk");
  assert.deepEqual(s.rollback(), []);
});

// ── FIX 3: inline diffs ─────────────────────────────────────────────────────────

test("FIX3: a write_file mutation carries a colorizable diff in its activity", async () => {
  const dir = wt();
  writeFileSync(join(dir, "d.ts"), "line1\nline2\n");
  const invoke = queued([toolTurn(call("write_file", { path: "d.ts", content: "line1\nCHANGED\n" })), stop("done")]);
  const s = new ChatSession("diff-1", { invoke, worktree: dir });
  const res = await s.send("edit it");
  const wrote = res.tools.find((t) => t.name === "write_file");
  assert.ok(wrote?.diff !== undefined, "the write activity carries a diff");
  assert.match(wrote!.diff!, /-line2/);
  assert.match(wrote!.diff!, /\+CHANGED/);
});

test("FIX3: computeLineDiff collapses common context; boundDiff caps at 50 lines", () => {
  const before = Array.from({ length: 5 }, (_, i) => `k${i}`).join("\n");
  const after = ["k0", "k1", "EDIT", "k3", "k4"].join("\n");
  const diff = computeLineDiff(before, after);
  assert.equal(diff, "-k2\n+EDIT", "only the changed middle line shows, not the shared context");

  const huge = Array.from({ length: 200 }, (_, i) => `+added ${i}`).join("\n");
  const bounded = boundDiff(huge);
  const lines = bounded.split("\n");
  assert.ok(lines.length <= 51, "bounded to ~50 lines plus the marker");
  assert.match(bounded, /\.\.\. \(\d+ more lines\) \.\.\./);
});

// ── FIX 5: permission modes ─────────────────────────────────────────────────────

test("FIX5: readonly mode blocks write_file (file untouched)", async () => {
  const dir = wt();
  const invoke = queued([toolTurn(call("write_file", { path: "blocked.ts", content: "x\n" })), stop("ok")]);
  const s = new ChatSession("perm-1", { invoke, worktree: dir });
  const res = await s.send("try a write", undefined, "agent", { permissionMode: "readonly" });
  const wrote = res.tools.find((t) => t.name === "write_file");
  assert.equal(wrote?.ok, false, "the write was blocked");
  assert.match(wrote!.summary ?? "", /readonly/);
  assert.ok(!existsSync(join(dir, "blocked.ts")), "no file was written under readonly");
});

test("FIX5: confirm mode blocks the tool when the operator declines", async () => {
  const dir = wt();
  const invoke = queued([toolTurn(call("write_file", { path: "ask.ts", content: "x\n" })), stop("ok")]);
  const s = new ChatSession("perm-2", { invoke, worktree: dir });
  const seen: string[] = [];
  const res = await s.send("try a write", undefined, "agent", {
    permissionMode: "confirm",
    confirm: async (tool, target) => { seen.push(`${tool} ${target}`); return false; },
  });
  assert.deepEqual(seen, ["write_file ask.ts"], "the operator was asked with the tool + target");
  assert.equal(res.tools.find((t) => t.name === "write_file")?.ok, false);
  assert.ok(!existsSync(join(dir, "ask.ts")), "declined write never happened");
});

test("FIX5: confirm mode allows the tool when the operator accepts", async () => {
  const dir = wt();
  const invoke = queued([toolTurn(call("write_file", { path: "ok.ts", content: "yes\n" })), stop("ok")]);
  const s = new ChatSession("perm-3", { invoke, worktree: dir });
  const res = await s.send("write it", undefined, "agent", { permissionMode: "confirm", confirm: async () => true });
  assert.equal(res.tools.find((t) => t.name === "write_file")?.ok, true);
  assert.equal(readFileSync(join(dir, "ok.ts"), "utf8"), "yes\n");
});

// ── FIX 7: prompt-cache counters ────────────────────────────────────────────────

test("FIX7: cached tokens accumulate into usage() + cacheHitPercent()", async () => {
  const invoke = queued([stop("hi", 40)]); // 40 of the 100 prompt tokens were cache hits
  const s = new ChatSession("cache-1", { invoke, worktree: wt() });
  await s.send("hello");
  const u = s.usage();
  assert.equal(u.cachedTokens, 40);
  assert.equal(s.cacheHitPercent(), 40, "40/100 prompt tokens = 40%");
  assert.ok(u.cacheSavedUsd > 0, "a positive estimated saving was recorded");
});

// ── FIX 9: error-recovery hints ─────────────────────────────────────────────────

test("FIX9: errorRecoveryHint maps known error patterns to one-line hints", () => {
  assert.match(errorRecoveryHint("ERROR: read failed: ENOENT ...")!, /File not found/);
  assert.match(errorRecoveryHint("EACCES: permission denied")!, /Permission denied/);
  assert.match(errorRecoveryHint("Error: Cannot find module 'x' MODULE_NOT_FOUND")!, /npm install/);
  assert.match(errorRecoveryHint("src/x.ts(1,1): error TS2345: ...")!, /function signature/);
  assert.match(errorRecoveryHint("FAILED (exit 1)\nsome output")!, /Check the output above/);
  assert.equal(errorRecoveryHint("all good"), undefined);
});

test("FIX9: a failing tool's appended hint reaches the conversation", async () => {
  const dir = wt();
  const invoke = queued([toolTurn(call("read_file", { path: "missing.ts" })), stop("done")]);
  const s = new ChatSession("hint-1", { invoke, worktree: dir });
  await s.send("read a missing file");
  const toolMsg = s.toPersisted().messages.find((m) => m.role === "tool");
  assert.ok(toolMsg !== undefined, "a tool result message was recorded");
  assert.match(String(toolMsg!.content), /\[hint: File not found/, "the recovery hint is appended to the output");
});

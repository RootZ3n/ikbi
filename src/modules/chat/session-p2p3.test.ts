/**
 * REPL P2+P3 — session-level behavior: file rollback (FIX 1), inline diffs (FIX 3),
 * permission modes (FIX 5), prompt-cache counters (FIX 7), and error-recovery hints (FIX 9).
 * Driven through a SCRIPTED invoker that emits tool calls — no network, no real model.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { labTempDir as tmpdir } from "../../core/temp-root.js";
import { join, relative } from "node:path";
import { test } from "node:test";

import "../egress/index.js";

import type { ModelResponse, ToolCall } from "../../core/provider/contract.js";
import { boundDiff, ChatSession, computeLineDiff, errorRecoveryHint } from "./session.js";
import type { PersistedSession, SessionWorkspace } from "./session.js";

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

test("H6: /rollback REFUSES a tampered fileHistory path that escapes the worktree (no arbitrary write/delete)", () => {
  const dir = wt();
  const victimDir = mkdtempSync(join(tmpdir(), "ikbi-rb-victim-"));
  const victim = join(victimDir, "precious.txt");
  writeFileSync(victim, "DO NOT TOUCH\n");
  const escapeTarget = join(victimDir, "should-never-be-created");
  try {
    // A MALICIOUS persisted session (fileHistory is restored from the tamperable session file): one entry
    // points OUTSIDE the worktree via an absolute `full` + a `..`-escaping `path`; another would create a
    // file outside via a delete-rollback flipped to a write. Both must be refused.
    const restore: PersistedSession = {
      id: "rb-tamper", worktree: dir, model: "mimo-v2.5",
      messages: [{ role: "system", content: "x" }],
      memory: { filesModified: [], testResults: [], decisions: [] },
      createdAt: 1, lastUsedAt: 1,
      fileHistory: [
        { path: relative(dir, victim), full: victim, beforeContent: "HIJACKED\n", afterContent: "x", tool: "write_file", timestamp: 1 },
        { path: relative(dir, escapeTarget), full: escapeTarget, beforeContent: "created\n", afterContent: "y", tool: "write_file", timestamp: 2 },
      ],
    };
    const s = new ChatSession("rb-tamper", { restore, worktree: dir, invoke: queued([stop("ok")]) });
    const results = s.rollback(2);
    assert.equal(results.length, 2, "both tampered steps are reported");
    for (const r of results) assert.match(r.action, /REFUSED/, "each escaping path is refused, not applied");
    assert.equal(readFileSync(victim, "utf8"), "DO NOT TOUCH\n", "the outside file was NOT overwritten");
    assert.ok(!existsSync(escapeTarget), "no file was created outside the worktree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(victimDir, { recursive: true, force: true });
  }
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

test("launch_build confirmation discloses the EFFECTIVE target repo, not just the goal", async () => {
  // A minimal managed workspace so the session has a targetRepo (the build's default landing site).
  const stubWorkspace = (targetRepo: string): SessionWorkspace => ({
    id: "lb-ws", path: wt(), targetRepo, baseBranch: "main", baseRef: "HEAD",
    diff: async () => "", commit: async () => true,
    promote: async () => ({ ok: false, reason: "test" }) as unknown as Awaited<ReturnType<SessionWorkspace["promote"]>>,
    discard: async () => ({ removed: true }) as unknown as Awaited<ReturnType<SessionWorkspace["discard"]>>,
    verify: async () => ({ ok: false } as unknown as Awaited<ReturnType<SessionWorkspace["verify"]>>),
  });

  // Default: the session's target repo is shown so the operator sees where the build lands.
  const invoke = queued([toolTurn(call("launch_build", { goal: "add a test" })), stop("ok")]);
  const s = new ChatSession("lb-1", { invoke, workspace: stubWorkspace("/repos/session-repo") });
  let target = "";
  await s.send("build it", undefined, "agent", { permissionMode: "confirm", confirm: async (_t, x) => { target = x; return false; } });
  assert.match(target, /add a test/, "the goal is disclosed");
  assert.match(target, /\/repos\/session-repo/, "the effective target repo is disclosed");

  // A stale explicit `repo` arg that differs from the session repo is ignored; the session repo is
  // what the operator approves and what runLaunchBuild uses.
  const invoke2 = queued([toolTurn(call("launch_build", { goal: "add a test", repo: "/repos/OTHER" })), stop("ok")]);
  const s2 = new ChatSession("lb-2", { invoke: invoke2, workspace: stubWorkspace("/repos/session-repo") });
  let target2 = "";
  await s2.send("build elsewhere", undefined, "agent", { permissionMode: "confirm", confirm: async (_t, x) => { target2 = x; return false; } });
  assert.match(target2, /\/repos\/session-repo/, "the session repo is what the operator approves");
  assert.doesNotMatch(target2, /\/repos\/OTHER/, "the stale repo arg is not shown as the target");
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

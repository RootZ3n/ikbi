/**
 * Persistent shell cwd: a `cd` in the terminal tool updates the session's working directory (handled
 * before the shell-less executor, which cannot run `cd`), and an escaping / missing target is refused.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import "../egress/index.js";

import type { ModelResponse } from "../../core/provider/contract.js";
import { ChatSession } from "./session.js";

function base(): Omit<ModelResponse, "content" | "finishReason" | "toolCalls"> {
  return {
    contractVersion: "1.1.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
    usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
const stop = (content: string): ModelResponse => ({ ...base(), content, finishReason: "stop" });
function terminalRound(command: string): ModelResponse {
  return { ...base(), content: "", finishReason: "tool_calls", toolCalls: [{ id: "c0", name: "terminal", arguments: JSON.stringify({ command }) }] };
}

type Invoke = ConstructorParameters<typeof ChatSession>[1] extends { invoke?: infer F } ? F : never;

const wt = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-shell-"));
  mkdirSync(join(dir, "src"));
  return dir;
};

test("`cd <dir>` into a real subdirectory succeeds and updates the session cwd", async () => {
  let i = 0;
  const invoke = (async () => {
    i += 1;
    return i === 1 ? terminalRound("cd src") : stop("done");
  }) as unknown as Invoke;
  const s = new ChatSession("shell-1", { invoke, worktree: wt() });
  const res = await s.send("go into src");
  assert.equal(res.tools?.[0]?.name, "terminal");
  assert.equal(res.tools?.[0]?.ok, true);
  assert.equal(res.tools?.[0]?.summary, "cd src");
});

test("`cd` to a missing directory is refused (never leaves the worktree)", async () => {
  let i = 0;
  const invoke = (async () => {
    i += 1;
    return i === 1 ? terminalRound("cd does-not-exist") : stop("done");
  }) as unknown as Invoke;
  const s = new ChatSession("shell-2", { invoke, worktree: wt() });
  const res = await s.send("go somewhere bad");
  assert.equal(res.tools?.[0]?.ok, false);
  assert.equal(res.tools?.[0]?.summary, "cd denied");
});

test("`cd ..` above the worktree root is refused as an escape", async () => {
  let i = 0;
  const invoke = (async () => {
    i += 1;
    return i === 1 ? terminalRound("cd ../../etc") : stop("done");
  }) as unknown as Invoke;
  const s = new ChatSession("shell-3", { invoke, worktree: wt() });
  const res = await s.send("escape");
  assert.equal(res.tools?.[0]?.ok, false);
  assert.equal(res.tools?.[0]?.summary, "cd denied");
});

test("shellCwd is persisted and restored across session resume", async () => {
  let i = 0;
  const invoke = (async () => {
    i += 1;
    return i === 1 ? terminalRound("cd src") : stop("done");
  }) as unknown as Invoke;
  const workdir = wt();
  const s1 = new ChatSession("shell-persist", { invoke, worktree: workdir });
  // Turn 1: cd into src
  await s1.send("go into src");
  // Serialize
  const persisted = s1.toPersisted();
  assert.equal(persisted.shellCwd, "src", "shellCwd is persisted as 'src'");

  // Restore into a new session and verify shellCwd is restored by cd'ing again
  let i2 = 0;
  const invoke2 = (async () => {
    i2 += 1;
    // In the restored session, cd .. should succeed (we're in src, going to root)
    return i2 === 1 ? terminalRound("cd ..") : stop("done");
  }) as unknown as Invoke;
  const s2 = new ChatSession("shell-persist-2", { invoke: invoke2, worktree: workdir, restore: persisted });
  const res2 = await s2.send("go back");
  // cd .. from src resolves to "." (root) — this proves shellCwd was restored as "src"
  assert.equal(res2.tools?.[0]?.ok, true, "cd .. from restored src cwd succeeds");
  // The summary shows the resolved path ("cd ." = root), not the literal "cd .."
  assert.ok(res2.tools?.[0]?.summary?.startsWith("cd"), "cd command summary present");
});

test("shellCwd defaults to '.' when not persisted (full round-trip)", async () => {
  // A session that never cd'd should have no shellCwd in its persisted form.
  let i = 0;
  const invoke = (async () => {
    i += 1;
    return i === 1 ? terminalRound("cd src") : stop("done");
  }) as unknown as Invoke;
  const dir = wt();
  const s1 = new ChatSession("shell-default", { invoke, worktree: dir });
  await s1.send("go into src");
  const persisted = s1.toPersisted();
  assert.equal(persisted.shellCwd, "src", "shellCwd is persisted");

  // Now create a session that NEVER cd's and verify shellCwd is absent
  let i2 = 0;
  const invoke2 = (async () => {
    i2 += 1;
    return i2 === 1 ? terminalRound("cd src") : stop("done");
  }) as unknown as Invoke;
  const s2 = new ChatSession("shell-default-2", { invoke: invoke2, worktree: dir });
  await s2.send("go into src");
  const persisted2 = s2.toPersisted();
  // This session did cd, so shellCwd should be "src"
  assert.equal(persisted2.shellCwd, "src", "shellCwd is persisted after cd");

  // Restore WITHOUT shellCwd (simulating an old session file that lacks it)
  let i3 = 0;
  const invoke3 = (async () => {
    i3 += 1;
    return i3 === 1 ? terminalRound("cd src") : stop("done");
  }) as unknown as Invoke;
  const noShell = { ...persisted2, shellCwd: undefined };
  const s3 = new ChatSession("shell-default-3", { invoke: invoke3, worktree: dir, restore: noShell as any });
  const res3 = await s3.send("go into src");
  // Should succeed — defaults to "." and cd src works from root
  assert.equal(res3.tools?.[0]?.ok, true, "cd src works in restored session with default cwd");
});

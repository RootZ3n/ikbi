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

/**
 * REPL `/agent <name>` — adopting a user-defined persona switches the session's system prompt,
 * narrows its tools, and applies the preferred model. Driven through runRepl with a real session.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import "../egress/index.js";

import type { ModelResponse } from "../../core/provider/contract.js";
import { ChatSession } from "./session.js";
import { runRepl } from "./cli.js";

function stop(content: string): ModelResponse {
  return {
    contractVersion: "1.1.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
    content, finishReason: "stop",
    usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}

function lines(arr: string[]): () => Promise<string | null> {
  let i = 0;
  return () => Promise.resolve(i < arr.length ? (arr[i++] as string) : null);
}

/** A worktree that also carries a .ikbi/agents/ persona. */
function worktreeWithAgent(): string {
  const wt = mkdtempSync(join(tmpdir(), "ikbi-persona-wt-"));
  const dir = join(wt, ".ikbi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "reviewer.yaml"),
    "name: reviewer\nmodel_preference: deepseek-v4-pro\nallowed_tools:\n  - read_file\n  - lsp_diagnostic\nsystem_prompt: |\n  You are a meticulous reviewer.\n",
  );
  return wt;
}

test("/agent <name> adopts the persona (model + tools narrowed)", async () => {
  const wt = worktreeWithAgent();
  const session = new ChatSession("persona1", { invoke: (async () => stop("ok")) as never, worktree: wt });
  let out = "";
  await runRepl({ session, readLine: lines(["/agent reviewer", "/exit"]), out: (s) => { out += s; } });
  assert.match(out, /persona "reviewer" active/);
  const persona = session.currentPersona();
  assert.equal(persona?.name, "reviewer");
  assert.deepEqual([...(persona?.allowedTools ?? [])], ["read_file", "lsp_diagnostic"]);
  // model_preference applied
  assert.equal(session.currentModel(), "deepseek-v4-pro");
});

test("/agent list shows available personas; /agent default clears", async () => {
  const wt = worktreeWithAgent();
  const session = new ChatSession("persona2", { invoke: (async () => stop("ok")) as never, worktree: wt });
  let out = "";
  await runRepl({ session, readLine: lines(["/agent reviewer", "/agent list", "/agent default", "/exit"]), out: (s) => { out += s; } });
  assert.match(out, /custom agents: reviewer/);
  assert.match(out, /persona cleared/);
  assert.equal(session.currentPersona(), undefined);
});

test("/agent <unknown> reports no such agent", async () => {
  const wt = worktreeWithAgent();
  const session = new ChatSession("persona3", { invoke: (async () => stop("ok")) as never, worktree: wt });
  let out = "";
  await runRepl({ session, readLine: lines(["/agent ghost", "/exit"]), out: (s) => { out += s; } });
  assert.match(out, /no agent named "ghost"/);
  assert.equal(session.currentPersona(), undefined);
});

test("/agent (no arg) keeps the classic agent-mode switch", async () => {
  const wt = worktreeWithAgent();
  const session = new ChatSession("persona4", { invoke: (async () => stop("ok")) as never, worktree: wt });
  let out = "";
  await runRepl({ session, readLine: lines(["/agent", "/exit"]), out: (s) => { out += s; } });
  assert.match(out, /agent mode: full tool suite/);
});

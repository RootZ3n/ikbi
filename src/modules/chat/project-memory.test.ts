/**
 * Fix 4 (audit): a chat session injects the workspace's CLAUDE.md/AGENTS.md into the model
 * context (through the neutralization chokepoint). A missing file does not crash.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

// EGRESS FIRST — the provider registry resolves the fetch guard at import (see chat.test.ts).
import "../egress/index.js";

import type { ModelResponse } from "../../core/provider/contract.js";
import { ChatSession, sessionStore } from "./session.js";

afterEach(() => sessionStore.reset());

const RULE = "PROJECT_RULE: ikbi-chat must follow the house style in this file.";
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

function base(): Omit<ModelResponse, "content" | "finishReason" | "toolCalls"> {
  return {
    contractVersion: "1.1.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
const stop = (content: string): ModelResponse => ({ ...base(), content, finishReason: "stop" });

function scripted(responses: ModelResponse[]) {
  const requests: unknown[] = [];
  let i = 0;
  const invoke = (async (req: unknown) => { requests.push(req); const r = responses[Math.min(i, responses.length - 1)] ?? stop(""); i += 1; return r; }) as unknown as ConstructorParameters<typeof ChatSession>[1] extends { invoke?: infer F } ? F : never;
  return { invoke, requests };
}

test("chat context INCLUDES the workspace CLAUDE.md as an isolated untrusted message", async () => {
  const dir = tmp("ikbi-chat-pm-");
  writeFileSync(join(dir, "CLAUDE.md"), RULE);
  const { invoke, requests } = scripted([stop("understood")]);
  const s = new ChatSession("s-pm", { invoke, worktree: dir });
  await s.send("hello");

  const msgs = (requests[0] as { messages: Array<{ role: string; content: string; untrusted?: boolean }> }).messages;
  const proj = msgs.find((m) => m.content.includes(RULE));
  assert.ok(proj, "the CLAUDE.md rule is in the chat model context");
  assert.equal(proj?.untrusted, true, "carried as isolated UNTRUSTED data (the chokepoint), not trusted system text");
  // It sits AFTER the clean system prompt (index 0), never merged into it.
  assert.equal(msgs[0]?.role, "system");
  assert.ok(!msgs[0]?.content.includes(RULE), "the system prompt itself is untouched (project memory is isolated)");
});

test("chat does NOT crash when the workspace has no CLAUDE.md", async () => {
  const dir = tmp("ikbi-chat-pm-none-");
  const { invoke, requests } = scripted([stop("hi there")]);
  const s = new ChatSession("s-pm-none", { invoke, worktree: dir });
  const { response } = await s.send("hello");
  assert.equal(response, "hi there");
  const msgs = (requests[0] as { messages: Array<{ content: string }> }).messages;
  assert.ok(!msgs.some((m) => m.content.includes("Project instructions from this workspace")), "no project-memory message when there is no file");
});

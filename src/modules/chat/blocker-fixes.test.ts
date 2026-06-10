/**
 * Senior-engineer audit blockers — runtime regression tests (the issues Fable 5's code-only pass
 * missed because they only manifest at runtime / across processes).
 *
 *   BLOCKER-1  /rollback injects a stale-context notice into the conversation so the model re-reads
 *              the reverted file instead of operating on its now-stale tool results.
 *
 * Driven through a SCRIPTED invoker (no network, no real model), same harness style as the other
 * chat tests.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// EGRESS FIRST — ChatSession transits the provider singleton (see chat.test.ts).
import "../egress/index.js";

import type { ModelResponse, ToolCall } from "../../core/provider/contract.js";
import { ChatSession } from "./session.js";

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

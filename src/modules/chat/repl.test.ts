/**
 * HB-5 (audit): `ikbi repl` — an interactive multi-turn session over the chat backend.
 * The loop retains history across turns and exits cleanly on /exit (and end-of-input).
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// EGRESS FIRST — ChatSession transits the provider singleton (see chat.test.ts).
import "../egress/index.js";

import type { ModelResponse } from "../../core/provider/contract.js";
import { ChatSession } from "./session.js";
import type { ChatToolActivity } from "./contract.js";
import { runRepl } from "./cli.js";

const tmp = () => mkdtempSync(join(tmpdir(), "ikbi-repl-"));

function base(): Omit<ModelResponse, "content" | "finishReason" | "toolCalls"> {
  return {
    contractVersion: "1.1.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
const stop = (content: string): ModelResponse => ({ ...base(), content, finishReason: "stop" });

/** A readLine source over a fixed list of lines; resolves null when exhausted. */
function lines(arr: string[]): () => Promise<string | null> {
  let i = 0;
  return () => Promise.resolve(i < arr.length ? (arr[i++] as string) : null);
}

test("repl retains multi-turn history: the 2nd turn's request includes the 1st turn", async () => {
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  let i = 0;
  const replies = [stop("first reply"), stop("second reply")];
  const invoke = (async (req: unknown) => {
    requests.push(req as { messages: Array<{ role: string; content: string }> });
    const r = replies[Math.min(i, replies.length - 1)] ?? stop("");
    i += 1;
    return r;
  }) as unknown as ConstructorParameters<typeof ChatSession>[1] extends { invoke?: infer F } ? F : never;
  const session = new ChatSession("s-repl", { invoke, worktree: tmp() });

  let out = "";
  await runRepl({ session, readLine: lines(["first message", "second message", "/exit"]), out: (s) => { out += s; } });

  assert.equal(requests.length, 2, "exactly two turns were sent (then /exit)");
  // Turn 1 saw the first user message.
  assert.ok(requests[0]!.messages.some((m) => m.role === "user" && m.content.includes("first message")));
  // Turn 2 saw BOTH the first user message AND the first assistant reply — history retained.
  const t2 = requests[1]!.messages;
  assert.ok(t2.some((m) => m.role === "user" && m.content.includes("first message")), "turn 2 carries the prior user turn");
  assert.ok(t2.some((m) => m.role === "assistant" && m.content.includes("first reply")), "turn 2 carries the prior assistant reply");
  assert.ok(t2.some((m) => m.role === "user" && m.content.includes("second message")), "turn 2 carries the new user turn");
  assert.match(out, /first reply/);
  assert.match(out, /second reply/);
  assert.match(out, /session ended/);
});

// ── exit + input handling, with a lightweight fake session ────────────────────

function fakeSession() {
  const sent: string[] = [];
  const session = {
    send: async (msg: string): Promise<{ response: string; tools: ChatToolActivity[] }> => {
      sent.push(msg);
      return { response: `echo:${msg}`, tools: msg === "use a tool" ? [{ name: "read_file", ok: true }] : [] };
    },
  };
  return { session, sent };
}

test("/exit ends the loop and no further lines are consumed", async () => {
  const f = fakeSession();
  let out = "";
  await runRepl({ session: f.session, readLine: lines(["hello", "/exit", "SHOULD-NOT-SEND"]), out: (s) => { out += s; } });
  assert.deepEqual(f.sent, ["hello"], "only the pre-/exit message was sent");
  assert.match(out, /echo:hello/);
  assert.ok(!out.includes("SHOULD-NOT-SEND"), "the post-/exit line was never processed");
});

test("end-of-input (Ctrl-C / EOF) ends the loop cleanly; blank lines are skipped; tools are shown", async () => {
  const f = fakeSession();
  let out = "";
  await runRepl({ session: f.session, readLine: lines(["", "   ", "use a tool"]), out: (s) => { out += s; } });
  assert.deepEqual(f.sent, ["use a tool"], "blank lines skipped; one real message sent, then EOF ended it");
  assert.match(out, /· Read files/, "tool activity is surfaced");
  assert.match(out, /session ended/);
});

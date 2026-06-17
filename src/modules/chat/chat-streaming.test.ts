import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// EGRESS FIRST — the provider registry resolves the fetch guard at import (see chat.test.ts).
import "../egress/index.js";

import type { ModelRequest, ModelStream, StreamDelta } from "../../core/provider/contract.js";
import { ChatSession, type InvokeStreamFn, type StreamEvent } from "./session.js";
import { runRepl } from "./cli.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "ikbi-chat-stream-"));

/** Script the streaming invoker: each entry is one model round's delta sequence. */
function scriptStream(rounds: StreamDelta[][]): { invokeStream: InvokeStreamFn; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let i = 0;
  const invokeStream = (async (req: ModelRequest): Promise<ModelStream> => {
    requests.push(req);
    const deltas = rounds[Math.min(i, rounds.length - 1)] ?? [];
    i += 1;
    return (async function* () {
      for (const d of deltas) yield d;
    })();
  }) as InvokeStreamFn;
  return { invokeStream, requests };
}

/** Drain a sendStream generator: collect the streamed events and the final return value. */
async function drain(
  gen: AsyncGenerator<StreamEvent, { response: string; tools: { name: string; ok: boolean }[]; cost: number; contextPercent: number }, void>,
): Promise<{ events: StreamEvent[]; res: { response: string; tools: { name: string; ok: boolean }[]; cost: number; contextPercent: number } }> {
  const events: StreamEvent[] = [];
  for (;;) {
    const n = await gen.next();
    if (n.done === true) return { events, res: n.value };
    events.push(n.value);
  }
}

test("sendStream yields content deltas and returns the assembled reply", async () => {
  const { invokeStream } = scriptStream([
    [{ content: "Hel" }, { content: "lo", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 } }],
  ]);
  const session = new ChatSession("s1", { worktree: tmp(), invokeStream });
  const { events, res } = await drain(session.sendStream("hi"));

  assert.deepEqual(events.map((e) => e.delta.content), ["Hel", "lo"]);
  assert.equal(events.at(-1)?.fullContent, "Hello");
  assert.equal(res.response, "Hello");
  assert.equal(res.tools.length, 0);

  // Token usage is folded into the session counters from the trailing delta.
  assert.equal(session.usage().tokensIn, 10);
  assert.equal(session.usage().tokensOut, 3);
});

test("sendStream runs the tool loop after the stream, then streams the final answer", async () => {
  const work = tmp();
  writeFileSync(join(work, "f.txt"), "file contents here", "utf8");
  const { invokeStream } = scriptStream([
    // Round 1: the model asks to read a file (tool_calls), no prose.
    [{ toolCalls: [{ index: 0, id: "c1", name: "read_file", arguments: JSON.stringify({ path: "f.txt" }) }], finishReason: "tool_calls" }],
    // Round 2: the model answers, having seen the tool result.
    [{ content: "the file says hi", finishReason: "stop" }],
  ]);
  const session = new ChatSession("s2", { worktree: work, invokeStream });
  const { events, res } = await drain(session.sendStream("read f.txt"));

  assert.equal(res.response, "the file says hi");
  assert.ok(res.tools.some((t) => t.name === "read_file" && t.ok), "read_file ran and succeeded");
  // Only the final round produced prose, so that is what streamed.
  assert.equal(events.map((e) => e.delta.content ?? "").join(""), "the file says hi");
});

test("sendStream surfaces a model failure as a graceful reply (does not throw)", async () => {
  const invokeStream = (async () => {
    throw new Error("provider down");
  }) as InvokeStreamFn;
  const session = new ChatSession("s3", { worktree: tmp(), invokeStream });
  const { res } = await drain(session.sendStream("hi"));
  assert.match(res.response, /model call failed: provider down/);
});

test("sendStream appends the assistant turn to history (multi-turn round-trips)", async () => {
  const { invokeStream } = scriptStream([[{ content: "first" }], [{ content: "second" }]]);
  const session = new ChatSession("s4", { worktree: tmp(), invokeStream });
  await drain(session.sendStream("one"));
  const before = session.messageCount();
  await drain(session.sendStream("two"));
  // Each turn adds at least a user + assistant message; the log grows monotonically.
  assert.ok(session.messageCount() > before, "history grew across streamed turns");
});

test("the REPL prints streamed content live via sendStream", async () => {
  const { invokeStream } = scriptStream([[{ content: "hello " }, { content: "world", finishReason: "stop" }]]);
  const session = new ChatSession("s-repl-stream", { worktree: tmp(), invokeStream });
  let out = "";
  let i = 0;
  const arr = ["hi", "/exit"];
  const readLine = (): Promise<string | null> => Promise.resolve(i < arr.length ? (arr[i++] as string) : null);
  await runRepl({ session, readLine, out: (s) => { out += s; } });
  assert.match(out, /hello world/, "streamed slices reached the terminal");
  assert.match(out, /session ended/);
});

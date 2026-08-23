/**
 * RC2 + RC3 — the chat surface must not silently accept a flagged model finish.
 *
 * RC2 (stalled stream): a round that finishes with finishReason=length WHILE carrying partial tool
 *   calls is a stream that stalled mid tool-call. The partial call must NOT execute, the user must
 *   see a clear warning, and a receipt must record it.
 * RC3 (content filter): a finishReason=content_filter round must surface a warning (the output may
 *   be censored/incomplete) and record the finish reason, not be returned as a normal answer.
 *
 * Normal completions (finishReason=stop / tool_calls) must be unaffected.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { labTempDir as tmpdir } from "../../core/temp-root.js";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import "../egress/index.js";

import type { ModelResponse, ToolCall } from "../../core/provider/contract.js";
import { receipts } from "../../core/receipt/index.js";
import { ChatSession, finishReasonNotice, sessionStore } from "./session.js";

afterEach(() => sessionStore.reset());

function base(): Omit<ModelResponse, "content" | "finishReason" | "toolCalls"> {
  return {
    contractVersion: "1.1.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
const call = (name: string, args: unknown, id = "c1"): ToolCall => ({ id, name, arguments: JSON.stringify(args) });

function scripted(responses: ModelResponse[]) {
  let i = 0;
  const invoke = (async () => {
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return r;
  }) as unknown as ConstructorParameters<typeof ChatSession>[1] extends { invoke?: infer F } ? F : never;
  return { invoke };
}

const tmp = (): string => mkdtempSync(join(tmpdir(), "ikbi-finish-test-"));

// ── pure classifier (RC2/RC3) ────────────────────────────────────────────────

test("finishReasonNotice: clean finishes produce no notice", () => {
  assert.equal(finishReasonNotice("stop", false), undefined);
  assert.equal(finishReasonNotice("tool_calls", true), undefined);
  assert.equal(finishReasonNotice("unknown", false), undefined);
  assert.equal(finishReasonNotice(undefined, false), undefined);
});

test("finishReasonNotice: content_filter is flagged incomplete", () => {
  const n = finishReasonNotice("content_filter", false);
  assert.ok(n);
  assert.equal(n!.reason, "content_filter");
  assert.equal(n!.incomplete, true);
  assert.match(n!.warning, /content\/safety filter/);
});

test("finishReasonNotice: length WITH tool calls is a stalled mid-tool-call", () => {
  const n = finishReasonNotice("length", true);
  assert.ok(n);
  assert.equal(n!.stalledToolCall, true);
  assert.match(n!.warning, /stalled mid tool-call/);
  assert.match(n!.warning, /NOT executed/);
});

test("finishReasonNotice: length WITHOUT tool calls is a plain truncation", () => {
  const n = finishReasonNotice("length", false);
  assert.ok(n);
  assert.equal(n!.stalledToolCall, false);
  assert.match(n!.warning, /truncated/);
});

// ── integration (RC2) ────────────────────────────────────────────────────────

test("RC2: a stream stalled mid tool-call does NOT execute the partial call and warns the user", async () => {
  const dir = tmp();
  // finishReason=length WITH a write_file tool call = stalled mid-stream.
  const stalled: ModelResponse = {
    ...base(), content: "", finishReason: "length",
    toolCalls: [call("write_file", { path: "should-not-exist.ts", content: "boom" })],
  };
  const { invoke } = scripted([stalled]);
  const s = new ChatSession("rc2-stall", { invoke, worktree: dir });
  const { response, tools } = await s.send("write a file");

  assert.equal(tools.length, 0, "the partial tool call must NOT have executed");
  assert.equal(existsSync(join(dir, "should-not-exist.ts")), false, "no file was written");
  assert.match(response, /stalled mid tool-call/, "the user sees a clear stalled-stream warning");

  const recs = await receipts.query({ operation: "chat.tool_call_stalled" });
  assert.ok(recs.some((r) => r.requestId === "rc2-stall"), "a stalled-stream receipt was written");
  const rec = recs.find((r) => r.requestId === "rc2-stall")!;
  assert.equal(rec.metadata?.finishReason, "length");
  assert.equal(rec.metadata?.stalledToolCall, true);
});

test("RC2: the next turn after a stall does NOT replay the partial tool call", async () => {
  const dir = tmp();
  const stalled: ModelResponse = {
    ...base(), content: "", finishReason: "length",
    toolCalls: [call("write_file", { path: "nope.ts", content: "boom" })],
  };
  const clean: ModelResponse = { ...base(), content: "All good now.", finishReason: "stop" };
  const { invoke } = scripted([stalled, clean]);
  const s = new ChatSession("rc2-retry", { invoke, worktree: dir });

  await s.send("first attempt"); // stalls
  const { response, tools } = await s.send("try again"); // clean retry
  assert.equal(response, "All good now.");
  assert.equal(tools.length, 0, "the dangling partial call from the stalled round was never replayed");
  assert.equal(existsSync(join(dir, "nope.ts")), false);
});

// ── integration (RC3) ────────────────────────────────────────────────────────

test("RC3: a content_filter finish surfaces a warning and records the finish reason", async () => {
  const dir = tmp();
  const filtered: ModelResponse = { ...base(), content: "Here is the partial answer", finishReason: "content_filter" };
  const { invoke } = scripted([filtered]);
  const s = new ChatSession("rc3-filter", { invoke, worktree: dir });
  const { response } = await s.send("do the thing");

  assert.match(response, /content\/safety filter/, "the user is warned the output was filtered");
  assert.match(response, /Here is the partial answer/, "the (possibly-incomplete) content is still shown");

  const recs = await receipts.query({ operation: "chat.finish_reason_flagged" });
  const rec = recs.find((r) => r.requestId === "rc3-filter");
  assert.ok(rec, "a finish-reason receipt was written");
  assert.equal(rec!.metadata?.finishReason, "content_filter");
});

test("H4/Gap C: a chat turn with cost writes a chat.turn cost receipt (visible to `ikbi cost`)", async () => {
  const dir = tmp();
  const paid: ModelResponse = {
    ...base(), content: "done", finishReason: "stop",
    cost: { usd: 0.02, promptUsd: 0.02, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
  };
  const { invoke } = scripted([paid]);
  const s = new ChatSession("gapc-chat-cost", { invoke, worktree: dir });
  await s.send("do the thing");

  const recs = await receipts.query({ operation: "chat.turn" });
  const rec = recs.find((r) => r.requestId === "gapc-chat-cost");
  assert.ok(rec, "a chat.turn cost receipt was written (chat spend was invisible to `ikbi cost`)");
  assert.equal(rec!.metadata?.costUsd, 0.02, "the turn's spend is recorded");
  assert.equal(rec!.metadata?.kind, "chat");
});

test("H4/Gap C: a ZERO-cost turn writes NO receipt (no noise)", async () => {
  const dir = tmp();
  const { invoke } = scripted([{ ...base(), content: "free", finishReason: "stop" }]); // base() cost.usd = 0
  const s = new ChatSession("gapc-chat-free", { invoke, worktree: dir });
  await s.send("do the thing");
  const recs = await receipts.query({ operation: "chat.turn" });
  assert.equal(recs.find((r) => r.requestId === "gapc-chat-free"), undefined, "a zero-cost turn is not receipted");
});

test("RC3: a normal stop completion is unaffected (no warning, no receipt noise)", async () => {
  const dir = tmp();
  const { invoke } = scripted([{ ...base(), content: "Plain clean answer.", finishReason: "stop" }]);
  const s = new ChatSession("rc3-clean", { invoke, worktree: dir });
  const { response } = await s.send("hi");
  assert.equal(response, "Plain clean answer.", "a clean answer is returned verbatim, no decoration");

  const recs = await receipts.query({ operation: "chat.finish_reason_flagged" });
  assert.ok(!recs.some((r) => r.requestId === "rc3-clean"), "no finish-reason receipt for a clean stop");
});

/**
 * Parallel tool dispatch: a round's READ-ONLY tool calls run concurrently, and every call's result
 * is appended through the neutralization chokepoint in the model's original call order (tool_result
 * must line up with tool_use). Exercised end-to-end through ChatSession.send with a scripted model.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import "../egress/index.js";

import type { ModelMessage, ModelResponse } from "../../core/provider/contract.js";
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
function toolRound(calls: Array<{ name: string; args: Record<string, unknown> }>): ModelResponse {
  return {
    ...base(),
    content: "",
    finishReason: "tool_calls",
    toolCalls: calls.map((c, i) => ({ id: `call_${i}`, name: c.name, arguments: JSON.stringify(c.args) })),
  };
}

const wt = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-par-"));
  writeFileSync(join(dir, "a.txt"), "AAA_content", "utf8");
  writeFileSync(join(dir, "b.txt"), "BBB_content", "utf8");
  writeFileSync(join(dir, "c.txt"), "CCC_content", "utf8");
  return dir;
};

type Invoke = ConstructorParameters<typeof ChatSession>[1] extends { invoke?: infer F } ? F : never;

test("a round of read_file calls all execute and their results append in call order", async () => {
  const seen: ModelMessage[][] = [];
  let i = 0;
  const invoke = (async (req: { messages?: readonly ModelMessage[] }) => {
    seen.push([...(req.messages ?? [])]);
    i += 1;
    if (i === 1) {
      return toolRound([
        { name: "read_file", args: { path: "a.txt" } },
        { name: "read_file", args: { path: "b.txt" } },
        { name: "read_file", args: { path: "c.txt" } },
      ]);
    }
    return stop("done");
  }) as unknown as Invoke;

  const s = new ChatSession("par-1", { invoke, worktree: wt() });
  const res = await s.send("read a, b, c");

  // All three tools ran and succeeded.
  assert.equal(res.tools?.length, 3);
  assert.ok(res.tools?.every((t) => t.ok), "every read succeeded");
  assert.deepEqual(res.tools?.map((t) => t.name), ["read_file", "read_file", "read_file"]);

  // The SECOND model request carries the three tool results in the model's call order.
  const secondReq = seen[1] ?? [];
  const serialized = secondReq.map((m) => m.content).join("\n");
  const ia = serialized.indexOf("AAA_content");
  const ib = serialized.indexOf("BBB_content");
  const ic = serialized.indexOf("CCC_content");
  assert.ok(ia >= 0 && ib >= 0 && ic >= 0, "all three file contents were fed back to the model");
  assert.ok(ia < ib && ib < ic, "tool results are appended in the original call order, not completion order");
});

test("a failing tool in a round still yields a matching result (no dangling tool_use)", async () => {
  let i = 0;
  const invoke = (async () => {
    i += 1;
    if (i === 1) {
      return toolRound([
        { name: "read_file", args: { path: "a.txt" } },
        { name: "read_file", args: { path: "does-not-exist.txt" } },
      ]);
    }
    return stop("done");
  }) as unknown as Invoke;

  const s = new ChatSession("par-2", { invoke, worktree: wt() });
  const res = await s.send("read two files");
  // Both calls produce an activity — the second failed but was still answered.
  assert.equal(res.tools?.length, 2);
  assert.equal(res.tools?.[0]?.ok, true);
  assert.equal(res.tools?.[1]?.ok, false);
});

test("read-only tools after a mutating tool wait for the mutation (barrier)", async () => {
  // The round is: write_file(c.txt), read_file(c.txt).
  // With the barrier fix, the read MUST happen after the write, so the read sees the new content.
  const seen: ModelMessage[][] = [];
  let i = 0;
  const invoke = (async (req: { messages?: readonly ModelMessage[] }) => {
    seen.push([...(req.messages ?? [])]);
    i += 1;
    if (i === 1) {
      return toolRound([
        { name: "write_file", args: { path: "c.txt", content: "NEW_CONTENT" } },
        { name: "read_file", args: { path: "c.txt" } },
      ]);
    }
    return stop("done");
  }) as unknown as Invoke;

  const dir = wt(); // already has c.txt with CCC_content
  const s = new ChatSession("par-barrier", { invoke, worktree: dir });
  const res = await s.send("write then read c");

  assert.equal(res.tools?.length, 2);
  assert.equal(res.tools?.[0]?.ok, true);
  assert.equal(res.tools?.[1]?.ok, true);
  // The second model request should show the read_file result containing NEW_CONTENT
  // (not the stale CCC_content), proving the barrier enforced write-before-read.
  const secondReq = seen[1] ?? [];
  const serialized = secondReq.map((m) => m.content).join("\n");
  assert.ok(serialized.includes("NEW_CONTENT"), "read_file saw the NEW_CONTENT written by write_file");
  assert.ok(!serialized.includes("CCC_content"), "read_file did NOT see the stale CCC_content");
});

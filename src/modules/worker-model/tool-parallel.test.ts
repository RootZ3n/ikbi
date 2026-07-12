import assert from "node:assert/strict";
import { test } from "node:test";

import { preStartParallelReads } from "./tool-parallel.js";
import type { ToolCall } from "../../core/provider/contract.js";

const call = (id: string, name: string): ToolCall => ({ id, name, arguments: "{}" });

test("preStartParallelReads runs parallelizable calls CONCURRENTLY (they overlap in flight)", async () => {
  let inFlight = 0;
  let maxConcurrent = 0;
  // A runner that holds each call open until both have started — proving true overlap, not serial.
  let release!: () => void;
  const barrier = new Promise<void>((r) => { release = r; });
  const run = async (c: ToolCall): Promise<string> => {
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    if (inFlight >= 2) release(); // both are in flight — let them finish
    await barrier;
    inFlight -= 1;
    return `result:${c.id}`;
  };
  const calls = [call("a", "web_search"), call("b", "web_search")];
  const started = preStartParallelReads(calls, (c) => c.name === "web_search", run);

  // Await in CALL ORDER — results are deterministic regardless of completion order.
  const a = await started.get(calls[0]!)!;
  const b = await started.get(calls[1]!)!;
  assert.equal(a, "result:a");
  assert.equal(b, "result:b");
  assert.equal(maxConcurrent, 2, "both web calls were in flight at once (concurrent, not serial)");
});

test("preStartParallelReads only pre-starts the parallelizable calls; others are absent (run serially by caller)", async () => {
  const run = async (c: ToolCall): Promise<string> => `ran:${c.id}`;
  const calls = [call("w", "web_search"), call("t", "terminal"), call("v", "vision_analyze")];
  const started = preStartParallelReads(calls, (c) => c.name === "web_search" || c.name === "vision_analyze", run);
  assert.ok(started.has(calls[0]!), "web_search is pre-started");
  assert.ok(!started.has(calls[1]!), "terminal (side-effecting) is NOT pre-started");
  assert.ok(started.has(calls[2]!), "vision is pre-started");
});

test("preStartParallelReads does NOTHING for a single-call round (nothing to overlap with)", async () => {
  let ran = false;
  const run = async (): Promise<string> => { ran = true; return "x"; };
  const started = preStartParallelReads([call("w", "web_search")], () => true, run);
  assert.equal(started.size, 0, "a lone call is not pre-started");
  assert.equal(ran, false, "the runner was not invoked for a single-call round");
});

test("preStartParallelReads PRE-SETTLES a throwing runner to an error string (never an unhandled rejection)", async () => {
  const run = async (c: ToolCall): Promise<string> => {
    if (c.id === "boom") throw new Error("network down");
    return `ok:${c.id}`;
  };
  const calls = [call("boom", "web_search"), call("fine", "web_search")];
  const started = preStartParallelReads(calls, (c) => c.name === "web_search", run);
  // Even the throwing call resolves (to an error string) — a later `break` that skips the await is safe.
  assert.equal(await started.get(calls[0]!)!, "ERROR: network down");
  assert.equal(await started.get(calls[1]!)!, "ok:fine");
});

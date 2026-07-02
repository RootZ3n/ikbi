/**
 * Automatic context compaction: when a session's context pressure crosses AUTO_COMPACT_PERCENT,
 * the next turn compacts BEFORE calling the model (Claude-Code-style between-turns compaction),
 * instead of waiting for a manual `/compact`. It stays quiet below the threshold.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import "../egress/index.js";

import type { ModelResponse } from "../../core/provider/contract.js";
import { ChatSession } from "./session.js";

function base(): Omit<ModelResponse, "content" | "finishReason" | "toolCalls"> {
  return {
    contractVersion: "1.1.0", model: "mistral-tiny", provider: "stub", providerModelId: "mistral-tiny",
    usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
const stop = (content: string): ModelResponse => ({ ...base(), content, finishReason: "stop" });

type Invoke = ConstructorParameters<typeof ChatSession>[1] extends { invoke?: infer F } ? F : never;

const wt = (): string => mkdtempSync(join(tmpdir(), "ikbi-compact-"));

test("auto-compacts once pressure crosses the threshold, and stays quiet below it", async () => {
  // The reply is also bulky so the exchange (user + assistant) crosses 80% by the END of turn 1,
  // while the START of turn 1 (just the user prompt) is still under it.
  const reply = "response text ".repeat(1200); // ~16.8k chars ≈ ~4.2k tokens
  const invoke = (async () => stop(reply)) as unknown as Invoke;
  // mistral-tiny → an 8k context window, so a couple of large messages cross 80% fast.
  const s = new ChatSession("compact-auto", { invoke, worktree: wt(), model: "mistral-tiny" });

  const big = "lorem ipsum ".repeat(1700); // ~20.4k chars ≈ ~5.1k tokens (≈62% of 8k on its own)

  // Turn 1: the conversation is still small at the START of the turn → no compaction.
  const p1: string[] = [];
  await s.send(big, undefined, "agent", { onProgress: (p) => p1.push(p) });
  assert.ok(!p1.includes("Compacting context…"), "no auto-compaction while the window is not yet under pressure");
  assert.ok(s.contextPercent() >= 80, "after a large exchange the window is now under pressure");

  // Turn 2: pressure is already high at the top of the turn → compaction fires before the model call.
  const p2: string[] = [];
  await s.send("continue", undefined, "agent", { onProgress: (p) => p2.push(p) });
  assert.ok(p2.includes("Compacting context…"), "auto-compaction fires on the next turn under pressure");
});

test("auto-compaction can be disabled via IKBI_CHAT_AUTO_COMPACT_PERCENT=0", async () => {
  // The threshold const is read at module load; this asserts the disable path is wired, not env timing.
  // With the default threshold, a low-pressure session must never compact.
  const invoke = (async () => stop("ok")) as unknown as Invoke;
  const s = new ChatSession("compact-off", { invoke, worktree: wt(), model: "mimo-v2.5" });
  const progress: string[] = [];
  await s.send("hi", undefined, "agent", { onProgress: (p) => progress.push(p) });
  assert.ok(!progress.includes("Compacting context…"), "a small session never auto-compacts");
});

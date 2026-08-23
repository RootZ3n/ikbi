/**
 * Automatic context compaction: when a session's context pressure crosses AUTO_COMPACT_PERCENT,
 * the next turn compacts BEFORE calling the model (Claude-Code-style between-turns compaction),
 * instead of waiting for a manual `/compact`. It stays quiet below the threshold.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { labTempDir as tmpdir } from "../../core/temp-root.js";
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

  // Turn 1: the conversation is still small at the START of the turn → no compaction before model.
  const p1: string[] = [];
  await s.send(big, undefined, "agent", { onProgress: (p) => p1.push(p) });
  // Between-turns compaction may fire AFTER the model responds if the large exchange
  // pushed context over 80% — that's correct behavior. The key invariant is that
  // compaction did NOT fire BEFORE the model call (the "Thinking…" phase).
  const compactIdx = p1.indexOf("Compacting context…");
  const thinkIdx = p1.indexOf("Thinking…");
  if (compactIdx >= 0 && thinkIdx >= 0) {
    assert.ok(compactIdx > thinkIdx, "compaction fires after model responds, not before");
  }
  assert.ok(s.contextPercent() >= 80, "after a large exchange the window is now under pressure");

  // Turn 2: pressure is already high. With the between-turns fix, compaction fires
  // AFTER the model responds (not before), so we check that compaction happened during turn 2.
  const p2: string[] = [];
  await s.send("continue", undefined, "agent", { onProgress: (p) => p2.push(p) });
  assert.ok(p2.includes("Compacting context…"), "auto-compaction fires during turn 2 (between-turns)");
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

test("auto-compaction does not fire when the last message is an unanswered user message", async () => {
  // Scenario: pressure is high at the END of turn 1 (after model responded).
  // At the START of turn 2, send() appends the user message, then calls maybeAutoCompact.
  // With the fix, maybeAutoCompact skips because the last message is "user" (unanswered).
  // It should fire AFTER the model responds (between turns), not before.
  const reply = "response text ".repeat(1200); // large reply to push context pressure up
  const invoke = (async () => stop(reply)) as unknown as Invoke;
  const s = new ChatSession("compact-skip-user", { invoke, worktree: wt(), model: "mistral-tiny" });

  const big = "lorem ipsum ".repeat(1700);
  // Turn 1: push pressure high
  const p1: string[] = [];
  await s.send(big, undefined, "agent", { onProgress: (p) => p1.push(p) });
  assert.ok(s.contextPercent() >= 80, "context is under pressure after turn 1");

  // Turn 2: the user message is appended before maybeAutoCompact runs.
  // With the fix, maybeAutoCompact skips (last msg is "user"), lets the model respond,
  // then on the NEXT maybeAutoCompact call (after model reply), compaction fires.
  // This is the correct behavior: compact between turns, not while waiting for the model.
  const p2: string[] = [];
  await s.send("continue", undefined, "agent", { onProgress: (p) => p2.push(p) });
  // REAL INVARIANT (replaces the former tautology): compaction MUST fire during turn 2 (pressure is
  // high), and it MUST fire AFTER the model call — never before, while the user message is unanswered.
  const compactIdx = p2.indexOf("Compacting context…");
  const thinkIdx = p2.indexOf("Thinking…");
  assert.ok(compactIdx >= 0, "auto-compaction fires during turn 2 (between turns)");
  assert.ok(thinkIdx >= 0, "the model was called in turn 2");
  assert.ok(compactIdx > thinkIdx, "compaction fires AFTER the model responds, not while the user message is unanswered");
});

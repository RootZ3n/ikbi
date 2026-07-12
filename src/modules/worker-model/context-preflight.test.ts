import assert from "node:assert/strict";
import { test } from "node:test";

import { estimatePromptTokens, contextExceedsWindow } from "./context-preflight.js";

test("estimatePromptTokens sums parts at ~chars/4, ignoring undefined parts", () => {
  assert.equal(estimatePromptTokens(["aaaa"]), 1, "4 chars ≈ 1 token");
  assert.equal(estimatePromptTokens(["aaaa", undefined, "bbbb"]), 2, "undefined parts contribute nothing");
  assert.equal(estimatePromptTokens([]), 0);
  assert.equal(estimatePromptTokens(["a".repeat(400)]), 100, "400 chars ≈ 100 tokens");
});

test("contextExceedsWindow triggers only above the fraction of the window", () => {
  // 0.7 of a 1000-token window = 700.
  assert.equal(contextExceedsWindow(701, 1000, 0.7), true, "just over the threshold");
  assert.equal(contextExceedsWindow(700, 1000, 0.7), false, "exactly at the threshold is not over");
  assert.equal(contextExceedsWindow(300, 1000, 0.7), false, "well under");
});

test("contextExceedsWindow fail-safe: an unknown/zero window never triggers (don't upgrade on missing caps)", () => {
  assert.equal(contextExceedsWindow(1_000_000, 0, 0.7), false, "zero window ⇒ no upgrade");
  assert.equal(contextExceedsWindow(1_000_000, -1, 0.7), false, "negative/garbage window ⇒ no upgrade");
});

test("a realistic large scout brief on a 32k worker window trips the pre-flight; a small one does not", () => {
  const window = 32_768; // e.g. mimo-v2.5 worker window
  // A ~120k-char brief ≈ 30k tokens > 0.7*32768 (≈22.9k) → bump.
  const bigBrief = "x".repeat(120_000);
  assert.equal(contextExceedsWindow(estimatePromptTokens(["build the thing", undefined, bigBrief]), window, 0.7), true);
  // A modest 8k-char brief ≈ 2k tokens → stays on the cheap model.
  const smallBrief = "x".repeat(8_000);
  assert.equal(contextExceedsWindow(estimatePromptTokens(["build the thing", undefined, smallBrief]), window, 0.7), false);
});

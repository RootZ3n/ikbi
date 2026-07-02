/**
 * Configurable per-round output cap: IKBI_CHAT_MAX_TOKENS overrides the 4096 default so a frontier
 * driver (opus) can emit large single-file writes without truncating at finishReason=length — but the
 * value is operator-chosen and clamped, never a silent raise of the default.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import "../egress/index.js";
import { resolveChatMaxTokens, resolveThinkingBudget, MAX_TOKENS_DEFAULT, MAX_TOKENS_CEILING } from "./session.js";

test("unset env → the safe 4096 default", () => {
  assert.equal(resolveChatMaxTokens(undefined), MAX_TOKENS_DEFAULT);
});

test("a valid override is honored", () => {
  assert.equal(resolveChatMaxTokens("16000"), 16000);
  assert.equal(resolveChatMaxTokens(String(MAX_TOKENS_CEILING)), MAX_TOKENS_CEILING);
});

test("out-of-range / malformed values fall back to the default (never a bad cap)", () => {
  assert.equal(resolveChatMaxTokens("0"), MAX_TOKENS_DEFAULT);
  assert.equal(resolveChatMaxTokens("100"), MAX_TOKENS_DEFAULT); // below the 256 floor
  assert.equal(resolveChatMaxTokens(String(MAX_TOKENS_CEILING + 1)), MAX_TOKENS_DEFAULT); // over ceiling
  assert.equal(resolveChatMaxTokens("-5"), MAX_TOKENS_DEFAULT);
  assert.equal(resolveChatMaxTokens("abc"), MAX_TOKENS_DEFAULT);
  assert.equal(resolveChatMaxTokens("4096.5"), MAX_TOKENS_DEFAULT); // non-integer
});

test("thinking budget: OFF by default, honored when valid, disabled on bad input", () => {
  assert.equal(resolveThinkingBudget(undefined), 0, "off by default");
  assert.equal(resolveThinkingBudget("0"), 0);
  assert.equal(resolveThinkingBudget("500"), 0, "below Anthropic's 1024 minimum → off");
  assert.equal(resolveThinkingBudget("abc"), 0);
  assert.equal(resolveThinkingBudget("1024"), 1024);
  assert.equal(resolveThinkingBudget("8000"), 8000);
  assert.equal(resolveThinkingBudget(String(MAX_TOKENS_CEILING)), 0, "must be strictly under the ceiling");
});

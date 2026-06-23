import assert from "node:assert/strict";
import { test } from "node:test";

import { ContextBudget, estimateTokens } from "./budget.js";

test("estimateTokens approximates ~4 chars per token", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens(400), 100);
});

test("rejects a non-positive budget", () => {
  assert.throws(() => new ContextBudget(0));
  assert.throws(() => new ContextBudget(-5));
});

test("admits files until the budget is spent", () => {
  const b = new ContextBudget(100);
  assert.equal(b.admit("a", 40, 1), true);
  assert.equal(b.admit("b", 40, 1), true);
  assert.equal(b.used(), 80);
  assert.equal(b.remaining(), 20);
  // c (40 tokens) does not fit and is not more relevant than a/b → rejected.
  assert.equal(b.admit("c", 40, 1), false);
  assert.equal(b.has("c"), false);
});

test("a more-relevant newcomer evicts the coldest entries to fit", () => {
  const b = new ContextBudget(100);
  b.admit("low1", 40, 1);
  b.admit("low2", 40, 1);
  // hot newcomer (relevance 5) needs 40; evicts one cold entry to fit.
  assert.equal(b.admit("hot", 40, 5), true);
  assert.equal(b.has("hot"), true);
  // exactly one of the low entries survived (80 used: hot + one low).
  const survivors = b.entries().filter((e) => e.path.startsWith("low"));
  assert.equal(survivors.length, 1);
  assert.equal(b.used(), 80);
});

test("a less-relevant newcomer cannot evict more-relevant entries", () => {
  const b = new ContextBudget(80);
  b.admit("keep", 80, 10);
  assert.equal(b.admit("weak", 40, 1), false);
  assert.equal(b.has("keep"), true);
  assert.equal(b.has("weak"), false);
});

test("a file larger than the whole budget is never admitted", () => {
  const b = new ContextBudget(50);
  assert.equal(b.admit("huge", 60, 100), false);
});

test("hot files (many hits) resist eviction via the keep bonus", () => {
  const b = new ContextBudget(80);
  b.admit("a", 40, 1);
  b.admit("b", 40, 1);
  for (let i = 0; i < 10; i++) b.touch("a"); // a becomes hot → keepScore ~1.5
  // newcomer relevance 1.2: above b (1.0) but below hot a (~1.5) → evicts b, keeps a.
  assert.equal(b.admit("c", 40, 1.2), true);
  assert.equal(b.has("a"), true);
  assert.equal(b.has("b"), false);
});

test("re-admitting a present path refreshes relevance without double-charging", () => {
  const b = new ContextBudget(100);
  b.admit("a", 40, 1);
  assert.equal(b.admit("a", 40, 5), true);
  assert.equal(b.used(), 40, "tokens not double-counted");
  assert.equal(b.entries().find((e) => e.path === "a")?.relevance, 5);
});

test("evictColdest removes the lowest keep-score entry", () => {
  const b = new ContextBudget(120);
  b.admit("a", 40, 3);
  b.admit("b", 40, 1);
  b.admit("c", 40, 2);
  const evicted = b.evictColdest();
  assert.equal(evicted?.path, "b");
  assert.equal(b.used(), 80);
});

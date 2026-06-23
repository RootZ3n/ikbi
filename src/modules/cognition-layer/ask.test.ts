/**
 * ikbi cognition-layer ask-bridge tests — clarification from an `ask` decision, prompt formatting,
 * and answer interpretation.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { CognitionDecision } from "./contract.js";
import { clarificationRequest, formatAskPrompt, interpretAnswer } from "./ask.js";

function decision(over: Partial<CognitionDecision>): CognitionDecision {
  return { decision: "ask", confidence: 0.5, rationale: "underspecified", memoryUsed: [], ...over };
}

test("clarificationRequest: builds a question from missingInfo", () => {
  const req = clarificationRequest(decision({ missingInfo: ["target database", "auth method"] }), "build the API");
  assert.ok(req !== undefined);
  assert.match(req.question, /target database/);
  assert.match(req.question, /auth method/);
});

test("clarificationRequest: returns undefined for a non-ask decision", () => {
  assert.equal(clarificationRequest(decision({ decision: "answer" }), "x"), undefined);
});

test("clarificationRequest: falls back to rationale when no missingInfo", () => {
  const req = clarificationRequest(decision({ missingInfo: [], rationale: "need the scope" }), "do it");
  assert.match(req?.question ?? "", /need the scope/);
});

test("formatAskPrompt: numbers options and prompts for a choice", () => {
  const out = formatAskPrompt({ question: "Which DB?", options: ["Postgres", "SQLite"], header: "DB" });
  assert.match(out, /\[DB\] Which DB\?/);
  assert.match(out, /1\) Postgres/);
  assert.match(out, /2\) SQLite/);
  assert.match(out, /option number or your own answer/);
});

test("formatAskPrompt: open-ended prompt has no options", () => {
  const out = formatAskPrompt({ question: "What next?" });
  assert.match(out, /Your answer:/);
  assert.doesNotMatch(out, /\d\)/);
});

test("interpretAnswer: numeric choice maps to option", () => {
  const r = interpretAnswer({ question: "?", options: ["a", "b", "c"] }, "3");
  assert.deepEqual(r, { answer: "c", selectedIndex: 2 });
});

test("interpretAnswer: out-of-range number falls back to free text", () => {
  const r = interpretAnswer({ question: "?", options: ["a", "b"] }, "9");
  assert.deepEqual(r, { answer: "9" });
});

test("interpretAnswer: open-ended returns trimmed text", () => {
  assert.deepEqual(interpretAnswer({ question: "?" }, "  hello  "), { answer: "hello" });
});

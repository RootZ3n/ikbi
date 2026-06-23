/**
 * ikbi ask_user tool tests — interactive answerer, option resolution, safe non-blocking fallback.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AskUserRequest } from "../cognition-layer/ask.js";
import { askUserTool, runAskUser } from "./ask-user.js";

test("askUserTool: schema requires a question", () => {
  assert.equal(askUserTool.name, "ask_user");
  const p = askUserTool.parameters as { required: string[]; properties: Record<string, unknown> };
  assert.deepEqual(p.required, ["question"]);
  assert.ok("options" in p.properties);
});

test("open-ended: returns the operator's free-text answer", async () => {
  const ask = async (_req: AskUserRequest) => "use postgres";
  const out = await runAskUser({ ask }, { question: "Which DB?" });
  assert.match(out, /The operator answered: "use postgres"/);
});

test("multiple-choice: numeric reply resolves to the option", async () => {
  let seen: AskUserRequest | undefined;
  const ask = async (req: AskUserRequest) => {
    seen = req;
    return "2";
  };
  const out = await runAskUser({ ask }, { question: "Which DB?", options: ["Postgres", "SQLite", "MySQL"] });
  assert.match(out, /selected option 2: "SQLite"/);
  assert.deepEqual([...(seen?.options ?? [])], ["Postgres", "SQLite", "MySQL"]);
});

test("multiple-choice: option text reply resolves (case-insensitive)", async () => {
  const ask = async (_req: AskUserRequest) => "postgres";
  const out = await runAskUser({ ask }, { question: "Which DB?", options: ["Postgres", "SQLite"] });
  assert.match(out, /selected option 1: "Postgres"/);
});

test("rejects an empty question", async () => {
  const out = await runAskUser({ ask: async () => "x" }, { question: "   " });
  assert.match(out, /requires a non-empty 'question'/);
});

test("rejects more than 4 options", async () => {
  const out = await runAskUser({ ask: async () => "x" }, { question: "pick", options: ["a", "b", "c", "d", "e"] });
  assert.match(out, /at most 4 options/);
});

test("no channel: fails SAFE (does not block, tells the model to proceed)", async () => {
  const out = await runAskUser({}, { question: "Which DB?" });
  assert.match(out, /ASK_USER UNAVAILABLE/);
  assert.match(out, /proceed with your best assumption/i);
});

test("empty answer: returns proceed guidance, not a hang", async () => {
  const out = await runAskUser({ ask: async () => "" }, { question: "Which DB?" });
  assert.match(out, /no answer/i);
});

test("answerer throwing is surfaced as an ERROR string", async () => {
  const out = await runAskUser({ ask: async () => { throw new Error("readline closed"); } }, { question: "Which DB?" });
  assert.match(out, /ERROR: ask_user failed/);
});

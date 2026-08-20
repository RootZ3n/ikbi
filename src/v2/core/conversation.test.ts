/*
  THE BUILDER CONVERSATION WINDOW — and the promise that it is model-agnostic.

  The defect: v2 budgeted the initial context package against the selected model's window
  and then re-rendered a conversation that grew without bound. Real MiMo (65,536) was sent
  ~69,937 tokens over twelve turns and ~93,953 over twenty-four, with no guard.

  The architectural principle these tests exist to hold in place:

      MODEL NAMES SELECT FACTS.
      FACTS SELECT BEHAVIOR.
      MODEL NAMES DO NOT SELECT BUILDER POLICY.

  So the matrix below runs the SAME engine over 8k, 65,536, 131,072 and 200k windows, over
  a fictional roster-declared model nobody wrote code for, over a model with no window at
  all, and over a conversation with no native tool calls in it. Nothing in the module under
  test knows the name of any of them.
*/

import "../test-env.js"; // MUST be first: hermetic synthetic dev-key opt-in, before core config loads
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  COMPACTION_ALGORITHM,
  DEFAULT_RECENT_GROUPS,
  ESTIMATOR_KIND,
  MIN_RECENT_GROUPS,
  ESTIMATOR_RESIDUAL_ALLOWANCE,
  V2_CONVERSATION_FAILURE_CODES,
  conversationCeiling,
  estimateMessagesTokens,
  factOf,
  fitConversation,
  groupConversation,
  renderMemory,
  type ConversationMemory,
} from "./conversation.js";
import { deriveBudget, estimateTokens } from "./context.js";
import type { RenderedMessage } from "./prompt.js";
import { GENERIC_TOKEN_ESTIMATOR, type ModelCapabilityFacts } from "./config.js";
import { MAX_TOOL_READ_CHARS } from "./tools.js";
import { V2_DEFAULT_COMMAND_POLICY } from "./command.js";

/* ── Fixtures: models are DATA, and nothing below is named in the module ──── */

/** A capability fact set. This is the only thing that differs between "models" here. */
const facts = (contextWindow: number, supportsTools = true): ModelCapabilityFacts => ({
  contextWindow,
  supportsTools,
  supportsThinking: false,
  reasoningLevel: "medium",
  speedClass: "medium",
  provenance: "declared",
});

const ceilingFor = (window: number) => {
  const b = deriveBudget(facts(window));
  assert.ok(b.ok, `a ${window}-token model must yield a budget`);
  return conversationCeiling(b.budget);
};

/** A conversation of `groups` assistant/tool pairs, each about `chars` long. */
function conversationOf(groups: number, chars = 8_000): RenderedMessage[] {
  const out: RenderedMessage[] = [];
  for (let i = 0; i < groups; i += 1) {
    out.push({ role: "assistant", content: `turn ${i}`, toolCalls: [{ id: `c${i}`, name: "read_file", arguments: JSON.stringify({ path: `src/f${i}.ts` }) }] });
    out.push({ role: "tool", toolCallId: `c${i}`, content: "x".repeat(chars), untrusted: true });
  }
  return out;
}

const memory: ConversationMemory = {
  facts: [
    factOf({ kind: "observed", path: "src/a.ts", observationId: "o1", state: "regular", contentSha256: "aaa", byteLength: 12 }),
    factOf({ kind: "applied", path: "src/a.ts", operation: "replace_file", mutationId: "m1", changed: true, beforeSha256: "aaa", afterSha256: "bbb" }),
  ],
  changedPaths: ["src/a.ts"],
};

const render = (c: readonly RenderedMessage[]) => estimateMessagesTokens(c, GENERIC_TOKEN_ESTIMATOR) + 8_000; // 8k of immutable package
const fit = (conversation: readonly RenderedMessage[], window: number, turn = 1) =>
  fitConversation({ conversation, memory, ceiling: ceilingFor(window), turn, renderSize: render });

/* ── A. short conversation: no compaction ────────────────────────────────── */

test("window: a short conversation is sent unchanged", () => {
  const conversation = conversationOf(2);
  const r = fit(conversation, 65_536);
  assert.ok(r.ok);
  assert.equal(r.event, undefined, "nothing was folded");
  assert.deepEqual(r.conversation, conversation, "and the messages are byte-identical");
});

/* ── B/C. near the limit, then over it ───────────────────────────────────── */

test("window: a conversation that fits exactly is not compacted", () => {
  const ceiling = ceilingFor(65_536);
  // Grow until one more group would cross, then assert the last fitting one is untouched.
  let groups = 1;
  while (render(conversationOf(groups + 1)) <= ceiling.maxRenderedInputTokens) groups += 1;
  const r = fit(conversationOf(groups), 65_536);
  assert.ok(r.ok);
  assert.equal(r.event, undefined);
  assert.ok(r.estimatedTokens <= ceiling.maxRenderedInputTokens);
});

test("window: an over-window conversation is compacted BEFORE it is sent", () => {
  const ceiling = ceilingFor(65_536);
  const conversation = conversationOf(40);
  assert.ok(render(conversation) > ceiling.maxRenderedInputTokens, "the fixture really does overflow");

  const r = fit(conversation, 65_536, 13);
  assert.ok(r.ok, "it fits after folding");
  assert.ok(r.estimatedTokens <= ceiling.maxRenderedInputTokens, `${r.estimatedTokens} <= ${ceiling.maxRenderedInputTokens}`);
  assert.ok(r.event !== undefined);
  assert.equal(r.event.turn, 13);
  assert.equal(r.event.algorithm, COMPACTION_ALGORITHM);
  assert.ok(r.event.estimatedTokensAfter < r.event.estimatedTokensBefore);
  assert.ok(r.event.groupsFolded > 0);
  assert.ok(r.event.groupsKept >= MIN_RECENT_GROUPS);
});

test("window: the memory block is first and the recent tail is verbatim", () => {
  const conversation = conversationOf(40);
  const r = fit(conversation, 65_536);
  assert.ok(r.ok && r.event !== undefined);
  assert.equal(r.conversation[0]!.role, "user");
  assert.match(r.conversation[0]!.content, /EARLIER WORK IN THIS CANDIDATE/);
  // The tail is the true end of the original conversation, unmodified.
  const tail = r.conversation.slice(1);
  assert.deepEqual(tail, conversation.slice(conversation.length - tail.length));
});

/* ── D. repeated overflow ────────────────────────────────────────────────── */

test("window: it can compact again later in the same candidate", () => {
  const ceiling = ceilingFor(65_536);
  const first = fit(conversationOf(40), 65_536, 10);
  assert.ok(first.ok && first.event !== undefined);
  // The loop carries the compacted conversation forward; growth resumes from there.
  const grown = [...first.conversation, ...conversationOf(30)];
  const second = fit(grown, 65_536, 20);
  assert.ok(second.ok && second.event !== undefined, "a second fold happens when it grows again");
  assert.ok(second.estimatedTokens <= ceiling.maxRenderedInputTokens);
  assert.equal(second.event.turn, 20);
});

/* ── E. it cannot fit at all ─────────────────────────────────────────────── */

test("window: an immovable request FAILS CLOSED rather than being sent", () => {
  // A tiny window and a huge immutable package: no amount of folding can help.
  const bigRender = (c: readonly RenderedMessage[]) => estimateMessagesTokens(c, GENERIC_TOKEN_ESTIMATOR) + 100_000;
  const r = fitConversation({
    conversation: conversationOf(6),
    memory,
    ceiling: ceilingFor(8_192),
    turn: 3,
    renderSize: bigRender,
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.failure.code, V2_CONVERSATION_FAILURE_CODES.minimumRequestExceedsWindow);
    assert.equal(r.failure.code, "context.minimum_request_exceeds_window");
    assert.notEqual(r.failure.code, "build.turn_limit_exceeded", "a window problem is not a turn problem");
    assert.equal(r.failure.retryable, false);
    assert.equal(r.failure.stage, "candidate_generation");
    assert.match(r.failure.message, /does not fit/);
  }
});

/* ── F/G. authority is never invented ────────────────────────────────────── */

test("window: the memory records that a mutation happened, truthfully", () => {
  const block = renderMemory(memory, 7);
  assert.match(block.content, /replace_file src\/a\.ts — CHANGED/);
  assert.match(block.content, /FILES YOU HAVE ALREADY CHANGED/);
  assert.match(block.content, /src\/a\.ts/);
  assert.match(block.content, /7 exchanges/, "it says how much was folded");
});

test("window: a folded observation is NOT presented as usable authority", () => {
  const block = renderMemory(memory, 3);
  // It must not hand back an id the model could quote into a write.
  assert.doesNotMatch(block.content, /observationId/i);
  assert.doesNotMatch(block.content, /\bo1\b/, "the observation id does not travel into the fold");
  // And it must say plainly what the mutation authority will enforce anyway.
  assert.match(block.content, /read it again first/i);
  assert.match(block.content, /refused without a current one/i);
});

test("window: no repository content or command output crosses into the memory block", () => {
  /*
    The fold is harness-authored and therefore OUTSIDE the untrusted fence. Summarizing a
    file's contents into it would launder untrusted repository text into trusted framing,
    which is exactly what the neutralization boundary exists to prevent. Only provenance
    the harness observed itself may appear.
  */
  const withContent: ConversationMemory = {
    facts: [factOf({ kind: "observed", path: "src/secret.ts", observationId: "o9", state: "regular", contentSha256: "z", byteLength: 5, content: "SUPER_SECRET_BODY" })],
    changedPaths: [],
  };
  const block = renderMemory(withContent, 2);
  assert.doesNotMatch(block.content, /SUPER_SECRET_BODY/, "file bodies never enter the fold");
  assert.match(block.content, /read src\/secret\.ts/, "but the fact that it was read does");
});

test("window: a command's output does not travel, only its outcome", () => {
  const m: ConversationMemory = {
    facts: [factOf({
      kind: "command", program: "git", args: ["status"], cwd: "/w", launched: true, refused: false,
      exitCode: 0, timedOut: false, workspaceUnchanged: true, outputSha256: "s", outputByteLength: 9,
      outputTruncated: false, untrusted: "ON BRANCH SECRET-THING",
    })],
    changedPaths: [],
  };
  const block = renderMemory(m, 1);
  assert.doesNotMatch(block.content, /SECRET-THING/);
  assert.match(block.content, /ran git status — exit 0/);
});

/* ── H. the wire protocol stays valid ────────────────────────────────────── */

test("window: a tool call is never separated from its result", () => {
  const conversation = conversationOf(40);
  const r = fit(conversation, 65_536);
  assert.ok(r.ok);
  const ids = new Set<string>();
  for (const m of r.conversation) {
    for (const c of m.toolCalls ?? []) ids.add(c.id);
    if (m.role === "tool") {
      assert.ok(m.toolCallId !== undefined, "a tool result names its call");
      assert.ok(ids.has(m.toolCallId), `orphaned tool result for ${m.toolCallId}`);
    }
  }
});

test("window: grouping starts a group at each assistant turn", () => {
  const groups = groupConversation(conversationOf(3));
  assert.equal(groups.length, 3);
  for (const g of groups) {
    assert.equal(g.messages[0]!.role, "assistant");
    assert.equal(g.messages.length, 2);
  }
});

test("window: a conversation with NO native tool calls groups and folds too", () => {
  /*
    Text-emulation models never emit a native tool_call. The grouping keys on the
    assistant turn, not on the presence of tool calls, so the same engine handles them.
  */
  const plain: RenderedMessage[] = [];
  for (let i = 0; i < 40; i += 1) {
    plain.push({ role: "assistant", content: `I will now edit file ${i}. ${"y".repeat(8_000)}` });
    plain.push({ role: "user", content: "continue" });
  }
  assert.equal(groupConversation(plain).length, 40);
  const r = fit(plain, 65_536);
  assert.ok(r.ok && r.event !== undefined, "a tool-less conversation still compacts");
  assert.ok(r.estimatedTokens <= ceilingFor(65_536).maxRenderedInputTokens);
});

/* ── The window invariant, across every model shape ──────────────────────── */

test("window: the invariant holds for 8k, 64k, 128k and 200k models alike", () => {
  for (const window of [8_192, 65_536, 131_072, 200_000]) {
    const ceiling = ceilingFor(window);
    assert.equal(
      ceiling.maxRenderedInputTokens,
      Math.floor((window - ceiling.reservedCompletionTokens - ceiling.reservedOverheadTokens) / ESTIMATOR_RESIDUAL_ALLOWANCE),
      `${window}: the ceiling is derived, not chosen`,
    );
    assert.ok(
      ceiling.maxRenderedInputTokens + ceiling.reservedCompletionTokens + ceiling.reservedOverheadTokens + ceiling.safetyMarginTokens <= window,
      `${window}: input + output + overhead + margin must fit the window`,
    );
    // And a real conversation on that model never exceeds it.
    const r = fit(conversationOf(60), window);
    if (r.ok) assert.ok(r.estimatedTokens <= ceiling.maxRenderedInputTokens, `${window}: ${r.estimatedTokens}`);
  }
});

test("window: a bigger window really does buy more conversation", () => {
  // The proof that behaviour follows the FACTS: the same history folds on a small model
  // and does not on a large one, with no branch anywhere.
  const conversation = conversationOf(24);
  const small = fit(conversation, 65_536);
  const large = fit(conversation, 200_000);
  assert.ok(small.ok && large.ok);
  assert.ok(small.event !== undefined, "the 64k model must fold this");
  assert.equal(large.event, undefined, "the 200k model must not");
});

test("window: a fictional roster-declared model works with no code change", () => {
  /*
    THE acceptance test for model-agnosticism. `future-model-x` exists nowhere in ikbi's
    source; it is capability DATA. The engine derives its envelope and compacts correctly
    because facts are the only input.
  */
  const ceiling = ceilingFor(131_072);
  const r = fit(conversationOf(80), 131_072, 5);
  assert.ok(r.ok);
  assert.ok(r.estimatedTokens <= ceiling.maxRenderedInputTokens);
  assert.equal(ceiling.contextWindowTokens, 131_072);
  assert.equal(ceiling.capabilityProvenance, "declared");
});

test("window: a model with NO known window is refused, not guessed", () => {
  const budget = deriveBudget(undefined);
  assert.equal(budget.ok, false, "an unclassified model yields no budget at all");
  if (!budget.ok) assert.match(budget.failure.message, /without guessing/);
});

/* ── Independence: no shared state between runs or candidates ─────────────── */

test("window: two runs on different models derive independent ceilings", () => {
  const a = ceilingFor(65_536);
  const b = ceilingFor(200_000);
  assert.notEqual(a.maxRenderedInputTokens, b.maxRenderedInputTokens);
  // Deriving the second must not have disturbed the first.
  assert.deepEqual(a, ceilingFor(65_536), "no state leaks between derivations");
});

test("window: fitting is pure — two candidates cannot share compacted history", () => {
  const conversation = conversationOf(40);
  const one = fit(conversation, 65_536);
  const two = fit(conversation, 65_536);
  assert.deepEqual(one, two, "same input, same answer, no hidden cache");
  // The input is never mutated, so a sibling candidate's conversation is untouched.
  assert.equal(conversation.length, 80);
});

/* ── Estimator honesty ───────────────────────────────────────────────────── */

test("window: the estimator never claims to be exact", () => {
  assert.equal(ESTIMATOR_KIND, "conservative_estimate");
  assert.equal(ceilingFor(65_536).estimator, "conservative_estimate");
});

test("window: tool-call arguments are counted, not just message text", () => {
  const body = JSON.stringify({ path: "a.ts", content: "z".repeat(8_000) });
  const withCall: RenderedMessage[] = [{ role: "assistant", content: "", toolCalls: [{ id: "c", name: "replace_file", arguments: body }] }];
  const counted = estimateMessagesTokens(withCall, GENERIC_TOKEN_ESTIMATOR);
  assert.ok(counted >= estimateTokens(body), `${counted} must include the ${estimateTokens(body)}-token argument`);
});

/* ── No model-name policy branches ───────────────────────────────────────── */

test("window: the module branches on FACTS, never on model or provider names", () => {
  /*
    The static guard the architecture principle asks for. Comments may discuss the models
    a defect was found on — the reproduction fixture is part of the record — but no CODE
    may test a name. Strip comments, then look.
  */
  const src = readFileSync(new URL("../../../src/v2/core/conversation.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  for (const name of ["mimo", "deepseek", "openai", "gpt", "anthropic", "claude", "gemini", "google", "ollama", "minimax", "mistral", "groq", "together"]) {
    assert.doesNotMatch(code.toLowerCase(), new RegExp(`\\b${name}\\b`), `conversation.ts must not know about "${name}"`);
  }
  // Nor may it hard-code the window of the model the defect was found on.
  assert.doesNotMatch(code, /65_?536|131_?072|200_?000|8_?192/, "window sizes are facts, not constants here");
  // The only tuning constants it may carry are policy, and they are named.
  assert.equal(typeof ESTIMATOR_RESIDUAL_ALLOWANCE, "number");
  assert.equal(typeof DEFAULT_RECENT_GROUPS, "number");
});

test("window: the builder loop also carries no model-name policy branch", () => {
  const src = readFileSync(new URL("../../../src/v2/core/builder.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const name of ["mimo", "deepseek", "openai", "anthropic", "gemini", "ollama", "minimax"]) {
    assert.doesNotMatch(code.toLowerCase(), new RegExp(`\\b${name}\\b`), `builder.ts must not branch on "${name}"`);
  }
});

/* ── Tool output is already bounded (audit, requirement 14) ──────────────── */

test("window: a single tool result cannot be unbounded", () => {
  /*
    Compaction bounds the CONVERSATION; these bound each contribution to it. Both are
    32,000 characters — roughly 8,000 estimated tokens — so no single read or command can
    consume a whole small model's window on its own, and a truncation always says so
    rather than silently shortening.
  */
  assert.equal(MAX_TOOL_READ_CHARS, 32_000);
  assert.equal(V2_DEFAULT_COMMAND_POLICY.maxOutputBytes, 32_000);
  assert.ok(estimateTokens("x".repeat(MAX_TOOL_READ_CHARS)) < ceilingFor(65_536).maxRenderedInputTokens / 4,
    "one read is a fraction of a small model's window, not most of it");
});

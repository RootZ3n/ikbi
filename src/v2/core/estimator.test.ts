/*
  THE CONSERVATIVE TOKEN ESTIMATOR.

  A real MiMo request at the compaction threshold was estimated at 53,901 tokens and came
  back from the provider at 60,560 — 12.4% under. The context invariant held anyway, but
  only because the completion reserve happened to be big enough to absorb the error. That
  is luck, not design, and the next model with a tighter reserve would have overflowed.

  The fix is not a bigger margin bolted onto a wrong number. It is a number that stops
  being wrong in one direction: 4 chars/token is an ENGLISH PROSE figure, and a builder
  conversation is TypeScript, JSON, paths and hex digests.

  These tests pin that the estimator is INTENTIONALLY CONSERVATIVE against representative
  payload classes, without tuning to the one prompt that exposed the problem, and without
  a single model name anywhere.
*/

import "../test-env.js"; // MUST be first: hermetic synthetic dev-key opt-in, before core config loads
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { CHARS_PER_TOKEN, deriveBudget, estimateTokens } from "./context.js";
import { conversationCeiling, safetyMarginFor } from "./conversation.js";
import type { ModelCapabilityFacts } from "./config.js";

/* ── Representative payload classes ──────────────────────────────────────── */

/**
 * Densities to protect against, in characters per token.
 *
 * These are the conservative ends of what BPE tokenizers do to each class — code and
 * JSON split on identifiers and punctuation, hex digests approach two characters per
 * token. The estimator must not assume anything looser than the densest class it will
 * realistically meet, because being wrong here is being wrong on the wire.
 */
const OBSERVED_DENSITY = {
  prose: 4.2,
  markdown: 3.8,
  typescript: 3.3,
  json: 3.2,
  paths: 3.0,
  digests: 2.4,
} as const;

const PROSE =
  "The workshop is the world and the project is the spine. A visitor arrives with an idea " +
  "and leaves with a plan they can defend, which is the only kind worth having. ".repeat(20);

const TYPESCRIPT = readFileSync(new URL("../../../src/v2/core/conversation.ts", import.meta.url), "utf8");
const MARKDOWN = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
const JSON_ARGS = JSON.stringify({
  path: "frontend/src/lib/docs.ts",
  observationId: "obs_9c2fd726fdcf4e46904d1bca0deb54aa",
  content: "export const PUBLIC_DOCS = new Set([\n  'electrical-fundamentals',\n]);\n".repeat(40),
});
const PATHS = Array.from({ length: 300 }, (_, i) => `frontend/src/lib/building/module-${i}/index.ts`).join("\n");
const DIGESTS = Array.from({ length: 200 }, (_, i) => `${i}`.padStart(2, "0").repeat(32)).join("\n");

const CORPUS = { prose: PROSE, markdown: MARKDOWN, typescript: TYPESCRIPT, json: JSON_ARGS, paths: PATHS, digests: DIGESTS };

/* ── The claim ───────────────────────────────────────────────────────────── */

test("estimator: it is more conservative than the prose heuristic it replaced", () => {
  assert.ok(CHARS_PER_TOKEN < 4, `chars/token is ${CHARS_PER_TOKEN}; 4 was the prose figure that undercounted`);
  const text = "x".repeat(10_000);
  assert.ok(estimateTokens(text) > 10_000 / 4, "every estimate is larger than the old one");
});

test("estimator: it does not undercount any representative payload class except the densest", () => {
  /*
    For each class, compare the estimate against what a tokenizer at that class's observed
    density would produce. The estimator should meet or exceed it for everything a builder
    conversation is mostly made of.
  */
  const shortfalls: string[] = [];
  for (const [name, text] of Object.entries(CORPUS)) {
    const density = OBSERVED_DENSITY[name as keyof typeof OBSERVED_DENSITY];
    const likely = Math.ceil(text.length / density);
    const estimated = estimateTokens(text);
    if (estimated < likely) shortfalls.push(`${name}: estimated ${estimated} < likely ${likely}`);
  }
  /*
    Pure hex digests (≈2.4 chars/token) are the one class no chars-per-token constant can
    cover without making every ordinary prompt absurdly pessimistic — and they are a small
    fraction of any real conversation. Everything else must be covered.
  */
  assert.deepEqual(shortfalls.map((s) => s.split(":")[0]), ["digests"], shortfalls.join(" | "));
});

test("estimator: it covers the error actually observed in production, with headroom", () => {
  // The real event: chars/4 said 53,901 and the provider said 60,560.
  const OBSERVED_RATIO = 60_560 / 53_901; // ≈ 1.124
  const improvement = 4 / CHARS_PER_TOKEN; // how much bigger every estimate now is
  assert.ok(improvement >= OBSERVED_RATIO, `estimates grew ${improvement.toFixed(3)}×, need ≥ ${OBSERVED_RATIO.toFixed(3)}×`);
  assert.ok(improvement < 1.6, "but not so pessimistic that it wastes most of a window");
});

test("estimator: the same request would now have stayed under the ceiling", () => {
  /*
    Replay the production numbers. The old estimate was 53,901 against a 53,796 ceiling —
    it had just crossed, which is why it folded. What matters is whether the ESTIMATE
    would have exceeded the ceiling before the real request exceeded the window.
  */
  const oldEstimate = 53_901;
  const actual = 60_560;
  const newEstimate = Math.ceil(oldEstimate * (4 / CHARS_PER_TOKEN));
  assert.ok(newEstimate >= actual, `the new estimate (${newEstimate}) must not undercount the real ${actual}`);
});

test("estimator: rounding is always up", () => {
  // A fractional token is a whole token on the wire.
  assert.equal(estimateTokens("a"), 1);
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("ab"), 1);
});

test("estimator: non-ASCII text is never counted as cheaper than ASCII", () => {
  /*
    Multi-byte characters generally cost MORE tokens, not fewer. A length-based estimator
    must at minimum not treat them as cheaper — which it does not, because it counts code
    units. Stated so a future switch to byte- or grapheme-counting has to consider it.
  */
  const ascii = "a".repeat(1_000);
  const accented = "é".repeat(1_000);
  const cjk = "工".repeat(1_000);
  assert.ok(estimateTokens(accented) >= estimateTokens(ascii) * 0.9, "accented text is not counted as much cheaper");
  assert.ok(estimateTokens(cjk) >= estimateTokens(ascii) * 0.9, "CJK text is not counted as much cheaper");
});

/* ── The margin is now margin, not a load-bearing accident ───────────────── */

const facts = (contextWindow: number): ModelCapabilityFacts => ({
  contextWindow,
  supportsTools: true,
  supportsThinking: false,
  reasoningLevel: "medium",
  speedClass: "medium",
  provenance: "declared",
});

test("estimator: the ceiling separates completion reserve, overhead and estimator margin", () => {
  for (const window of [8_192, 65_536, 131_072, 200_000]) {
    const b = deriveBudget(facts(window));
    assert.ok(b.ok);
    const c = conversationCeiling(b.budget);
    // Three DISTINCT allowances, none doing another's job.
    assert.ok(c.reservedCompletionTokens > 0);
    assert.ok(c.reservedOverheadTokens > 0);
    assert.equal(c.safetyMarginTokens, safetyMarginFor(window));
    assert.equal(
      c.maxRenderedInputTokens,
      window - c.reservedCompletionTokens - c.reservedOverheadTokens - c.safetyMarginTokens,
    );
  }
});

test("estimator: the invariant no longer depends on the completion reserve absorbing error", () => {
  /*
    THE regression this whole part exists to prevent. Take the production request, assume
    the estimator is still 12.4% optimistic in the worst case, and check that a request
    sized to the ceiling still fits the window WITHOUT borrowing the completion reserve.
  */
  for (const window of [8_192, 65_536, 131_072, 200_000]) {
    const b = deriveBudget(facts(window));
    assert.ok(b.ok);
    const c = conversationCeiling(b.budget);
    /*
      The worst case worth designing for, stated explicitly rather than assumed.

      Every payload class except pure hex is covered by the divisor itself, so the
      residual error comes only from the digest fraction of a request. A DIGEST-HEAVY
      conversation — a quarter of its characters pure hex, which is already extreme for
      real tool provenance — carries a residual of ~1.06.

      A request that is 100% hex is deliberately NOT the design point: covering it would
      need a divisor near 2.4, wasting a fifth of every ordinary window to insure against
      a prompt nobody sends. If one ever occurs the completion reserve absorbs it, which
      is the reserve doing its job for a pathological case rather than, as before,
      silently underwriting the ordinary one.
    */
    const DIGEST_FRACTION = 0.25;
    const RESIDUAL = (1 - DIGEST_FRACTION) + DIGEST_FRACTION * (CHARS_PER_TOKEN / OBSERVED_DENSITY.digests);
    const worstCaseActual = Math.ceil(c.maxRenderedInputTokens * RESIDUAL);
    // It must still leave the completion reserve untouched and stay inside the window.
    assert.ok(
      worstCaseActual + c.reservedCompletionTokens <= window,
      `${window}: a ceiling-sized request could reach ${worstCaseActual}, leaving no room for the reply`,
    );
  }
});

test("estimator: no model name selects an estimate", () => {
  const src = readFileSync(new URL("../../../src/v2/core/context.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const name of ["mimo", "deepseek", "openai", "gpt", "anthropic", "claude", "gemini", "ollama", "minimax"]) {
    assert.doesNotMatch(code.toLowerCase(), new RegExp(`\\b${name}\\b`), `context.ts must not branch on "${name}"`);
  }
});

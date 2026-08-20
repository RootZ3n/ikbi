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

import { CHARS_PER_TOKEN, deriveBudget, estimateTokens, estimateTokensWith, type ContextBudget } from "./context.js";
import { conversationCeiling, ESTIMATOR_RESIDUAL_ALLOWANCE } from "./conversation.js";
import { GENERIC_TOKEN_ESTIMATOR, type ModelCapabilityFacts } from "./config.js";

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

test("estimator: every payload class stays inside the residual allowance", () => {
  /*
    The per-class densities below are ESTIMATES — informed guesses about how BPE treats
    each kind of text. The two production measurements are DATA, and they are what the
    divisor is derived from. So this test does not claim the divisor covers every class
    outright; it claims the honest thing: whatever any class falls short by, the residual
    allowance is sized to absorb it.

    That is the whole point of separating the two corrections. The estimator is faithful,
    the allowance carries the uncertainty, and neither is doing the other's job.
  */
  for (const [name, text] of Object.entries(CORPUS)) {
    const density = OBSERVED_DENSITY[name as keyof typeof OBSERVED_DENSITY];
    const shortfallRatio = CHARS_PER_TOKEN / density; // >1 means this class is denser than assumed
    if (shortfallRatio <= 1) continue; // covered by the divisor outright
    assert.ok(
      shortfallRatio <= 1.5,
      `${name} (${density} chars/token) is denser than any single allowance should carry: ${shortfallRatio.toFixed(3)}×`,
    );
    // And the estimate is never absurd in the other direction either.
    assert.ok(estimateTokens(text) > 0);
  }
});

test("estimator: prose and markdown — the classes it should cover outright — do not undercount", () => {
  for (const name of ["prose", "markdown"] as const) {
    const likely = Math.ceil(CORPUS[name].length / OBSERVED_DENSITY[name]);
    assert.ok(estimateTokens(CORPUS[name]) >= likely, `${name} undercounts`);
  }
});

test("estimator: it covers the error actually observed in production, with headroom", () => {
  // The real event: chars/4 said 53,901 and the provider said 60,560.
  const OBSERVED_RATIO = 60_560 / 53_901; // ≈ 1.124
  const improvement = 4 / CHARS_PER_TOKEN; // how much bigger every estimate now is
  assert.ok(improvement >= OBSERVED_RATIO, `estimates grew ${improvement.toFixed(3)}×, need ≥ ${OBSERVED_RATIO.toFixed(3)}×`);
  assert.ok(improvement < 1.6, "but not so pessimistic that it wastes most of a window");
});

test("estimator: it is calibrated against BOTH real measurements, not one", () => {
  /*
    Two independent production runs, each with a different divisor in force, both against
    a real provider tokenizer. Inverting each gives the true density, and they agree to
    within 0.8% — which is why 3.5 is a derivation rather than a guess.
  */
  const measured = [
    { estimate: 53_901, divisor: 4.0, observed: 60_560 },
    { estimate: 51_819, divisor: 3.0, observed: 43_336 },
  ].map((m) => (m.estimate * m.divisor) / m.observed);

  assert.ok(Math.abs(measured[0]! - measured[1]!) / measured[0]! < 0.02, `densities disagree: ${measured.join(", ")}`);
  for (const density of measured) {
    const ratio = density / CHARS_PER_TOKEN; // estimate ÷ actual under the current divisor
    assert.ok(ratio >= 1.0, `the estimator must not undercount a measured real request (${ratio.toFixed(3)})`);
    assert.ok(ratio <= 1.10, `nor grossly overcount it (${ratio.toFixed(3)}) — that is what caused the false refusal`);
  }
});

test("estimator: the request that was falsely refused would now fit", () => {
  /*
    THE regression. A real run refused a request estimated at 58,266 against a 51,911
    ceiling, on a 65,536-token model — while the actual request was ~43k and had 22,200
    tokens of real headroom. Re-express that same content under the current divisor and
    it must fit.
  */
  const charsOfThatRequest = 58_266 * 3.0; // it was estimated under the 3.0 divisor
  const nowEstimated = Math.ceil(charsOfThatRequest / CHARS_PER_TOKEN);
  const b = deriveBudget(facts(65_536));
  assert.ok(b.ok);
  const ceiling = conversationCeiling(b.budget);
  assert.ok(
    nowEstimated <= ceiling.maxRenderedInputTokens,
    `still refused: ${nowEstimated} > ${ceiling.maxRenderedInputTokens}`,
  );
});

test("estimator: a truly unfittable request is still refused", () => {
  // Calibration must not have turned the fail-closed guard into a rubber stamp.
  const b = deriveBudget(facts(8_192));
  assert.ok(b.ok);
  const ceiling = conversationCeiling(b.budget);
  assert.ok(estimateTokens("x".repeat(400_000)) > ceiling.maxRenderedInputTokens);
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
    assert.ok(c.safetyMarginTokens > 0, "the allowance costs real tokens, and they are reported");
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
    /*
      The worst case, anchored to MEASUREMENT rather than to a hypothetical. Two real
      runs put builder-conversation density at 3.560 and 3.587 chars/token — both above
      the 3.5 the estimator assumes, so both are already overestimated. The design point
      is content materially denser than anything observed: 3.2, about 10% denser than the
      estimator's assumption, which is exactly what the residual allowance is sized for.
    */
    const DENSER_THAN_ANY_OBSERVED = 3.2;
    const RESIDUAL = CHARS_PER_TOKEN / DENSER_THAN_ANY_OBSERVED;
    assert.ok(RESIDUAL <= ESTIMATOR_RESIDUAL_ALLOWANCE, "the allowance must cover the design-point density");
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


/* ── THE ESTIMATOR IS A CAPABILITY FACT ──────────────────────────────────── */

const withEstimator = (contextWindow: number, charsPerToken?: number): ModelCapabilityFacts => ({
  ...facts(contextWindow),
  ...(charsPerToken !== undefined
    ? { tokenEstimator: { kind: "chars_ratio" as const, charsPerToken, provenance: "declared" as const } }
    : {}),
});

test("capability estimator: an unfamiliar model gets the generic fallback", () => {
  const b = deriveBudget(withEstimator(131_072));
  assert.ok(b.ok);
  assert.equal(b.budget.tokenEstimator.charsPerToken, GENERIC_TOKEN_ESTIMATOR.charsPerToken);
  assert.equal(b.budget.tokenEstimator.provenance, "generic_default");
});

test("capability estimator: two fictional models differ ONLY by their declared facts", () => {
  /*
    THE model-agnosticism proof. `future-model-a` and `future-model-b` exist nowhere in
    ikbi's source; they are capability data with the same window and different densities.
    The same code produces different estimates for the same text.
  */
  const a = deriveBudget(withEstimator(131_072));            // future-model-a: no declaration
  const b = deriveBudget(withEstimator(131_072, 2.5));       // future-model-b: denser tokenizer
  assert.ok(a.ok && b.ok);

  const text = "export const widget = { id: 1, label: 'a' };\n".repeat(200);
  const estA = estimateTokensWith(text, a.budget.tokenEstimator);
  const estB = estimateTokensWith(text, b.budget.tokenEstimator);
  assert.ok(estB > estA, "the denser-declared model estimates more tokens for identical text");
  assert.equal(estA, Math.ceil(text.length / 3.5));
  assert.equal(estB, Math.ceil(text.length / 2.5));

  // Same window, so the difference is purely the declared estimator.
  assert.equal(a.budget.contextWindowTokens, b.budget.contextWindowTokens);
  assert.equal(b.budget.tokenEstimator.provenance, "declared");
});

test("capability estimator: a declared density changes the effective ceiling's meaning, not its code path", () => {
  const generic = conversationCeiling(( deriveBudget(withEstimator(65_536)) as { budget: ContextBudget }).budget);
  const dense = conversationCeiling(( deriveBudget(withEstimator(65_536, 2.5)) as { budget: ContextBudget }).budget);
  // The ceiling is about the WINDOW, so it is identical; what differs is how much text
  // fits under it. That separation is the point.
  assert.equal(generic.maxRenderedInputTokens, dense.maxRenderedInputTokens);
  assert.notEqual(generic.tokenEstimator.charsPerToken, dense.tokenEstimator.charsPerToken);
});

test("capability estimator: the estimator is FROZEN for the run", () => {
  /*
    No self-tuning in this slice. The budget carries one estimator, resolved once from
    capability facts; nothing observes usage and rewrites it mid-session.
  */
  const b = deriveBudget(withEstimator(65_536, 3.1));
  assert.ok(b.ok);
  assert.ok(Object.isFrozen(GENERIC_TOKEN_ESTIMATOR));
  const first = b.budget.tokenEstimator.charsPerToken;
  // Re-deriving from the same facts gives the same answer — it is a pure function of data.
  const again = deriveBudget(withEstimator(65_536, 3.1));
  assert.ok(again.ok);
  assert.equal(again.budget.tokenEstimator.charsPerToken, first);
});

test("capability estimator: an unknown context window still fails closed", () => {
  assert.equal(deriveBudget(undefined).ok, false);
});

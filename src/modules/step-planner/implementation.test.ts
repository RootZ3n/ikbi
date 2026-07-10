import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decompose, decomposeWithModel, decomposeAdaptive, complexityScore, maskCodeSpans } from "./implementation.js";
import { COMPLEX_THRESHOLD } from "./config.js";

describe("step-planner", () => {
  describe("complexityScore", () => {
    it("returns 0 for simple goals", () => {
      assert.equal(complexityScore("Fix the typo in README.md"), 0);
      assert.equal(complexityScore("Add a LICENSE file"), 0);
    });

    it("returns >0 for complex goals", () => {
      const score = complexityScore("Add auth middleware and add tests and update the README");
      assert.ok(score >= COMPLEX_THRESHOLD, `score ${score} should be >= ${COMPLEX_THRESHOLD}`);
    });

    it("detects numbered lists", () => {
      const score = complexityScore("1. Add function\n2. Add test\n3. Update docs");
      assert.ok(score >= 1);
    });

    it("detects 'then' chains", () => {
      const score = complexityScore("First read the file, then modify it, finally run tests");
      assert.ok(score >= 1);
    });
  });

  describe("decompose", () => {
    it("returns a single step for simple goals", () => {
      const plan = decompose("Fix the typo in README.md");
      assert.equal(plan.decomposed, false);
      assert.equal(plan.steps.length, 1);
      const step = plan.steps[0];
      assert.ok(step);
      assert.equal(step.index, 1);
      assert.equal(step.goal, "Fix the typo in README.md");
      assert.equal(plan.source, "heuristic");
    });

    it("splits on 'and' for complex goals", () => {
      const plan = decompose(
        "Add a health endpoint to src/server.ts and add a test for it in tests/health.test.ts and update the README",
      );
      assert.equal(plan.decomposed, true);
      assert.ok(plan.steps.length >= 2, `expected >= 2 steps, got ${plan.steps.length}`);
      const first = plan.steps[0];
      assert.ok(first);
      assert.equal(first.index, 1);
      for (let i = 0; i < plan.steps.length; i++) {
        const s = plan.steps[i];
        assert.ok(s);
        assert.equal(s.index, i + 1);
      }
    });

    it("splits on numbered lists", () => {
      const plan = decompose("1. Add function X\n2. Add test for X\n3. Update docs");
      assert.equal(plan.decomposed, true);
      assert.equal(plan.steps.length, 3);
      const s0 = plan.steps[0];
      const s1 = plan.steps[1];
      const s2 = plan.steps[2];
      assert.ok(s0 && s1 && s2);
      assert.equal(s0.goal, "Add function X");
      assert.equal(s1.goal, "Add test for X");
      assert.equal(s2.goal, "Update docs");
    });

    it("splits on semicolons", () => {
      const plan = decompose(
        "Add function X to src/a.ts; Add test for X in tests/a.test.ts; Update README with usage",
      );
      assert.equal(plan.decomposed, true);
      assert.ok(plan.steps.length >= 2);
    });

    it("extracts target files from goals", () => {
      const plan = decompose("Add function X to src/server.ts and add test in tests/server.test.ts");
      if (plan.decomposed) {
        const step1 = plan.steps[0];
        assert.ok(step1);
        const step1Files = step1.targetFiles ?? [];
        assert.ok(step1Files.some((f) => f.includes("server.ts")), `step 1 should target server.ts`);
      }
    });

    it("adds verification hint to the last step", () => {
      const plan = decompose("Add X and add Y and add Z");
      if (plan.decomposed) {
        const last = plan.steps[plan.steps.length - 1];
        assert.ok(last);
        assert.ok(last.verificationHint !== undefined, "last step should have verification hint");
      }
    });

    it("caps at MAX_STEPS", () => {
      const goal = Array.from({ length: 20 }, (_, i) => `${i + 1}. Step ${i + 1}`).join("\n");
      const plan = decompose(goal);
      assert.ok(plan.steps.length <= 10, `expected <= 10 steps, got ${plan.steps.length}`);
    });

    // ── OVER-TRIGGER REGRESSION (Issue 2): a verbose SINGLE task is not spuriously split ──

    it("does NOT decompose a verbose single-task goal that merely contains 'and' twice", () => {
      // One conceptual task (refactor the auth module) described verbosely. It trips the loose
      // `/\band\b.*\band\b/` complexity indicator, but the later clauses are continuations, not
      // independent tasks — so it must NOT be decomposed into spurious steps.
      const goal =
        "Refactor the authentication module so that it correctly validates incoming tokens " +
        "and gracefully handles sessions that have already expired " +
        "and clearly surfaces a helpful error message to the caller";
      // Sanity: the loose indicator DOES fire (this is the over-trigger we are guarding against).
      assert.ok(complexityScore(goal) >= 1, "the loose 'and...and' indicator still matches");
      const plan = decompose(goal);
      assert.equal(plan.decomposed, false, "a verbose single task is not split into steps");
      assert.equal(plan.steps.length, 1, "stays a single step");
      assert.equal(plan.steps[0]?.goal, goal, "the original goal is preserved unchanged");
    });

    it("does NOT decompose a LONG (40+ word) single-task goal with multiple 'and's but no sentence boundaries", () => {
      // The Codex Issue-2 case: a verbose SINGLE task that is well OVER MIN_MULTITASK_WORDS.
      // A pure word-count gate would have split it; the fix requires ≥2 action-led clauses when
      // there is no semicolon / numbered list / sequencer word. Only the first clause is
      // action-led ("Refactor ..."); the rest are continuations ("checks ...", "handles ...",
      // "returns ..."), so it must stay a single step despite its length.
      const goal =
        "Refactor the authentication middleware so that it validates the incoming bearer token " +
        "and checks the expiry timestamp against the server clock " +
        "and gracefully handles malformed authorization headers " +
        "and returns a clear and descriptive error message to the calling client " +
        "while preserving the existing request logging behavior across every protected route";
      const wordCount = goal.trim().split(/\s+/).filter(Boolean).length;
      assert.ok(wordCount >= 40, `the goal is genuinely long (${wordCount} words), defeating a pure word-count gate`);
      assert.ok(complexityScore(goal) >= 1, "the loose 'and...and' indicator still matches");
      const plan = decompose(goal);
      assert.equal(plan.decomposed, false, "length alone does not authorize a split without a sentence boundary");
      assert.equal(plan.steps.length, 1, "stays a single step");
      assert.equal(plan.steps[0]?.goal, goal, "the original goal is preserved unchanged");
    });

    it("STILL decomposes a genuine multi-task goal where each clause is an action-led task", () => {
      // Positive control: short, but each "and" clause opens with an imperative action verb —
      // genuinely independent tasks. The guard must let this through.
      const plan = decompose("Add a logout button and update the navbar styles and write a test for it");
      assert.equal(plan.decomposed, true, "action-led clauses are a real decomposition");
      assert.ok(plan.steps.length >= 2);
    });

    // ── CODE-LITERAL REGRESSION: a single-imperative goal that carries TS syntax must NOT split ──

    it("does NOT decompose a single-imperative goal whose prose carries TypeScript literals", () => {
      // The Bokahli-pilot case: ONE task (add a module), but the goal quotes a return type with
      // semicolons `{ insideLine: boolean; score: number; reasons: string[] }` and a union
      // `('deterministic' | 'partial' | 'none')`. Before the fix the in-code `;` tripped
      // `hasStrongSeparator`, authorizing an "and"-split into ~6 spurious fragments. It must now
      // stay a single step: only the opening clause is action-led ("Add ..."), the rest describe
      // parts of the same deliverable.
      const goal =
        "Add a pure deterministic envelope classifier in src/envelope.ts: export an EnvelopeInput " +
        "interface with fields taskShape ('single-function' | 'multi-function' | 'cross-module'), " +
        "specClarity (number 0..1), filesChanged (number), contextTokens (number), and verifiability " +
        "('deterministic' | 'partial' | 'none'); and export function envelope(input: EnvelopeInput): " +
        "{ insideLine: boolean; score: number; reasons: string[] } that scores whether the task fits " +
        "a small model's proven envelope and returns read-only reasons with no mutation";
      const plan = decompose(goal);
      assert.equal(plan.decomposed, false, "a code-carrying single task must not fragment");
      assert.equal(plan.steps.length, 1, "stays a single step");
      assert.equal(plan.steps[0]?.goal, goal, "the original goal is preserved unchanged");
    });

    it("STILL decomposes a semicolon-delimited goal when each clause is action-led", () => {
      // Positive control: semicolons are no longer a STRONG separator on their own, but a genuine
      // multi-task list whose clauses each open with an action verb must still split (rescued by
      // the action-led-clause count, not by the semicolons themselves).
      const plan = decompose(
        "Add function X to src/a.ts; add a test for X in tests/a.test.ts; update the README with usage",
      );
      assert.equal(plan.decomposed, true, "action-led semicolon clauses are a real decomposition");
      assert.ok(plan.steps.length >= 2);
    });

    it("does NOT decompose a single-imperative goal that describes an API method whose name is an action verb", () => {
      // Real Bokahli-pilot case: ONE task (add an adapter), but its prose describes a `generate(...)`
      // method — "generate" is both the method name AND an imperative verb. Before the fix, the
      // "generate(prompt, options) does POST ..." clause counted as a second action-led task alongside
      // "Add ...", authorizing a spurious 6-way split. A `verb(` function-call form must NOT count.
      const goal =
        "Add an Ollama model adapter in src/ollama.ts that implements ModelAdapter: export " +
        "createOllamaAdapter(opts) with a host and an injectable fetch, where listModels() does GET " +
        "{host}/api/tags and maps the response to ModelInfo and generate(prompt, options) does POST " +
        "{host}/api/generate with body { model, prompt, stream: false } and returns the parsed response";
      const plan = decompose(goal);
      assert.equal(plan.decomposed, false, "an API description with a verb-named method is one task");
      assert.equal(plan.steps.length, 1, "stays a single step");
      assert.equal(plan.steps[0]?.goal, goal, "the original goal is preserved unchanged");
    });

    it("regroups a multi-file goal so each step is a COMPLETE action-led task (no mid-task fragments)", () => {
      // Real Bokahli multi-file case that fragmented into 5 steps (2 of them fragments — "exports a
      // function greet(...)" and "capitalized name,") and was then discarded by the whole-build
      // critic. The goal has THREE genuine tasks (Add greeter / add names / write tests); the intra-
      // task "and"s ("imports X and exports Y", "trimmed and capitalized") must NOT open new steps.
      const goal =
        "Add a src/greeter.ts module that imports formatName from ./names.js and exports a function " +
        "greet(name: string): string returning a greeting, and add a src/names.ts module that exports " +
        "function formatName(raw: string): string returning a trimmed and capitalized name, and write " +
        "node:test files for both modules";
      const plan = decompose(goal);
      assert.equal(plan.decomposed, true, "three genuine action-led tasks → a real decomposition");
      assert.equal(plan.steps.length, 3, "exactly three coherent steps, not five fragments");
      // Every step must OPEN with an imperative action verb — proof no fragment leads a step.
      for (const s of plan.steps) {
        assert.match(s.goal, /^(?:add|write)\b/i, `step must start with an action verb: "${s.goal.slice(0, 40)}"`);
      }
      // The greeter step keeps its "exports greet()" continuation; the names step keeps "capitalized".
      assert.match(plan.steps[0]?.goal ?? "", /greeter\.ts.*exports a function greet/is, "greeter task stays whole");
      assert.match(plan.steps[1]?.goal ?? "", /names\.ts.*capitalized name/is, "names task stays whole");
    });

    it("does NOT fragment a single-task goal whose prose has an incidental sequencer + 'and's", () => {
      // Real Bokahli case: ONE task (add session.ts + its test) that decomposed into 6 stuck
      // fragments. Its prose contains a ", then" sequencer (authorizing a split attempt) and several
      // intra-task "and"s, but only "Add" is action-led — so grouping collapses to one task. That
      // must yield a SINGLE step of the whole goal, NOT the raw fragments (the old fallback bug).
      const goal =
        "Add a session orchestrator in src/session.ts that imports decideAttempt from ./gate.js and " +
        "runBuild from ./build.js: export async function runSession(adapter, input) that first calls " +
        "decideAttempt(input); when it declines it returns attempted false and never calls the adapter, " +
        "otherwise it awaits runBuild to generate the code, then measureRun to produce the report, and " +
        "returns attempted true with the code and report";
      const plan = decompose(goal);
      assert.equal(plan.decomposed, false, "one action-led task → a single cohesive step");
      assert.equal(plan.steps.length, 1, "not fragmented into sub-steps");
      assert.equal(plan.steps[0]?.goal, goal, "the whole goal is built in one pass");
    });

    it("STILL counts a real imperative verb followed by an object (not a paren) as action-led", () => {
      // Guard the fix's boundary: "generate a report" (verb + object) is a genuine task opener and
      // must still count, so a legitimately multi-task goal is not accidentally suppressed.
      const plan = decompose("Add a config loader and generate a default config file and write a test");
      assert.equal(plan.decomposed, true, "verb+object clauses are still real independent tasks");
      assert.ok(plan.steps.length >= 2);
    });

    it("does NOT split on a semicolon that lives inside a type literal", () => {
      // A single task whose ONLY semicolons are inside a `{ ... }` type — masking removes them, so
      // there is no separator at all and the goal passes through untouched.
      const goal = "Update the parse() signature in src/parse.ts to return { ok: boolean; value: string }";
      const plan = decompose(goal);
      assert.equal(plan.decomposed, false, "in-type semicolons are not task separators");
      assert.equal(plan.steps.length, 1);
      assert.equal(plan.steps[0]?.goal, goal);
    });
  });

  describe("maskCodeSpans", () => {
    it("is length-preserving and blanks code-span interiors while keeping delimiters", () => {
      const input = "f(a; b) and g[x, y] and `co;de`";
      const masked = maskCodeSpans(input);
      assert.equal(masked.length, input.length, "same UTF-16 length so indices map back to the original");
      // Brackets/backticks themselves stay; their interiors become spaces (no `;` or `,` survive).
      assert.equal(masked.includes(";"), false, "in-code semicolons are masked away");
      assert.equal(masked.includes(","), false, "in-code commas are masked away");
      assert.ok(masked.includes(" and "), "prose between code spans is untouched");
      assert.ok(masked.startsWith("f("), "opening delimiter is preserved");
    });

    it("leaves a goal with no code spans unchanged", () => {
      const plain = "Add X and add Y; then update Z";
      assert.equal(maskCodeSpans(plain), plain);
    });
  });

  describe("decomposeWithModel", () => {
    it("uses model output when valid", async () => {
      const mockModel = async () =>
        JSON.stringify([
          { goal: "Add function X", targetFiles: ["src/x.ts"] },
          { goal: "Add test for X", targetFiles: ["tests/x.test.ts"] },
        ]);
      const plan = await decomposeWithModel("Complex task", mockModel);
      assert.equal(plan.source, "model");
      assert.equal(plan.decomposed, true);
      assert.equal(plan.steps.length, 2);
      const s0 = plan.steps[0];
      assert.ok(s0);
      assert.equal(s0.goal, "Add function X");
    });

    it("reports droppedSteps when the model plan exceeds MAX_STEPS (Codex M6)", async () => {
      const many = Array.from({ length: 12 }, (_, i) => ({ goal: `Step ${i + 1}`, targetFiles: [`src/f${i}.ts`] }));
      const plan = await decomposeWithModel("Complex task", async () => JSON.stringify(many));
      assert.equal(plan.source, "model");
      assert.equal(plan.steps.length, 10, "capped at MAX_STEPS");
      assert.equal(plan.droppedSteps, 2, "the 2 dropped steps are reported, not silently discarded");
    });

    it("falls back to heuristic when model returns invalid JSON", async () => {
      const mockModel = async () => "I can't decompose this";
      const plan = await decomposeWithModel("Simple fix", mockModel);
      assert.equal(plan.source, "heuristic");
    });

    it("falls back to heuristic when model returns single step", async () => {
      const mockModel = async () => JSON.stringify([{ goal: "Do everything" }]);
      const plan = await decomposeWithModel("Complex task", mockModel);
      assert.equal(plan.source, "heuristic");
    });

    it("falls back to heuristic when model call throws", async () => {
      const mockModel = async () => {
        throw new Error("model failed");
      };
      const plan = await decomposeWithModel("Complex task", mockModel);
      assert.equal(plan.source, "heuristic");
    });

    it("wraps model output in markdown code blocks", async () => {
      const mockModel = async () =>
        '```json\n[{"goal": "Step 1", "targetFiles": ["a.ts"]}, {"goal": "Step 2", "targetFiles": ["b.ts"]}]\n```';
      const plan = await decomposeWithModel("Complex task", mockModel);
      assert.equal(plan.source, "model");
      assert.equal(plan.steps.length, 2);
    });

    // ── OPT-IN in production: the model strategy is now reachable via decomposeAdaptive behind a flag ──
    it("is wired via decomposeAdaptive behind IKBI_STEP_PLANNER_MODEL — never called directly, zero-cost by default", () => {
      // The `ikbi build` CLI now uses `decomposeAdaptive` (which calls the model strategy only when
      // the operator opts in AND the heuristic is uncertain); it still never calls `decomposeWithModel`
      // DIRECTLY. This pins the new contract: opt-in, gated, heuristic-first.
      const cliSource = readFileSync(new URL("../worker-model/cli.ts", import.meta.url), "utf8");
      assert.equal(cliSource.includes("decomposeWithModel("), false, "cli.ts calls the adaptive wrapper, not decomposeWithModel directly");
      assert.ok(cliSource.includes("decomposeAdaptive("), "cli.ts uses the adaptive planner");
      assert.ok(cliSource.includes("IKBI_STEP_PLANNER_MODEL"), "the model second pass is gated behind the opt-in flag");
    });
  });

  describe("decomposeAdaptive", () => {
    it("with NO invoker is byte-identical to the heuristic (zero-cost default)", async () => {
      const goal = "Add a function to src/foo.ts, then add a test, then update the README";
      assert.deepEqual(await decomposeAdaptive(goal), decompose(goal));
    });

    it("does NOT call the model when the heuristic is confident (below the step cap) and forceModel is off", async () => {
      let called = false;
      const invokeModel = async (): Promise<string> => { called = true; return "[]"; };
      const plan = await decomposeAdaptive("Add one function to src/foo.ts", { invokeModel });
      assert.equal(called, false, "a confident, un-saturated heuristic never spends a model call");
      assert.equal(plan.source, "heuristic");
    });

    it("forceModel uses the model plan when it is a strictly richer decomposition", async () => {
      const invokeModel = async (): Promise<string> =>
        JSON.stringify([
          { goal: "Step A", targetFiles: ["a.ts"] },
          { goal: "Step B", targetFiles: ["b.ts"] },
          { goal: "Step C", targetFiles: ["c.ts"] },
        ]);
      const plan = await decomposeAdaptive("do the thing", { invokeModel, forceModel: true });
      assert.equal(plan.source, "model");
      assert.equal(plan.steps.length, 3);
    });

    it("forceModel keeps the heuristic when the model plan is NOT richer (never regress to fewer steps)", async () => {
      const goal = "Add a function to src/foo.ts, then add a test, then update the README, then bump the version";
      const heuristicSteps = decompose(goal).steps.length;
      // Model returns only 2 steps — not richer than the multi-step heuristic → keep heuristic.
      const invokeModel = async (): Promise<string> => JSON.stringify([{ goal: "one" }, { goal: "two" }]);
      const plan = await decomposeAdaptive(goal, { invokeModel, forceModel: true });
      if (heuristicSteps > 2) {
        assert.equal(plan.source, "heuristic", "a model plan with fewer steps than the heuristic is not preferred");
      }
    });

    it("falls back to the heuristic when the forced model call throws", async () => {
      const invokeModel = async (): Promise<string> => { throw new Error("model down"); };
      const plan = await decomposeAdaptive("do the thing", { invokeModel, forceModel: true });
      assert.equal(plan.source, "heuristic");
    });
  });
});

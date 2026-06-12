import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decompose, decomposeWithModel, complexityScore } from "./implementation.js";
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
  });
});

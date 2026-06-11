import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeGoalAmbiguity,
  buildInterviewPlan,
  formatInterview,
  preBuildRefinement,
} from "./goal-refinement.js";

describe("analyzeGoalAmbiguity", () => {
  it("returns low score for a specific goal", () => {
    const result = analyzeGoalAmbiguity("fix the add function in src/math.js — it returns a - b instead of a + b");
    assert.ok(result.score < 0.35, `expected low ambiguity score, got ${result.score}`);
    assert.equal(result.needsInterview, false);
  });

  it("returns high score for a vague goal", () => {
    const result = analyzeGoalAmbiguity("fix it");
    assert.ok(result.score > 0.35, `expected high ambiguity score, got ${result.score}`);
    assert.equal(result.needsInterview, true);
    assert.ok(result.signals.length > 0);
  });

  it("detects vague verbs", () => {
    const result = analyzeGoalAmbiguity("improve the code");
    const vagueVerb = result.signals.find((s) => s.kind === "vague_verb");
    assert.ok(vagueVerb !== undefined, "should detect vague verb 'improve'");
  });

  it("detects no target", () => {
    const result = analyzeGoalAmbiguity("fix the bug");
    const noTarget = result.signals.find((s) => s.kind === "no_target");
    assert.ok(noTarget !== undefined, "should detect no target");
  });

  it("detects broad scope", () => {
    const result = analyzeGoalAmbiguity("make everything better");
    const broad = result.signals.find((s) => s.kind === "broad_scope");
    assert.ok(broad !== undefined, "should detect broad scope");
  });

  it("detects pronouns without antecedent", () => {
    const result = analyzeGoalAmbiguity("fix this");
    const pronoun = result.signals.find((s) => s.kind === "pronoun_without_antecedent");
    assert.ok(pronoun !== undefined, "should detect pronoun without antecedent");
  });

  it("detects missing context", () => {
    const result = analyzeGoalAmbiguity("update the file");
    const missing = result.signals.find((s) => s.kind === "missing_context");
    assert.ok(missing !== undefined, "should detect missing context");
  });

  it("caps score at 1.0", () => {
    const result = analyzeGoalAmbiguity("fix it improve everything make better");
    assert.ok(result.score <= 1.0, `score should be capped at 1.0, got ${result.score}`);
  });

  it("returns needsInterview=true for vague goals", () => {
    assert.equal(analyzeGoalAmbiguity("fix it").needsInterview, true);
    assert.equal(analyzeGoalAmbiguity("improve the code").needsInterview, true);
    assert.equal(analyzeGoalAmbiguity("make everything better").needsInterview, true);
  });

  it("returns needsInterview=false for specific goals", () => {
    assert.equal(analyzeGoalAmbiguity("fix the add function in src/math.js to return a + b instead of a - b").needsInterview, false);
  });
});

describe("buildInterviewPlan", () => {
  it("generates questions from ambiguity signals", () => {
    const analysis = analyzeGoalAmbiguity("fix it");
    const plan = buildInterviewPlan("fix it", analysis);
    assert.ok(plan.questions.length > 0, "should generate at least one question");
  });

  it("includes cognition missingInfo as questions", () => {
    const analysis = analyzeGoalAmbiguity("fix the bug");
    const cognition = {
      decision: "ask" as const,
      confidence: 0.8,
      rationale: "Goal is too vague",
      memoryUsed: [],
      missingInfo: ["Which file has the bug?", "What error are you seeing?"],
    };
    const plan = buildInterviewPlan("fix the bug", analysis, cognition);
    assert.ok(plan.questions.length >= 2, "should include cognition missingInfo questions");
  });

  it("includes risks from cognition", () => {
    const analysis = analyzeGoalAmbiguity("fix the auth");
    const cognition = {
      decision: "warn" as const,
      confidence: 0.6,
      rationale: "Auth changes are risky",
      memoryUsed: [],
      risks: ["Could break login for all users"],
    };
    const plan = buildInterviewPlan("fix the auth", analysis, cognition);
    const riskQ = plan.questions.find((q) => q.id === "confirm_risks");
    assert.ok(riskQ !== undefined, "should include risk confirmation question");
  });

  it("returns empty questions for clear goals", () => {
    const analysis = analyzeGoalAmbiguity("fix the add function in src/math.js to return a + b");
    const plan = buildInterviewPlan("fix the add function in src/math.js to return a + b", analysis);
    assert.equal(plan.questions.length, 0, "should have no questions for clear goals");
  });
});

describe("formatInterview", () => {
  it("formats questions for display", () => {
    const plan = {
      questions: [
        { id: "test", question: "What do you mean?", why: "Too vague", kind: "clarify_action" as const },
      ],
      summary: "Goal needs clarification",
      refinedGoal: "fix it",
    };
    const output = formatInterview(plan);
    assert.ok(output.includes("Goal Refinement"), "should include header");
    assert.ok(output.includes("What do you mean?"), "should include question");
  });

  it("formats clear goal as no questions needed", () => {
    const plan = {
      questions: [],
      summary: "Goal looks clear",
      refinedGoal: "fix the add function",
    };
    const output = formatInterview(plan);
    assert.ok(output.includes("clear enough"), "should indicate goal is clear");
  });
});

describe("preBuildRefinement", () => {
  it("returns proceed=true for clear goals", () => {
    const result = preBuildRefinement("fix the add function in src/math.js to return a + b");
    assert.equal(result.proceed, true);
  });

  it("returns proceed=false for vague goals", () => {
    const result = preBuildRefinement("fix it");
    assert.equal(result.proceed, false);
    assert.ok(result.interview !== undefined, "should have interview");
  });

  it("returns proceed=false when cognition says ask", () => {
    const cognition = {
      decision: "ask" as const,
      confidence: 0.9,
      rationale: "Need more info",
      memoryUsed: [],
      missingInfo: ["Which file?"],
    };
    const result = preBuildRefinement("fix the bug", cognition);
    assert.equal(result.proceed, false);
  });

  it("returns proceed=false when cognition says reject", () => {
    const cognition = {
      decision: "reject" as const,
      confidence: 1.0,
      rationale: "Goal is unsafe",
      memoryUsed: [],
    };
    const result = preBuildRefinement("rm -rf everything", cognition);
    assert.equal(result.proceed, false);
  });

  it("returns proceed=true with warning when cognition says warn", () => {
    const cognition = {
      decision: "warn" as const,
      confidence: 0.7,
      rationale: "Risky area",
      memoryUsed: [],
      risks: ["Could break auth"],
    };
    const result = preBuildRefinement("fix the auth module", cognition);
    assert.equal(result.proceed, true);
    assert.ok(result.interview?.summary.startsWith("Warning:"), "should have warning summary");
  });

  it("handles undefined cognition gracefully", () => {
    const result = preBuildRefinement("fix the add function in src/math.js");
    assert.equal(result.proceed, true);
  });
});

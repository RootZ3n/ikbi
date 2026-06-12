import assert from "node:assert/strict";
import { test } from "node:test";

import type { RoleResult } from "./contract.js";
import { formatCriticFixGoal, isRetryableCriticFail, runCriticFixLoop } from "./critic-fix-loop.js";

// A critic FAIL verdict the loop should act on (a critique that RAN and rejected the work).
function criticFail(feedback: string, issues: string[] = []): RoleResult {
  return {
    role: "critic",
    outcome: "success", // the critique RAN — the verdict is in detail.pass
    summary: "critique verdict: FAIL",
    detail: { pass: false, feedback, ...(issues.length > 0 ? { issues } : {}) },
  };
}

function criticPass(feedback = "looks good"): RoleResult {
  return { role: "critic", outcome: "success", summary: "critique verdict: PASS", detail: { pass: true, feedback } };
}

function builderOk(files: string[]): RoleResult {
  return { role: "builder", outcome: "success", summary: "built", detail: { filesWritten: files, rejectedToolCalls: [] } };
}

function verifierPass(): RoleResult {
  return { role: "verifier", outcome: "success", summary: "green", detail: { verdict: "pass", checks: [] } };
}

test("formatCriticFixGoal embeds the critic feedback and each specific issue", () => {
  const goal = formatCriticFixGoal("the /auth route never checks the token", ["missing import of verifyJwt", "no test for the 401 path"]);
  assert.match(goal, /critic REJECTED/i);
  assert.match(goal, /never checks the token/);
  assert.match(goal, /1\. missing import of verifyJwt/);
  assert.match(goal, /2\. no test for the 401 path/);
});

test("isRetryableCriticFail: a model FAIL is retryable; PASS and objective fail-closed are NOT", () => {
  assert.equal(isRetryableCriticFail(criticFail("nope")), true);
  assert.equal(isRetryableCriticFail(criticPass()), false);
  // Objective fail-closed gates (empty diff, missing files, unparseable) are not actionable feedback.
  assert.equal(
    isRetryableCriticFail({ role: "critic", outcome: "success", summary: "FAIL", detail: { pass: false, objectiveFailure: true, feedback: "empty diff" } }),
    false,
  );
  // An infrastructure failure (model down) is not a verdict to retry on.
  assert.equal(isRetryableCriticFail({ role: "critic", outcome: "failure", summary: "provider down" }), false);
});

test("Issue 1: a critic FAIL drives a builder retry with the feedback, then re-critique PASSes", async () => {
  // The builder's FIRST attempt planted an issue; the critic caught it and returned FAIL with
  // actionable feedback. The retry must receive that feedback as its goal and produce better code.
  const planted = criticFail("the handler returns 500 because `db` is used before import", ["add `import { db } from './db'`"]);

  let builderGoalSeen: string | undefined;
  let builderCalls = 0;
  let verifierCalls = 0;
  let criticCalls = 0;

  const outcome = await runCriticFixLoop(planted, {
    builder: async (fixGoal) => {
      builderCalls += 1;
      builderGoalSeen = fixGoal;
      return builderOk(["handler.ts", "db.ts"]); // the improved code
    },
    verifier: async (builderResult) => {
      verifierCalls += 1;
      assert.equal(builderResult.role, "builder", "the verifier receives the fresh builder result");
      return verifierPass();
    },
    critic: async (_builderResult, verifierResult) => {
      criticCalls += 1;
      assert.equal(verifierResult.role, "verifier", "the re-critique sees the fresh verifier result");
      // The second look at the now-fixed code passes.
      return criticPass("import added, handler returns 200");
    },
  });

  assert.equal(outcome.ran, true, "the retry ran");
  assert.equal(builderCalls, 1, "builder retried exactly once");
  assert.equal(verifierCalls, 1, "re-verified once");
  assert.equal(criticCalls, 1, "re-critiqued once");
  // The retry goal carried the critic's feedback AND its specific issue — not a generic 'try again'.
  assert.match(builderGoalSeen ?? "", /used before import/);
  assert.match(builderGoalSeen ?? "", /import \{ db \}/);
  // The final verdict is the RE-critique, which now passes.
  assert.equal((outcome.criticResult.detail as { pass: boolean }).pass, true);
  assert.equal(outcome.builderResult?.outcome, "success");
  assert.equal(outcome.verifierResult?.outcome, "success");
});

test("a PASS verdict is left untouched — no retry, original result returned", async () => {
  let touched = false;
  const original = criticPass();
  const outcome = await runCriticFixLoop(original, {
    builder: async () => { touched = true; return builderOk(["x.ts"]); },
    verifier: async () => { touched = true; return verifierPass(); },
    critic: async () => { touched = true; return criticPass(); },
  });
  assert.equal(outcome.ran, false);
  assert.equal(touched, false, "none of the retry stages ran");
  assert.equal(outcome.criticResult, original, "the original PASS verdict is returned as-is");
});

test("if the retry builder FAILS, the ORIGINAL FAIL verdict stands (fail-closed, no re-critique)", async () => {
  const original = criticFail("broken auth flow");
  let criticRan = false;
  const outcome = await runCriticFixLoop(original, {
    builder: async () => ({ role: "builder", outcome: "failure", summary: "builder hit max iterations" }),
    verifier: async () => verifierPass(),
    critic: async () => { criticRan = true; return criticPass(); },
  });
  assert.equal(outcome.ran, true, "a retry was attempted");
  assert.equal(criticRan, false, "the critic is NOT re-run when the builder could not act on the feedback");
  assert.equal(outcome.criticResult, original, "the original FAIL verdict is preserved → integrator still discards");
  assert.equal(outcome.builderResult?.outcome, "failure");
  assert.equal(outcome.verifierResult, undefined);
});

test("re-critique can STILL fail (the retry did not fix it) — the single-shot cap holds", async () => {
  // The cap is enforced by the orchestrator (criticFixAttempted), but the loop itself never
  // recurses: one builder → one verify → one critique, whatever that second verdict is.
  const original = criticFail("missing null check");
  const outcome = await runCriticFixLoop(original, {
    builder: async () => builderOk(["x.ts"]),
    verifier: async () => verifierPass(),
    critic: async () => criticFail("still missing the null check"),
  });
  assert.equal(outcome.ran, true);
  assert.equal((outcome.criticResult.detail as { pass: boolean }).pass, false, "the second verdict is honored, not retried again");
  assert.match((outcome.criticResult.detail as { feedback: string }).feedback, /still missing/);
});

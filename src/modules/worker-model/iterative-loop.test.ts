/**
 * Tests for the iterative build loop (iterative-loop.ts).
 *
 * Covers: first-try pass, single-fix pass, multi-fix pass, builder failure
 * mid-loop, exhausted iterations, extractVerifierCheckResult, and edge cases.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { RoleResult } from "./contract.js";
import {
  runIterativeLoop,
  extractVerifierCheckResult,
  DEFAULT_MAX_FIX_ITERATIONS,
  type IterativeLoopDeps,
  type VerifierCheckResult,
} from "./iterative-loop.js";

// ── helpers ────────────────────────────────────────────────────────────────────

function okBuildResult(): RoleResult {
  return { role: "builder", outcome: "success", summary: "built ok", detail: { toolRounds: 3, filesWritten: ["a.ts"] } };
}

function failBuildResult(summary = "build failed"): RoleResult {
  return { role: "builder", outcome: "failure", summary };
}

function okVerifier(): VerifierCheckResult {
  return { success: true, errors: "", typecheckPassed: true, testsPassed: true };
}

function failVerifier(errors = "[test] expected 1, got 0"): VerifierCheckResult {
  return { success: false, errors, typecheckPassed: true, testsPassed: false };
}



// ── runIterativeLoop ──────────────────────────────────────────────────────────

test("first-try pass: verifier passes immediately → 0 fix iterations", async () => {
  let builderCalls = 0;
  let verifierCalls = 0;
  const deps: IterativeLoopDeps = {
    verifier: async () => { verifierCalls++; return okVerifier(); },
    builder: async () => { builderCalls++; return okBuildResult(); },
  };

  const outcome = await runIterativeLoop(okBuildResult(), deps);

  assert.equal(outcome.fixIterations, 0, "no fix iterations needed");
  assert.equal(outcome.buildResult.outcome, "success");
  assert.equal(verifierCalls, 1, "verifier called once");
  assert.equal(builderCalls, 0, "builder not called again");
});

test("single fix: verifier fails once then passes → 1 fix iteration", async () => {
  let verifierCalls = 0;
  let builderGoals: string[] = [];
  const deps: IterativeLoopDeps = {
    verifier: async () => {
      verifierCalls++;
      return verifierCalls === 1 ? failVerifier() : okVerifier();
    },
    builder: async (goal) => {
      builderGoals.push(goal);
      return okBuildResult();
    },
  };

  const outcome = await runIterativeLoop(okBuildResult(), deps);

  assert.equal(outcome.fixIterations, 1, "one fix iteration");
  assert.equal(outcome.buildResult.outcome, "success");
  assert.equal(verifierCalls, 2, "verifier called twice (fail + pass)");
  assert.equal(builderGoals.length, 1, "builder called once for fix");
  assert.match(builderGoals[0]!, /Fix them/, "fix goal contains error output");
  assert.match(builderGoals[0]!, /expected 1, got 0/, "fix goal contains the actual errors");
});

test("multi-fix: verifier fails twice then passes → 2 fix iterations", async () => {
  let verifierCalls = 0;
  const deps: IterativeLoopDeps = {
    verifier: async () => {
      verifierCalls++;
      return verifierCalls <= 2 ? failVerifier() : okVerifier();
    },
    builder: async () => okBuildResult(),
  };

  const outcome = await runIterativeLoop(okBuildResult(), deps);

  assert.equal(outcome.fixIterations, 2);
  assert.equal(outcome.buildResult.outcome, "success");
  assert.equal(verifierCalls, 3, "verifier called 3 times");
});

test("builder failure mid-loop: builder fails on fix attempt → returns builder failure", async () => {
  let verifierCalls = 0;
  let builderCalls = 0;
  const deps: IterativeLoopDeps = {
    verifier: async () => { verifierCalls++; return failVerifier(); },
    builder: async () => {
      builderCalls++;
      return builderCalls === 1 ? okBuildResult() : failBuildResult("fix build failed");
    },
  };

  const outcome = await runIterativeLoop(okBuildResult(), deps);

  assert.equal(outcome.buildResult.outcome, "failure");
  assert.equal(outcome.buildResult.summary, "fix build failed");
  assert.equal(outcome.fixIterations, 2, "one initial verify + one fix attempt");
});

test("exhausted iterations: all fix attempts fail verification → returns exhausted failure", async () => {
  const deps: IterativeLoopDeps = {
    maxFixIterations: 2,
    verifier: async () => failVerifier("[test] still broken"),
    builder: async () => okBuildResult(),
  };

  const outcome = await runIterativeLoop(okBuildResult(), deps);

  assert.equal(outcome.buildResult.outcome, "failure");
  assert.equal(outcome.fixIterations, 2);
  assert.match(outcome.buildResult.summary!, /still failing after 2 fix iteration/);
  const detail = outcome.buildResult.detail as Record<string, unknown>;
  assert.equal(detail.stopReason, "fix_iterations_exhausted");
  assert.equal(detail.fixIterations, 2);
  assert.match(String(detail.lastErrors), /still broken/);
});

test("exhausted iterations with final-try pass: last verify passes → success", async () => {
  let verifierCalls = 0;
  const deps: IterativeLoopDeps = {
    maxFixIterations: 2,
    verifier: async () => {
      verifierCalls++;
      // Fail for iterations 1-2, pass on the final verify (iteration 3)
      return verifierCalls <= 2 ? failVerifier() : okVerifier();
    },
    builder: async () => okBuildResult(),
  };

  const outcome = await runIterativeLoop(okBuildResult(), deps);

  assert.equal(outcome.buildResult.outcome, "success", "final verify passed");
  assert.equal(outcome.fixIterations, 2, "exhausted iterations but final verify passed");
});

test("custom maxFixIterations is honored", async () => {
  let verifierCalls = 0;
  const deps: IterativeLoopDeps = {
    maxFixIterations: 1,
    verifier: async () => { verifierCalls++; return failVerifier(); },
    builder: async () => okBuildResult(),
  };

  const outcome = await runIterativeLoop(okBuildResult(), deps);

  assert.equal(outcome.fixIterations, 1);
  // 1 (in-loop verify) + 1 (final verify after exhaustion) = 2
  assert.equal(verifierCalls, 2, "verifier called maxIterations + 1 (final) times");
});

test("default maxFixIterations is 3", async () => {
  assert.equal(DEFAULT_MAX_FIX_ITERATIONS, 3);
});

test("lastVerifierResult is populated after fix loop runs", async () => {
  const deps: IterativeLoopDeps = {
    verifier: async () => failVerifier("[test] bad output"),
    builder: async () => okBuildResult(),
  };

  const outcome = await runIterativeLoop(okBuildResult(), deps);

  assert.ok(outcome.lastVerifierResult, "lastVerifierResult is set");
  assert.equal(outcome.lastVerifierResult.success, false);
  assert.match(outcome.lastVerifierResult.errors, /bad output/);
});

test("lastVerifierResult is populated on first-try pass", async () => {
  const deps: IterativeLoopDeps = {
    verifier: async () => okVerifier(),
    builder: async () => okBuildResult(),
  };

  const outcome = await runIterativeLoop(okBuildResult(), deps);

  assert.ok(outcome.lastVerifierResult, "lastVerifierResult is set on first-try pass");
  assert.equal(outcome.lastVerifierResult.success, true);
});

test("fix goal includes verifier errors verbatim", async () => {
  const errors = "[typecheck] src/foo.ts:10 - Property 'bar' does not exist on type 'Foo'\n[test] AssertionError: expected 42, got 0";
  let capturedGoal = "";
  const deps: IterativeLoopDeps = {
    verifier: async () => ({ success: false, errors, typecheckPassed: false, testsPassed: false }),
    builder: async (goal) => { capturedGoal = goal; return okBuildResult(); },
  };

  await runIterativeLoop(okBuildResult(), deps);

  assert.match(capturedGoal, /Property 'bar' does not exist/);
  assert.match(capturedGoal, /AssertionError: expected 42, got 0/);
});

test("preserves initial build result detail on first-try pass", async () => {
  const initial = okBuildResult();
  const deps: IterativeLoopDeps = {
    verifier: async () => okVerifier(),
    builder: async () => okBuildResult(),
  };

  const outcome = await runIterativeLoop(initial, deps);

  assert.equal(outcome.buildResult, initial, "returns the exact initial build result object");
  assert.deepEqual(outcome.buildResult.detail, { toolRounds: 3, filesWritten: ["a.ts"] });
});

// ── extractVerifierCheckResult ─────────────────────────────────────────────────

test("extractVerifierCheckResult: success with all checks passing", () => {
  const vResult: RoleResult = {
    role: "verifier",
    outcome: "success",
    summary: "all checks passed",
    detail: {
      verdict: "pass",
      checks: [
        { name: "typecheck", command: "pnpm tsc --noEmit", exitCode: 0, outputTail: "" },
        { name: "test", command: "pnpm test", exitCode: 0, outputTail: "# pass 42\n" },
      ],
    },
  };

  const result = extractVerifierCheckResult(vResult);

  assert.equal(result.success, true);
  assert.equal(result.typecheckPassed, true);
  assert.equal(result.testsPassed, true);
  assert.equal(result.errors, "");
});

test("extractVerifierCheckResult: failure with test errors", () => {
  const vResult: RoleResult = {
    role: "verifier",
    outcome: "failure",
    summary: "checks failed: test",
    detail: {
      verdict: "fail",
      checks: [
        { name: "typecheck", command: "pnpm tsc --noEmit", exitCode: 0, outputTail: "" },
        { name: "test", command: "pnpm test", exitCode: 1, outputTail: "FAIL src/a.test.ts\nAssertionError: expected 1, got 0" },
      ],
    },
  };

  const result = extractVerifierCheckResult(vResult);

  assert.equal(result.success, false);
  assert.equal(result.typecheckPassed, true);
  assert.equal(result.testsPassed, false);
  assert.match(result.errors, /AssertionError: expected 1, got 0/);
  assert.match(result.errors, /\[test\]/);
});

test("extractVerifierCheckResult: failure with typecheck errors", () => {
  const vResult: RoleResult = {
    role: "verifier",
    outcome: "failure",
    summary: "checks failed: typecheck",
    detail: {
      verdict: "fail",
      checks: [
        { name: "typecheck", command: "pnpm tsc --noEmit", exitCode: 1, outputTail: "src/a.ts:5 - error TS2322" },
        { name: "test", command: "pnpm test", exitCode: 0, outputTail: "" },
      ],
    },
  };

  const result = extractVerifierCheckResult(vResult);

  assert.equal(result.success, false);
  assert.equal(result.typecheckPassed, false);
  assert.equal(result.testsPassed, true);
  assert.match(result.errors, /TS2322/);
});

test("extractVerifierCheckResult: failure with no checks (e.g. script mutation)", () => {
  const vResult: RoleResult = {
    role: "verifier",
    outcome: "failure",
    summary: "verification untrusted: builder modified package.json scripts",
  };

  const result = extractVerifierCheckResult(vResult);

  assert.equal(result.success, false);
  assert.equal(result.typecheckPassed, false);
  assert.equal(result.testsPassed, false);
  assert.equal(result.errors, "verification untrusted: builder modified package.json scripts");
});

test("extractVerifierCheckResult: failure with empty checks array", () => {
  const vResult: RoleResult = {
    role: "verifier",
    outcome: "failure",
    summary: "no checks ran",
    detail: { verdict: "fail", checks: [] },
  };

  const result = extractVerifierCheckResult(vResult);

  assert.equal(result.success, false);
  assert.equal(result.errors, "no checks ran");
});

test("extractVerifierCheckResult: failure with undefined detail", () => {
  const vResult: RoleResult = {
    role: "verifier",
    outcome: "failure",
    summary: "some error",
  };

  const result = extractVerifierCheckResult(vResult);

  assert.equal(result.success, false);
  assert.equal(result.errors, "some error");
  assert.equal(result.typecheckPassed, false);
  assert.equal(result.testsPassed, false);
});

test("extractVerifierCheckResult: combines errors from multiple failed checks", () => {
  const vResult: RoleResult = {
    role: "verifier",
    outcome: "failure",
    summary: "checks failed: typecheck, test",
    detail: {
      verdict: "fail",
      checks: [
        { name: "typecheck", command: "pnpm tsc --noEmit", exitCode: 1, outputTail: "TS2322 error" },
        { name: "test", command: "pnpm test", exitCode: 1, outputTail: "FAIL test.ts" },
      ],
    },
  };

  const result = extractVerifierCheckResult(vResult);

  assert.equal(result.success, false);
  assert.match(result.errors, /\[typecheck\].*TS2322/);
  assert.match(result.errors, /\[test\].*FAIL test\.ts/);
});

/**
 * H9 — ZERO-TEST DETECTION ON A TRUNCATED TAIL.
 *
 * A test runner can emit its "# tests 0" / "# pass 0" markers EARLY, then flood the stream with
 * verbose passing output. governed-exec keeps only the last OUTPUT_TAIL_CHARS, so the markers are
 * pushed out of the bounded tail. Parsing the TAIL then sees no count → "unverified" (a false read
 * that the C1 evidence gate treats as promotable-with-caveats), when the truth is "zero" — a runner
 * that executed nothing. mapExec now parses the tally from the FULL streamed output and stamps it on
 * the CheckResult; readVerifier prefers that stamp, so the zero is detected regardless of tail length.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExecResult } from "../governed-exec/index.js";
import { mapExec, parseTestCount, MAX_OUTPUT_TAIL } from "./checks.js";
import { readVerifier } from "./orchestrator.js";
import type { RoleResult } from "./contract.js";

// A verbose passing run: "# tests 0" / "# pass 0" at the TOP, then >MAX_OUTPUT_TAIL chars of noise.
const VERBOSE = `# tests 0\n# pass 0\n# fail 0\n${"verbose passing line\n".repeat(300)}`;
// The bounded tail governed-exec would retain — the early zero-test markers are gone from it.
const TAIL_ONLY = VERBOSE.slice(-MAX_OUTPUT_TAIL);

test("H9: the truncated tail alone no longer carries the zero-test markers (the bug's premise)", () => {
  assert.ok(TAIL_ONLY.length >= MAX_OUTPUT_TAIL - 50, "the verbose run is long enough to truncate the tail");
  // Parsing ONLY the tail misses the early markers — this is exactly the stale read the fix removes.
  assert.equal(parseTestCount(TAIL_ONLY), undefined, "tail has no '# tests' marker (would read 'unverified')");
  // Parsing the FULL output finds the zero count.
  assert.deepEqual(parseTestCount(VERBOSE), { passed: 0, total: 0 });
});

test("H9: mapExec stamps testCount from the FULL output, not the truncated tail", () => {
  const res: ExecResult = { executed: true, exitCode: 0, stdoutTail: TAIL_ONLY, stderrTail: "" };
  // No full output supplied → falls back to the tail → no count (the old, fragile behavior).
  assert.equal(mapExec("test", "pnpm test", res).check.testCount, undefined);
  // Full output supplied (what the verifier now accumulates from the streaming sink) → zero detected.
  const { check } = mapExec("test", "pnpm test", res, VERBOSE);
  assert.deepEqual(check.testCount, { passed: 0, total: 0 });
  assert.equal(check.outputTail, TAIL_ONLY, "the tail is still the bounded tail — only counting uses the full output");
});

test('H9: readVerifier reads testEvidence "zero" from the stamped count even when the tail is markerless', () => {
  // The verifier result a real run now produces: the test check carries the stamped full-output count,
  // while its outputTail is the markerless truncated tail.
  const { check } = mapExec("test", "pnpm test", { executed: true, exitCode: 0, stdoutTail: TAIL_ONLY, stderrTail: "" }, VERBOSE);
  const verifierResult: RoleResult = {
    role: "verifier",
    outcome: "success",
    summary: "verified",
    detail: { verdict: "pass", checks: [{ name: "typecheck", command: "pnpm tsc --noEmit", exitCode: 0, outputTail: "" }, check] },
  };
  const v = readVerifier(verifierResult);
  assert.equal(v.testEvidence, "zero", "the early zero-test markers are honored despite tail truncation");
  assert.deepEqual(v.testCount, { passed: 0, total: 0 });
});

test('H9: a real executed suite (count > 0) still reads testEvidence "executed"', () => {
  const realRun = `${"running\n".repeat(300)}# tests 12\n# pass 12\n# fail 0\n`;
  const tail = realRun.slice(-MAX_OUTPUT_TAIL);
  const { check } = mapExec("test", "pnpm test", { executed: true, exitCode: 0, stdoutTail: tail, stderrTail: "" }, realRun);
  const verifierResult: RoleResult = {
    role: "verifier",
    outcome: "success",
    summary: "verified",
    detail: { verdict: "pass", checks: [check] },
  };
  const v = readVerifier(verifierResult);
  assert.equal(v.testEvidence, "executed");
  assert.deepEqual(v.testCount, { passed: 12, total: 12 });
});

test("LADDER full-scope: testEvidence is carried from a SUCCESSFUL test check even when an earlier same-named scope had no parseable count", () => {
  // The ladder runs the suite across stages (nearest-tests → package-checks → full), so detail.checks
  // can hold MORE THAN ONE check named "test". An earlier scope-limited run can pass with no tally
  // while the later full-scope run carried a real count. readVerifier must aggregate and report the
  // STRONGEST real evidence — not under-report "unverified" off the first check and discard a build
  // that verification actually proved (the TypeScript / mixed-language greenfield regression).
  const nearestNoCount: Record<string, unknown> = { name: "test", command: "pnpm test", exitCode: 0, outputTail: "ran (no parseable tally in this scope)" };
  const fullReal = mapExec("test", "pnpm test", { executed: true, exitCode: 0, stdoutTail: "Tests  13 passed (13)\n", stderrTail: "" }, "Tests  13 passed (13)\n").check;
  const verifierResult: RoleResult = {
    role: "verifier",
    outcome: "success",
    summary: 'verification PASSED for scope "full"',
    detail: { verdict: "pass", verificationScope: "full", checks: [{ name: "typecheck", command: "pnpm tsc --noEmit", exitCode: 0, outputTail: "" }, nearestNoCount, fullReal] },
  };
  const v = readVerifier(verifierResult);
  assert.equal(v.testEvidence, "executed", "the real full-scope count is honored over the earlier countless run");
  assert.deepEqual(v.testCount, { passed: 13, total: 13 });
  assert.equal(v.testsPass, true, "all 'test' checks passed");
});

test("FAIL-CLOSED preserved: multiple test checks with NO parseable count anywhere stays 'unverified'", () => {
  // The aggregation must never manufacture evidence: if no test check carried a real tally, the build
  // is still unverified and the integrator's single-run gate still discards it.
  const a: Record<string, unknown> = { name: "test", command: "pnpm test", exitCode: 0, outputTail: "done" };
  const b: Record<string, unknown> = { name: "test", command: "pnpm test", exitCode: 0, outputTail: "ok" };
  const verifierResult: RoleResult = { role: "verifier", outcome: "success", summary: "v", detail: { verdict: "pass", checks: [a, b] } };
  const v = readVerifier(verifierResult);
  assert.equal(v.testEvidence, "unverified", "no real tally anywhere → still unverified (fail-closed)");
});

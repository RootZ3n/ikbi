/**
 * ikbi check-triage — parser acceptance tests (pure, in-memory strings).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCheckOutput } from "./index.js";

test("node:test — captures the failing test name from TAP `not ok`", () => {
  const r = parseCheckOutput({ name: "test", command: "node --test", exitCode: 1, stdout: "TAP version 13\nok 1 - passes\nnot ok 2 - my failing test\n  ---\n  ...\n" });
  assert.equal(r.passed, false);
  assert.ok(r.failures.includes("my failing test"), "failing test name captured");
  assert.ok(r.detectedFrameworks.includes("node:test"));
});

test("vitest/jest — captures FAIL and ✗ markers", () => {
  const r = parseCheckOutput({ name: "test", command: "pnpm vitest run", exitCode: 1, stdout: "RUN  v1.0\nFAIL  src/math.test.ts > adds numbers\n ✗ adds numbers 3ms\n" });
  assert.equal(r.passed, false);
  assert.ok(r.failures.some((f) => f.includes("adds numbers")), "✗ failure captured");
  assert.ok(r.failures.some((f) => f.includes("src/math.test.ts")), "FAIL line captured");
  assert.ok(r.detectedFrameworks.includes("vitest/jest"));
});

test("pytest — captures FAILED path::test", () => {
  const r = parseCheckOutput({ name: "test", command: "pytest -q", exitCode: 1, stdout: "FAILED tests/test_x.py::test_foo - assert 1 == 2\n" });
  assert.equal(r.passed, false);
  assert.ok(r.failures.includes("tests/test_x.py::test_foo"));
  assert.ok(r.detectedFrameworks.includes("pytest"));
});

test("go test — captures --- FAIL: TestName", () => {
  const r = parseCheckOutput({ name: "test", command: "go test ./...", exitCode: 1, stdout: "=== RUN   TestAdd\n--- FAIL: TestAdd (0.00s)\n    add_test.go:9: want 3\nFAIL\texample/pkg\t0.10s\n" });
  assert.equal(r.passed, false);
  assert.ok(r.failures.includes("TestAdd"));
  assert.ok(r.detectedFrameworks.includes("go-test"));
});

test("tsc — captures path(line,col) error lines", () => {
  const r = parseCheckOutput({ name: "typecheck", command: "npx tsc --noEmit", exitCode: 2, stdout: "src/foo.ts(12,5): error TS2345: Argument of type 'x' is not assignable to 'y'.\n" });
  assert.equal(r.passed, false);
  assert.ok(r.failures.some((f) => f.includes("src/foo.ts(12,5)") && f.includes("TS2345")));
  assert.ok(r.detectedFrameworks.includes("tsc"));
});

test("huge output keeps head + tail and marks truncated", () => {
  const big = `START_HEAD${"x".repeat(20_000)}END_TAIL`;
  const r = parseCheckOutput({ name: "test", command: "pnpm test", exitCode: 1, stdout: big });
  assert.equal(r.truncated, true);
  assert.ok(r.head.startsWith("START_HEAD"), "head preserved");
  assert.ok(r.tail.endsWith("END_TAIL"), "tail preserved (not tail-only)");
  assert.ok(r.head.length <= 4_000 && r.tail.length <= 4_000, "bounded");
});

test("ANSI sequences are stripped", () => {
  const r = parseCheckOutput({ name: "test", command: "pnpm test", exitCode: 1, stdout: "[31m✗ red failing[39m\n" });
  assert.ok(r.failures.includes("red failing"), "marker detected after ANSI strip");
  assert.ok(!r.head.includes(""), "no escape bytes remain in head");
  assert.ok(r.detectedFrameworks.includes("vitest/jest"));
});

test("unknown format → safe generic summary, never throws", () => {
  const r = parseCheckOutput({ name: "build", command: "make widget", exitCode: 1, stdout: "doing stuff\nboom happened\n" });
  assert.equal(r.passed, false);
  assert.deepEqual(r.failures, [], "no structured failures for an unknown format");
  assert.ok(r.errorSummary.length > 0, "summary always present");
  assert.ok(/FAILED \(exit 1/.test(r.errorSummary), "summary states the failure + exit code");
  assert.ok(/boom happened/.test(r.errorSummary), "summary includes a last-line hint");
});

test("passed (exit 0) → passed true, positive summary", () => {
  const r = parseCheckOutput({ name: "test", command: "pnpm test", exitCode: 0, stdout: "Tests: 8 passed\n" });
  assert.equal(r.passed, true);
  assert.ok(/passed/.test(r.errorSummary));
});

test("deterministic: identical input → identical output", () => {
  const input = { name: "test", command: "go test ./...", exitCode: 1, stdout: "--- FAIL: TestA\n--- FAIL: TestB\n" };
  assert.deepEqual(parseCheckOutput(input), parseCheckOutput(input));
});

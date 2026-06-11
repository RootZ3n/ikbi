/**
 * Tests for the debug assistant module (debug-assistant.ts).
 *
 * Covers: TypeScript error parsing, test failure parsing, runtime error parsing,
 * build error parsing, debug report generation, surrounding code context,
 * fix goal integration, and edge cases.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseErrors,
  buildDebugReport,
  formatDebugFixGoal,
  type ParsedError,
} from "./debug-assistant.js";

// ── TypeScript Error Parsing ───────────────────────────────────────────────────

test("parseErrors: classic TypeScript error format (path(line,col))", () => {
  const errors = parseErrors("src/foo.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.");
  assert.equal(errors.length, 1);
  const e = errors[0]!;
  assert.equal(e.category, "typescript");
  assert.equal(e.file, "src/foo.ts");
  assert.equal(e.line, 10);
  assert.equal(e.column, 5);
  assert.equal(e.code, "TS2322");
  assert.match(e.message, /string.*not assignable.*number/);
  assert.equal(e.suggestedFix.includes("Type mismatch"), true);
});

test("parseErrors: newer TypeScript error format (path:line:col)", () => {
  const errors = parseErrors("src/bar.ts:15:3 - error TS2339: Property 'baz' does not exist on type 'Foo'.");
  assert.equal(errors.length, 1);
  const e = errors[0]!;
  assert.equal(e.category, "typescript");
  assert.equal(e.file, "src/bar.ts");
  assert.equal(e.line, 15);
  assert.equal(e.column, 3);
  assert.equal(e.code, "TS2339");
  assert.match(e.message, /Property 'baz' does not exist/);
  assert.equal(e.suggestedFix.includes("Property does not exist"), true);
});

test("parseErrors: TypeScript error without column (path:line)", () => {
  const errors = parseErrors("src/utils.ts:42 - error TS2304: Cannot find name 'MyType'.");
  assert.equal(errors.length, 1);
  const e = errors[0]!;
  assert.equal(e.category, "typescript");
  assert.equal(e.file, "src/utils.ts");
  assert.equal(e.line, 42);
  assert.equal(e.column, undefined);
  assert.equal(e.code, "TS2304");
  assert.match(e.message, /Cannot find name 'MyType'/);
});

test("parseErrors: multiple TypeScript errors", () => {
  const input = [
    "src/a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
    "src/b.ts:5:10 - error TS2339: Property 'x' does not exist on type 'Y'.",
    "src/c.ts:8 - error TS2304: Cannot find name 'Z'.",
  ].join("\n");

  const errors = parseErrors(input);
  assert.equal(errors.length, 3);
  assert.equal(errors[0]!.file, "src/a.ts");
  assert.equal(errors[1]!.file, "src/b.ts");
  assert.equal(errors[2]!.file, "src/c.ts");
});

test("parseErrors: TS2307 cannot find module", () => {
  const errors = parseErrors("src/index.ts(3,1): error TS2307: Cannot find module './missing'.");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.code, "TS2307");
  assert.equal(errors[0]!.suggestedFix.includes("Cannot find module"), true);
});

test("parseErrors: TS2532 possibly undefined", () => {
  const errors = parseErrors("src/app.ts:10:5 - error TS2532: Object is possibly 'undefined'.");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.code, "TS2532");
  assert.equal(errors[0]!.suggestedFix.includes("possibly undefined"), true);
});

test("parseErrors: TypeScript error with check prefix stripped", () => {
  const errors = parseErrors("[typecheck] src/foo.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.category, "typescript");
  assert.equal(errors[0]!.file, "src/foo.ts");
  assert.equal(errors[0]!.code, "TS2322");
});

// ── Test Failure Parsing ──────────────────────────────────────────────────────

test("parseErrors: TAP test failure (not ok)", () => {
  const errors = parseErrors("not ok 42 - should compute the sum correctly");
  assert.equal(errors.length, 1);
  const e = errors[0]!;
  assert.equal(e.category, "test");
  assert.match(e.message, /should compute the sum correctly/);
});

test("parseErrors: TAP test failure without description", () => {
  const errors = parseErrors("not ok 1");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.category, "test");
});

test("parseErrors: Vitest/Jest FAIL line", () => {
  const errors = parseErrors("FAIL src/math.test.ts");
  assert.equal(errors.length, 1);
  const e = errors[0]!;
  assert.equal(e.category, "test");
  assert.equal(e.file, "src/math.test.ts");
});

test("parseErrors: AssertionError", () => {
  const errors = parseErrors("AssertionError: expected 42 to equal 0");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.category, "test");
  assert.match(errors[0]!.message, /expected 42 to equal 0/);
});

test("parseErrors: test failure with check prefix", () => {
  const errors = parseErrors("[test] not ok 7 - add function returns wrong value");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.category, "test");
  assert.match(errors[0]!.message, /add function returns wrong value/);
});

test("parseErrors: assertion error reclassified from runtime to test when from test check", () => {
  const errors = parseErrors("[test] AssertionError: expected 1, got 0");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.category, "test");
  assert.match(errors[0]!.message, /expected 1, got 0/);
});

// ── Runtime Error Parsing ─────────────────────────────────────────────────────

test("parseErrors: generic Error", () => {
  const errors = parseErrors("Error: something went wrong");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.category, "runtime");
  assert.match(errors[0]!.message, /something went wrong/);
});

test("parseErrors: TypeError", () => {
  const errors = parseErrors("TypeError: Cannot read properties of null (reading 'map')");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.category, "runtime");
  assert.match(errors[0]!.message, /Cannot read properties of null/);
  assert.equal(errors[0]!.suggestedFix.includes("null/undefined"), true);
});

test("parseErrors: ReferenceError", () => {
  const errors = parseErrors("ReferenceError: foo is not defined");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.category, "runtime");
  assert.equal(errors[0]!.suggestedFix.includes("not in scope"), true);
});

test("parseErrors: SyntaxError", () => {
  const errors = parseErrors("SyntaxError: Unexpected token '}'");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.category, "runtime");
  assert.equal(errors[0]!.suggestedFix.includes("syntax"), true);
});

// ── Build Error Parsing ───────────────────────────────────────────────────────

test("parseErrors: Cannot find module", () => {
  const errors = parseErrors("Error: Cannot find module 'express'");
  assert.equal(errors.length, 1);
  // The "Error:" prefix matches runtime first, but "Cannot find module" is in the message
  const e = errors[0]!;
  assert.match(e.message, /Cannot find module|express/);
});

test("parseErrors: ENOENT file not found", () => {
  const errors = parseErrors("ENOENT: no such file or directory, open '/path/to/missing.ts'");
  assert.equal(errors.length, 1);
  // ENOENT doesn't start with "Error:" so it should match build error
  assert.equal(errors[0]!.category, "build");
  assert.match(errors[0]!.message, /File not found/);
});

// ── Mixed Error Parsing ───────────────────────────────────────────────────────

test("parseErrors: mixed TypeScript and test errors", () => {
  const input = [
    "[typecheck] src/foo.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.",
    "[test] not ok 1 - addition test",
    "[test] AssertionError: expected 3, got 4",
  ].join("\n");

  const errors = parseErrors(input);
  assert.equal(errors.length, 3);
  assert.equal(errors[0]!.category, "typescript");
  assert.equal(errors[1]!.category, "test");
  assert.equal(errors[2]!.category, "test");
});

test("parseErrors: handles empty input", () => {
  assert.deepEqual(parseErrors(""), []);
  assert.deepEqual(parseErrors("   \n  \n  "), []);
});

test("parseErrors: handles unknown error formats gracefully", () => {
  const errors = parseErrors("some random error text that doesn't match any pattern");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.category, "unknown");
  assert.match(errors[0]!.message, /some random error text/);
});

// ── Debug Report Generation ───────────────────────────────────────────────────

test("buildDebugReport: includes error count", () => {
  const errors: ParsedError[] = [
    { category: "typescript", file: "src/a.ts", line: 10, code: "TS2322", message: "type mismatch", raw: "raw", suggestedFix: "fix types" },
  ];
  const report = buildDebugReport(errors);
  assert.match(report, /Found 1 error/);
});

test("buildDebugReport: includes file path and line number", () => {
  const errors: ParsedError[] = [
    { category: "typescript", file: "src/foo.ts", line: 42, column: 5, code: "TS2322", message: "bad type", raw: "raw", suggestedFix: "fix it" },
  ];
  const report = buildDebugReport(errors);
  assert.match(report, /src\/foo\.ts:42:5/);
});

test("buildDebugReport: includes suggested fix", () => {
  const errors: ParsedError[] = [
    { category: "typescript", message: "bad type", raw: "raw", suggestedFix: "Check the type annotation" },
  ];
  const report = buildDebugReport(errors);
  assert.match(report, /Check the type annotation/);
});

test("buildDebugReport: includes category summary", () => {
  const errors: ParsedError[] = [
    { category: "typescript", message: "ts err", raw: "raw", suggestedFix: "fix" },
    { category: "typescript", message: "ts err 2", raw: "raw", suggestedFix: "fix" },
    { category: "test", message: "test fail", raw: "raw", suggestedFix: "fix" },
  ];
  const report = buildDebugReport(errors);
  assert.match(report, /2 typescript, 1 test/);
});

test("buildDebugReport: empty errors returns no-error message", () => {
  const report = buildDebugReport([]);
  assert.equal(report, "No errors to report.");
});

test("buildDebugReport: includes surrounding code when readFile provided", () => {
  const fileContent = [
    "import { foo } from './foo';",
    "",
    "export function bar(): number {",
    "  const x: number = 'hello'; // error here (line 4)",
    "  return x;",
    "}",
    "",
    "export function baz() {",
    "  return bar();",
    "}",
  ].join("\n");

  const errors: ParsedError[] = [
    { category: "typescript", file: "src/bar.ts", line: 4, column: 7, code: "TS2322", message: "type mismatch", raw: "raw", suggestedFix: "fix types" },
  ];

  const report = buildDebugReport(errors, {
    readFile: (path) => path === "src/bar.ts" ? fileContent : undefined,
  });

  // Should include the error line with marker (> prefix for error line)
  assert.match(report, />\s*\d+\|/);
  // Should include context lines (5 above/below)
  assert.match(report, /import.*foo/);
  assert.match(report, /export function baz/);
});

test("buildDebugReport: gracefully handles readFile returning undefined", () => {
  const errors: ParsedError[] = [
    { category: "typescript", file: "src/missing.ts", line: 1, message: "err", raw: "raw", suggestedFix: "fix" },
  ];

  const report = buildDebugReport(errors, { readFile: () => undefined });
  // Should not include context section, but should still have the error
  assert.match(report, /Found 1 error/);
  assert.match(report, /src\/missing\.ts/);
});

test("buildDebugReport: custom context lines", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const fileContent = lines.join("\n");

  const errors: ParsedError[] = [
    { category: "typescript", file: "src/big.ts", line: 10, message: "err", raw: "raw", suggestedFix: "fix" },
  ];

  const report = buildDebugReport(errors, {
    readFile: () => fileContent,
    contextLines: 2,
  });

  // With contextLines=2, should include lines 8-12 (2 above, 2 below error line 10)
  assert.match(report, /line 8/);
  assert.match(report, /line 12/);
  // Should NOT include line 1 (too far from error)
  // (line 1 is "line 1" — check it's NOT in the context block)
  // The "Found 1 error" header is at the top, so search only in context
  const contextBlock = report.split("Context:")[1];
  if (contextBlock !== undefined) {
    assert.equal(contextBlock.includes("line 1\n"), false);
    assert.equal(contextBlock.includes("line 7\n"), false);
  }
});

// ── formatDebugFixGoal ────────────────────────────────────────────────────────

test("formatDebugFixGoal: produces structured report from raw errors", () => {
  const raw = "[typecheck] src/foo.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.";
  const goal = formatDebugFixGoal(raw);

  assert.match(goal, /The verifier found errors/);
  assert.match(goal, /TS2322/);
  assert.match(goal, /src\/foo\.ts:10:5/);
  assert.match(goal, /Type mismatch/);
});

test("formatDebugFixGoal: handles multiple errors", () => {
  const raw = [
    "[typecheck] src/a.ts(1,1): error TS2322: bad type",
    "[test] not ok 1 - test name",
  ].join("\n");
  const goal = formatDebugFixGoal(raw);

  assert.match(goal, /Found 2 error/);
  assert.match(goal, /TS2322/);
  assert.match(goal, /test name/);
});

test("formatDebugFixGoal: handles empty errors", () => {
  const goal = formatDebugFixGoal("");
  assert.match(goal, /No errors to report/);
});

test("formatDebugFixGoal: includes surrounding code with readFile", () => {
  const raw = "src/utils.ts:3 - error TS2304: Cannot find name 'foo'.";
  const fileContent = "line 1\nline 2\nline 3\nline 4\nline 5";
  const goal = formatDebugFixGoal(raw, { readFile: () => fileContent });

  assert.match(goal, /line 1/);
  assert.match(goal, /line 3/);
});

test("formatDebugFixGoal: preserves raw error text in report", () => {
  const raw = "[test] AssertionError: expected 42 to equal 0";
  const goal = formatDebugFixGoal(raw);

  // The error message should appear in the report
  assert.match(goal, /expected 42 to equal 0/);
});

// ── Suggested Fix Directions ──────────────────────────────────────────────────

test("parseErrors: TS2322 suggests type mismatch fix", () => {
  const errors = parseErrors("src/a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.");
  assert.match(errors[0]!.suggestedFix, /Type mismatch/);
});

test("parseErrors: TS2339 suggests property fix", () => {
  const errors = parseErrors("src/a.ts:1:1 - error TS2339: Property 'x' does not exist on type 'T'.");
  assert.match(errors[0]!.suggestedFix, /Property does not exist/);
});

test("parseErrors: TS2304 suggests name lookup fix", () => {
  const errors = parseErrors("src/a.ts:1 - error TS2304: Cannot find name 'X'.");
  assert.match(errors[0]!.suggestedFix, /Cannot find name/);
});

test("parseErrors: TS2554 suggests argument count fix", () => {
  const errors = parseErrors("src/a.ts:1:1 - error TS2554: Expected 2 arguments, but got 3.");
  assert.match(errors[0]!.suggestedFix, /Wrong number of arguments/);
});

test("parseErrors: TS2532 suggests null check fix", () => {
  const errors = parseErrors("src/a.ts:1:1 - error TS2532: Object is possibly 'undefined'.");
  assert.match(errors[0]!.suggestedFix, /possibly undefined/);
});

test("parseErrors: ReferenceError suggests scope fix", () => {
  const errors = parseErrors("ReferenceError: x is not defined");
  assert.match(errors[0]!.suggestedFix, /not in scope/);
});

test("parseErrors: TypeError with null suggests null check", () => {
  const errors = parseErrors("TypeError: Cannot read properties of null (reading 'map')");
  assert.match(errors[0]!.suggestedFix, /null/);
});

// ── Integration with formatFixGoal ────────────────────────────────────────────

test("formatDebugFixGoal is a drop-in for formatFixGoal", () => {
  // The old formatFixGoal produced: `The verifier found errors in your code. Fix them:\n\n{errors}`
  // The new formatDebugFixGoal should produce the same header
  const raw = "[test] expected 1, got 0";
  const goal = formatDebugFixGoal(raw);

  assert.match(goal, /The verifier found errors in your code\. Fix them:/);
  // And it should include the structured report
  assert.match(goal, /Found 1 error/);
  assert.match(goal, /expected 1, got 0/);
});

// ── Edge Cases ────────────────────────────────────────────────────────────────

test("parseErrors: handles ANSI-stripped input (no escape sequences)", () => {
  // The module assumes input is already ANSI-stripped (the check-triage module handles that)
  const errors = parseErrors("src/a.ts(1,1): error TS2322: bad type");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.category, "typescript");
});

test("parseErrors: handles Windows-style paths", () => {
  const errors = parseErrors("src\\foo.ts(10,5): error TS2322: bad type");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.file, "src\\foo.ts");
});

test("parseErrors: handles very long error messages", () => {
  const longMsg = "x".repeat(5000);
  const errors = parseErrors(`Error: ${longMsg}`);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.message.length, 5000 + "Error: ".length);
});

test("buildDebugReport: handles many errors", () => {
  const errors: ParsedError[] = Array.from({ length: 20 }, (_, i) => ({
    category: "typescript" as const,
    file: `src/f${i}.ts`,
    line: i + 1,
    message: `error ${i}`,
    raw: `raw ${i}`,
    suggestedFix: `fix ${i}`,
  }));

  const report = buildDebugReport(errors);
  assert.match(report, /Found 20 error/);
  assert.match(report, /Error 1 \[TYPESCRIPT\]/);
  assert.match(report, /Error 20 \[TYPESCRIPT\]/);
});

test("parseErrors: unknown TS error code gets generic fix suggestion", () => {
  const errors = parseErrors("src/a.ts:1:1 - error TS99999: Some unknown error.");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.code, "TS99999");
  assert.match(errors[0]!.suggestedFix, /TypeScript error TS99999/);
});

test("parseErrors: line with only whitespace is skipped", () => {
  const errors = parseErrors("   \n   \n   ");
  assert.equal(errors.length, 0);
});

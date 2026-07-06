/**
 * parseTestCount must recognize the common test runners — not just ikbi's own node:test. A repo
 * under build that uses vitest or jest would otherwise read "unverified" even when its suite ran and
 * passed, and the C1 evidence gate (testEvidence === "executed") would reject a legitimate build.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseTestCount } from "./checks.js";

test("parseTestCount: node:test '# tests' / '# pass' markers", () => {
  assert.deepEqual(parseTestCount("# tests 10\n# pass 10"), { passed: 10, total: 10 });
});

test("parseTestCount: vitest 'Tests  3 passed (3)'", () => {
  assert.deepEqual(parseTestCount("Tests  3 passed (3)"), { passed: 3, total: 3 });
});

test("parseTestCount: vitest full summary block", () => {
  const out = [
    " ✓ src/foo.test.ts (3 tests) 12ms",
    " Test Files  1 passed (1)",
    "      Tests  3 passed (3)",
  ].join("\n");
  assert.deepEqual(parseTestCount(out), { passed: 3, total: 3 });
});

test("parseTestCount: ANSI-COLORED vitest summary (governed-exec emits color even on a non-TTY)", () => {
  // The exact byte shape governed-exec captures from vitest — escape codes BETWEEN the tokens. Before
  // stripping, the \s+ anchors failed across the codes and the count was lost → a real green build read
  // "unverified" and was discarded. This is the TypeScript / mixed-language greenfield regression.
  const ansi = "\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m12 passed\x1b[39m\x1b[22m\x1b[90m (12)\x1b[39m";
  assert.deepEqual(parseTestCount(ansi), { passed: 12, total: 12 });
});

test("parseTestCount: jest 'Tests:       3 passed, 3 total'", () => {
  assert.deepEqual(parseTestCount("Tests:       3 passed, 3 total"), { passed: 3, total: 3 });
});

test("parseTestCount: generic mocha-style 'N passing'", () => {
  assert.deepEqual(parseTestCount("  5 passing\n  5 total"), { passed: 5, total: 5 });
});

test("parseTestCount: no recognizable summary returns undefined", () => {
  assert.equal(parseTestCount("all done"), undefined);
});

test("parseTestCount: pytest \"N passed in X.XXs\"", () => {
  assert.deepEqual(parseTestCount("===== 5 passed in 0.03s ====="), { passed: 5, total: 5 });
  assert.deepEqual(parseTestCount("===== 12 passed, 2 failed in 1.23s ====="), { passed: 12, total: 12 });
  assert.deepEqual(parseTestCount("===== 1 passed in 0.01s ====="), { passed: 1, total: 1 });
});

test("parseTestCount: cargo test 'test result: ok. N passed; M failed'", () => {
  assert.deepEqual(
    parseTestCount("test result: ok. 15 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out"),
    { passed: 15, total: 17 },
  );
  assert.deepEqual(
    parseTestCount("test result: ok. 42 passed; 0 failed; 0 ignored"),
    { passed: 42, total: 42 },
  );
});

test("parseTestCount: cargo test simpler form 'test result: ok. N passed'", () => {
  assert.deepEqual(parseTestCount("test result: ok. 8 passed"), { passed: 8, total: 8 });
});

test("parseTestCount: cargo MULTI-SECTION output (lib + empty bin + doc-tests) — the Rust greenfield regression", () => {
  // A real `cargo test` on a lib+bin crate prints THREE result blocks: the lib tests (the real ones),
  // then the bin's "running 0 tests", then doc-tests. The greedy generic matcher used to bridge the
  // lib's "17 passed" to the bin's "running 0 tests" and return total:0 ⇒ testEvidence "zero" ⇒ a
  // fully-tested Rust build was DISCARDED (found live: the roman-numeral E2E build). The precise cargo
  // matcher must win: 17 real passing tests, total 17.
  const cargo = [
    "     Running unittests src/lib.rs (target/debug/deps/roman-3a303b11c2f23ca8)",
    "",
    "running 17 tests",
    "test tests::to_roman_1 ... ok",
    "test result: ok. 17 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
    "",
    "     Running unittests src/main.rs (target/debug/deps/roman-12d997bc85f6ed2b)",
    "",
    "running 0 tests",
    "",
    "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
    "",
    "   Doc-tests roman",
    "",
    "running 0 tests",
    "",
    "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
  ].join("\n");
  assert.deepEqual(parseTestCount(cargo), { passed: 17, total: 17 });
});

test("parseTestCount: .NET VSTest 'Passed! - Failed: F, Passed: P, Skipped: S, Total: T'", () => {
  assert.deepEqual(parseTestCount("Passed!  - Failed:     0, Passed:     6, Skipped:     0, Total:     6, Duration: 12 ms"), { passed: 6, total: 6 });
  assert.deepEqual(parseTestCount("Failed!  - Failed:     2, Passed:     3, Skipped:     1, Total:     6, Duration: 9 ms"), { passed: 3, total: 6 });
});

test("parseTestCount: JVM 'Tests run: N, Failures: F, Errors: E' (JUnit / Maven Surefire / hand-rolled)", () => {
  assert.deepEqual(parseTestCount("Tests run: 7, Failures: 0, Errors: 0"), { passed: 7, total: 7 });
  assert.deepEqual(parseTestCount("Tests run: 10, Failures: 2, Errors: 1, Skipped: 0"), { passed: 7, total: 10 });
  assert.deepEqual(parseTestCount("[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0\n[INFO] BUILD SUCCESS"), { passed: 3, total: 3 });
});

test("parseTestCount: python unittest 'Ran N tests ... OK' (stdlib, sandbox-runnable)", () => {
  const ok = [
    "test_addition (test_rpn.TestRPN.test_addition) ... ok",
    "test_division (test_rpn.TestRPN.test_division) ... ok",
    "",
    "----------------------------------------------------------------------",
    "Ran 9 tests in 0.000s",
    "",
    "OK",
  ].join("\n");
  assert.deepEqual(parseTestCount(ok), { passed: 9, total: 9 });
});

test("parseTestCount: python unittest FAILED subtracts failures+errors", () => {
  assert.deepEqual(parseTestCount("Ran 5 tests in 0.001s\n\nFAILED (failures=1, errors=1)"), { passed: 3, total: 5 });
  assert.deepEqual(parseTestCount("Ran 4 tests in 0.001s\n\nFAILED (failures=2)"), { passed: 2, total: 4 });
});

test("parseTestCount: python unittest 'Ran 0 tests' is vacuous ⇒ total 0 (gate discards)", () => {
  // A discover run that matched nothing prints "Ran 0 tests ... OK" — green but vacuous. total:0 ⇒
  // readVerifier scores testEvidence "zero" ⇒ the single-run gate refuses to promote. Anti-vacuous.
  assert.deepEqual(parseTestCount("Ran 0 tests in 0.000s\n\nOK"), { passed: 0, total: 0 });
});

test("parseTestCount: go test ok/FAIL lines", () => {
  const output = [
    "ok  \tgithub.com/user/pkg1\t0.123s",
    "ok  \tgithub.com/user/pkg2\t0.456s",
    "FAIL\tgithub.com/user/pkg3\t0.789s",
  ].join("\n");
  assert.deepEqual(parseTestCount(output), { passed: 2, total: 3 });
});

test("parseTestCount: go test all passing", () => {
  const output = [
    "ok  \tgithub.com/user/pkg1\t0.123s",
    "ok  \tgithub.com/user/pkg2\t0.456s",
  ].join("\n");
  assert.deepEqual(parseTestCount(output), { passed: 2, total: 2 });
});

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

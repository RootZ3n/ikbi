/**
 * checkToIkbiChecksJson: an operator `--check "<cmd>"` becomes the IKBI_CHECKS the verifier runs.
 * Two hazards it must handle, both discovered building a real project on the cheap roster:
 *   1. governed-exec is array-args / NO shell — a compound "a && b" tokenized as one command hands
 *      "&&" to the binary and is rejected. Split on "&&" into sequential single-command checks.
 *   2. the promote gate reads test-execution evidence off a check NAMED "test" (and typecheck off
 *      "typecheck"). A generically-named "check" running "pnpm test" is invisible as test evidence,
 *      so a real green build is discarded ("test evidence absent"). Name stages by what they do.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkToIkbiChecksJson } from "./cli.js";

type Check = { name: string; command: string; args: string[] };
const parse = (raw: string): Check[] => JSON.parse(checkToIkbiChecksJson(raw) ?? "[]") as Check[];

test("a bare test command is named \"test\" (so the verifier counts it as test evidence)", () => {
  assert.deepEqual(parse("pnpm test"), [{ name: "test", command: "pnpm", args: ["test"] }]);
  assert.deepEqual(parse("npm run test"), [{ name: "test", command: "npm", args: ["run", "test"] }]);
});

test("python3 -m unittest is named \"test\" (stdlib Python evidence)", () => {
  assert.deepEqual(parse("python3 -m unittest discover -v"), [
    { name: "test", command: "python3", args: ["-m", "unittest", "discover", "-v"] },
  ]);
});

test("cargo test is named \"test\"", () => {
  assert.equal(parse("cargo test")[0]?.name, "test");
});

test("a tsc command is named \"typecheck\"", () => {
  assert.deepEqual(parse("pnpm exec tsc -p tsconfig.json"), [
    { name: "typecheck", command: "pnpm", args: ["exec", "tsc", "-p", "tsconfig.json"] },
  ]);
});

test("a compound compile-then-test check splits into sequential single-command checks (no shell &&)", () => {
  const checks = parse("pnpm exec tsc -p tsconfig.json && node --test dist");
  assert.equal(checks.length, 2);
  assert.deepEqual(checks[0], { name: "typecheck", command: "pnpm", args: ["exec", "tsc", "-p", "tsconfig.json"] });
  assert.deepEqual(checks[1], { name: "test", command: "node", args: ["--test", "dist"] });
  // No stage carries a literal "&&" that governed-exec could never run.
  assert.ok(!checks.some((c) => c.command === "&&" || c.args.includes("&&")));
});

test("node --test is recognized as a test check by flag", () => {
  assert.equal(parse("node --test dist")[0]?.name, "test");
});

test("a non-test, non-typecheck command stays a generic check", () => {
  assert.equal(parse("pnpm run lint")[0]?.name, "check");
});

test("multiple generic stages get distinct names", () => {
  const checks = parse("pnpm run lint && pnpm run format");
  assert.deepEqual(checks.map((c) => c.name), ["check1", "check2"]);
});

test("empty / whitespace input yields undefined", () => {
  assert.equal(checkToIkbiChecksJson("   "), undefined);
  assert.equal(checkToIkbiChecksJson(" && "), undefined);
});

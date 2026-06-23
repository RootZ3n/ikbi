/**
 * ikbi `review` CLI tests — arg parsing, scope resolution, output formatting, exit codes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ReviewResult } from "../modules/worker-model/review.js";
import { createReviewCli, parseReviewArgs, resolveScope } from "./review.js";

function capture() {
  let out = "";
  let err = "";
  let exit: number | undefined;
  return {
    stdout: (s: string) => void (out += s),
    stderr: (s: string) => void (err += s),
    setExit: (c: number) => void (exit = c),
    get out() { return out; },
    get err() { return err; },
    get exit() { return exit; },
  };
}

function okResult(over: Partial<ReviewResult> = {}): ReviewResult {
  return { model: "m", summary: "looks good", comments: [], filesReviewed: ["a.ts"], ...over };
}

test("parseReviewArgs: flags + positional paths", () => {
  const a = parseReviewArgs(["src/a.ts", "src/b.ts", "--json", "--model", "x", "--repo", "/r"]);
  assert.deepEqual(a.paths, ["src/a.ts", "src/b.ts"]);
  assert.equal(a.json, true);
  assert.equal(a.model, "x");
  assert.equal(a.repo, "/r");
});

test("parseReviewArgs: --pr parses a number", () => {
  const a = parseReviewArgs(["--pr", "123"]);
  assert.equal(a.pr, 123);
});

test("resolveScope: explicit paths win", () => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-rev-"));
  writeFileSync(join(dir, "a.ts"), "x\n");
  const scope = resolveScope(
    parseReviewArgs(["a.ts", "--repo", dir]),
    { repo: dir, localChanges: () => ({ files: [], diff: "" }), prChanges: () => ({ files: [], diff: "" }) },
  );
  assert.equal(scope.files.length, 1);
  assert.match(scope.label, /1 path/);
});

test("resolveScope: default uses local changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-rev-"));
  writeFileSync(join(dir, "changed.ts"), "x\n");
  const scope = resolveScope(
    parseReviewArgs(["--repo", dir]),
    { repo: dir, localChanges: () => ({ files: ["changed.ts"], diff: "DIFF" }), prChanges: () => ({ files: [], diff: "" }) },
  );
  assert.equal(scope.files.length, 1);
  assert.equal(scope.diff, "DIFF");
  assert.equal(scope.label, "current changes");
});

test("resolveScope: --pr routes through prChanges", () => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-rev-"));
  writeFileSync(join(dir, "p.ts"), "x\n");
  let askedPr: number | undefined;
  const scope = resolveScope(
    parseReviewArgs(["--pr", "7", "--repo", dir]),
    { repo: dir, localChanges: () => ({ files: [], diff: "" }), prChanges: (_r, n) => { askedPr = n; return { files: ["p.ts"], diff: "PRDIFF" }; } },
  );
  assert.equal(askedPr, 7);
  assert.equal(scope.diff, "PRDIFF");
  assert.match(scope.label, /PR #7/);
});

test("run: --help prints usage, no review", async () => {
  const cap = capture();
  const cli = createReviewCli({ ...cap, runReview: async () => okResult() });
  await cli.run(["--help"]);
  assert.match(cap.out, /Usage: ikbi review/);
});

test("run: missing repo exits 1", async () => {
  const cap = capture();
  const cli = createReviewCli({ ...cap, runReview: async () => okResult() });
  await cli.run(["--repo", "/no/such/dir/xyz"]);
  assert.equal(cap.exit, 1);
  assert.match(cap.err, /repo not found/);
});

test("run: no files to review exits 1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-rev-"));
  const cap = capture();
  const cli = createReviewCli({ ...cap, localChanges: () => ({ files: [], diff: "" }), runReview: async () => okResult() });
  await cli.run(["--repo", dir]);
  assert.equal(cap.exit, 1);
  assert.match(cap.err, /no files to review/);
});

test("run: prints markdown by default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-rev-"));
  writeFileSync(join(dir, "a.ts"), "x\n");
  const cap = capture();
  const cli = createReviewCli({
    ...cap,
    localChanges: () => ({ files: ["a.ts"], diff: "" }),
    runReview: async () => okResult({ summary: "Great work", comments: [{ id: "1", file: "a.ts", severity: "low", category: "quality", comment: "tidy" }] }),
  });
  await cli.run(["--repo", dir]);
  assert.match(cap.out, /# Code Review/);
  assert.match(cap.out, /Great work/);
  assert.equal(cap.exit, undefined);
});

test("run: --json emits JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-rev-"));
  writeFileSync(join(dir, "a.ts"), "x\n");
  const cap = capture();
  const cli = createReviewCli({
    ...cap,
    localChanges: () => ({ files: ["a.ts"], diff: "" }),
    runReview: async () => okResult({ summary: "JSON path" }),
  });
  await cli.run(["--repo", dir, "--json"]);
  const parsed = JSON.parse(cap.out);
  assert.equal(parsed.summary, "JSON path");
});

test("run: passes the chosen model through", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-rev-"));
  writeFileSync(join(dir, "a.ts"), "x\n");
  const cap = capture();
  let usedModel: string | undefined;
  const cli = createReviewCli({
    ...cap,
    localChanges: () => ({ files: ["a.ts"], diff: "" }),
    runReview: async (opts) => { usedModel = opts.model; return okResult(); },
  });
  await cli.run(["--repo", dir, "--model", "custom-model"]);
  assert.equal(usedModel, "custom-model");
});

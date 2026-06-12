/**
 * Tests for quality-checks.ts — deterministic code quality checks.
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, describe, before, after } from "node:test";

import { runQualityChecks } from "./quality-checks.js";

// ── Test fixtures ──────────────────────────────────────────────────────────────

const TEST_WS = join(import.meta.dirname ?? __dirname, "__quality_test_ws");

function setup() {
  mkdirSync(TEST_WS, { recursive: true });
  mkdirSync(join(TEST_WS, "src"), { recursive: true });
}

function teardown() {
  rmSync(TEST_WS, { recursive: true, force: true });
}

function writeFile(rel: string, content: string) {
  const full = join(TEST_WS, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function touchEmpty(rel: string) {
  const full = join(TEST_WS, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, "", "utf8");
}

// ── Empty file detection ───────────────────────────────────────────────────────

describe("quality-checks", () => {
  before(() => setup());
  after(() => teardown());

  test("empty file (0 bytes) is detected", () => {
    touchEmpty("src/empty.ts");
    const result = runQualityChecks(TEST_WS, ["src/empty.ts"]);
    assert.equal(result.pass, false);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0]!.kind, "empty_file");
    assert.ok(result.issues[0]!.detail.includes("0 bytes"));
  });

  test("non-empty file passes empty check", () => {
    writeFile("src/full.ts", "export const x = 1;\n");
    const result = runQualityChecks(TEST_WS, ["src/full.ts"]);
    assert.equal(result.pass, true);
    assert.equal(result.issues.length, 0);
  });

  // ── Stub detection ────────────────────────────────────────────────────────

  test("file with only comments is detected as stub", () => {
    writeFile("src/comments.ts", "// This is a comment\n/* block comment */\n// nothing else\n");
    const result = runQualityChecks(TEST_WS, ["src/comments.ts"]);
    assert.equal(result.pass, false);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0]!.kind, "stub_file");
  });

  test("file with only empty exports is detected as stub", () => {
    writeFile("src/empty-export.ts", "export {};\n");
    const result = runQualityChecks(TEST_WS, ["src/empty-export.ts"]);
    assert.equal(result.pass, false);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0]!.kind, "stub_file");
  });

  test("file with TODO placeholder is detected as stub", () => {
    writeFile("src/todo.ts", "// TODO: implement this\n// FIXME: not working\n");
    const result = runQualityChecks(TEST_WS, ["src/todo.ts"]);
    assert.equal(result.pass, false);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0]!.kind, "stub_file");
  });

  test("file with real code passes stub check", () => {
    writeFile("src/real.ts", 'export function hello(): string {\n  return "world";\n}\n');
    const result = runQualityChecks(TEST_WS, ["src/real.ts"]);
    assert.equal(result.pass, true);
  });

  test("TODO inside real code is NOT flagged as stub", () => {
    writeFile("src/with-todo.ts", 'export function doWork(): number {\n  // TODO: optimize this\n  return 42;\n}\n');
    const result = runQualityChecks(TEST_WS, ["src/with-todo.ts"]);
    assert.equal(result.pass, true);
  });

  // ── Location check ────────────────────────────────────────────────────────

  test("file in node_modules is blocked", () => {
    const result = runQualityChecks(TEST_WS, ["node_modules/foo/index.js"]);
    assert.equal(result.pass, false);
    const locationIssue = result.issues.find((i) => i.kind === "bad_location");
    assert.ok(locationIssue !== undefined);
    assert.ok(locationIssue!.detail.includes("blocked directory"));
  });

  test("file in .git is blocked", () => {
    const result = runQualityChecks(TEST_WS, [".git/hooks/pre-commit"]);
    assert.equal(result.pass, false);
    assert.equal(result.issues[0]!.kind, "bad_location");
  });

  test("file in dist is blocked", () => {
    const result = runQualityChecks(TEST_WS, ["dist/bundle.js"]);
    assert.equal(result.pass, false);
    assert.equal(result.issues[0]!.kind, "bad_location");
  });

  test("file in src is allowed", () => {
    writeFile("src/allowed.ts", "export const ok = true;\n");
    const result = runQualityChecks(TEST_WS, ["src/allowed.ts"]);
    assert.equal(result.pass, true);
  });

  test("file in scripts is allowed", () => {
    writeFile("scripts/deploy.sh", "#!/bin/bash\necho deploy\n");
    const result = runQualityChecks(TEST_WS, ["scripts/deploy.sh"]);
    assert.equal(result.pass, true);
  });

  test("nested blocked dir is detected (src/node_modules/bad.ts)", () => {
    const result = runQualityChecks(TEST_WS, ["src/node_modules/bad.ts"]);
    assert.equal(result.pass, false);
    assert.equal(result.issues[0]!.kind, "bad_location");
  });

  // ── Import coherence ──────────────────────────────────────────────────────

  test("broken relative import is detected", () => {
    writeFile("src/broken-import.ts", 'import { foo } from "./nonexistent";\nexport const x = 1;\n');
    const result = runQualityChecks(TEST_WS, ["src/broken-import.ts"]);
    assert.equal(result.pass, false);
    const importIssue = result.issues.find((i) => i.kind === "broken_import");
    assert.ok(importIssue !== undefined);
    assert.ok(importIssue!.detail.includes("./nonexistent"));
  });

  test("valid relative import passes", () => {
    writeFile("src/real.ts", 'export const hello = "world";\n');
    writeFile("src/consumer.ts", 'import { hello } from "./real";\nconsole.log(hello);\n');
    const result = runQualityChecks(TEST_WS, ["src/consumer.ts"]);
    assert.equal(result.pass, true);
  });

  test("bare specifier (node_modules) import is NOT flagged", () => {
    writeFile("src/with-external.ts", 'import { join } from "node:path";\nimport express from "express";\n');
    const result = runQualityChecks(TEST_WS, ["src/with-external.ts"]);
    assert.equal(result.pass, true);
  });

  test("import with .js extension resolves to .ts file", () => {
    writeFile("src/utils.ts", "export const util = 42;\n");
    writeFile("src/app.ts", 'import { util } from "./utils.js";\nconsole.log(util);\n');
    const result = runQualityChecks(TEST_WS, ["src/app.ts"]);
    assert.equal(result.pass, true);
  });

  // ── Multiple issues ───────────────────────────────────────────────────────

  test("multiple issues across multiple files", () => {
    touchEmpty("src/empty.ts");
    writeFile("src/stub.ts", "// TODO\n");
    const result = runQualityChecks(TEST_WS, ["src/empty.ts", "src/stub.ts", "node_modules/bad.js"]);
    assert.equal(result.pass, false);
    assert.equal(result.issues.length, 3);
    assert.ok(result.issues.some((i) => i.kind === "empty_file"));
    assert.ok(result.issues.some((i) => i.kind === "stub_file"));
    assert.ok(result.issues.some((i) => i.kind === "bad_location"));
  });

  test("empty written files list returns pass", () => {
    const result = runQualityChecks(TEST_WS, []);
    assert.equal(result.pass, true);
    assert.equal(result.issues.length, 0);
  });

  // ── Non-existent files ────────────────────────────────────────────────────

  test("non-existent file is silently skipped (no crash)", () => {
    const result = runQualityChecks(TEST_WS, ["src/does-not-exist.ts"]);
    assert.equal(result.pass, true);
  });

  // ── Location check before content checks ──────────────────────────────────

  test("blocked location files are not checked for content", () => {
    // If a file is in node_modules, we skip content checks entirely
    const result = runQualityChecks(TEST_WS, ["node_modules/pkg/empty.ts"]);
    assert.equal(result.pass, false);
    assert.equal(result.issues.length, 1, "only one issue (bad_location), not empty_file too");
    assert.equal(result.issues[0]!.kind, "bad_location");
  });

  // ── .d.ts exclusion ───────────────────────────────────────────────────────

  test("L4: .d.ts files with only triple-slash directives are NOT flagged as stubs", () => {
    writeFile("src/vite-env.d.ts", '/// <reference types="vite/client" />\n');
    const result = runQualityChecks(TEST_WS, ["src/vite-env.d.ts"]);
    assert.equal(result.pass, true, "vite-env.d.ts should pass — it's a type declaration, not a stub");
    assert.equal(result.issues.length, 0);
  });
});

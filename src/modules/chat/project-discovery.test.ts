/**
 * REPL FIX 2: project auto-discovery — detect the stack, count source/test files, and
 * note project instructions. Pure scan of a tmp worktree (no model, no terminal).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { discoverProject, formatOverview } from "./project-discovery.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "ikbi-disc-"));
}

test("FIX2: a TypeScript project is detected with source + test counts", () => {
  const dir = scratch();
  writeFileSync(join(dir, "package.json"), "{}");
  writeFileSync(join(dir, "tsconfig.json"), "{}");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "src", "b.ts"), "export const b = 2;\n");
  writeFileSync(join(dir, "src", "a.test.ts"), "test;\n");
  writeFileSync(join(dir, "src", "b.spec.ts"), "test;\n");

  const o = discoverProject(dir);
  assert.equal(o.language, "TypeScript");
  assert.equal(o.sourceFiles, 4, "4 .ts files counted (2 source + 2 test)");
  assert.equal(o.testFiles, 2, "2 of them are test files");

  const banner = formatOverview(o);
  assert.match(banner, /TypeScript project/);
  assert.match(banner, /4 source files/);
  assert.match(banner, /2 test files/);
  assert.ok(banner.includes(dir), "the workspace path is shown");
});

test("FIX2: node_modules is skipped from the counts", () => {
  const dir = scratch();
  writeFileSync(join(dir, "package.json"), "{}");
  writeFileSync(join(dir, "index.js"), "1;\n");
  mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "dep", "x.js"), "1;\n");
  const o = discoverProject(dir);
  assert.equal(o.language, "Node/JavaScript");
  assert.equal(o.sourceFiles, 1, "only the top-level source file is counted, not node_modules");
});

test("FIX2: CLAUDE.md is reported as project instructions", () => {
  const dir = scratch();
  writeFileSync(join(dir, "go.mod"), "module x\n");
  writeFileSync(join(dir, "main.go"), "package main\n");
  writeFileSync(join(dir, "CLAUDE.md"), "# rules\n");
  const o = discoverProject(dir);
  assert.equal(o.language, "Go");
  assert.equal(o.instructionsFile, "CLAUDE.md");
  assert.match(formatOverview(o), /Project instructions loaded from CLAUDE\.md/);
});

test("FIX2: an empty/unknown directory degrades gracefully", () => {
  const dir = scratch();
  const o = discoverProject(dir);
  assert.equal(o.language, "source");
  assert.equal(o.sourceFiles, 0);
  assert.equal(o.testFiles, 0);
  assert.equal(o.instructionsFile, undefined);
  assert.match(formatOverview(o), /source project · 0 source files · 0 test files/);
});

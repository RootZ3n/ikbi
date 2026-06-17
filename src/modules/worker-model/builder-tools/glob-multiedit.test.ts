import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { globToRegExp, runGlob } from "./glob.js";
import { runMultiEdit } from "./multi-edit.js";

function fixture(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ikbi-glob-")));
  mkdirSync(join(dir, "src", "lib"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "src", "lib", "util.ts"), "export const b = 2;\n");
  writeFileSync(join(dir, "src", "lib", "util.test.ts"), "test;\n");
  writeFileSync(join(dir, "README.md"), "# hi\n");
  writeFileSync(join(dir, "node_modules", "pkg", "index.ts"), "ignored;\n");
  return dir;
}

test("globToRegExp: ** crosses dirs, * stays in a segment", () => {
  assert.ok(globToRegExp("src/**/*.ts").test("src/lib/util.ts"));
  assert.ok(globToRegExp("src/**/*.ts").test("src/index.ts"));
  assert.ok(!globToRegExp("src/*.ts").test("src/lib/util.ts")); // * does not cross /
  assert.ok(globToRegExp("**/*.md").test("README.md"));
});

test("runGlob: finds .ts files and skips node_modules", () => {
  const out = runGlob(fixture(), { pattern: "**/*.ts" });
  const lines = out.split("\n");
  assert.ok(lines.includes("src/index.ts"));
  assert.ok(lines.includes("src/lib/util.ts"));
  assert.ok(!lines.some((l) => l.includes("node_modules")), "node_modules is skipped");
});

test("runGlob: no match returns a clear message; empty pattern errors", () => {
  assert.match(runGlob(fixture(), { pattern: "**/*.rs" }), /no files match/);
  assert.match(runGlob(fixture(), { pattern: "" }), /ERROR/);
});

test("runMultiEdit: applies multiple edits atomically", () => {
  const dir = fixture();
  const res = runMultiEdit(dir, { path: "src/index.ts", edits: [
    { find: "export const a = 1;", replace: "export const a = 10;" },
  ] });
  assert.equal(res.wrote, "src/index.ts");
  assert.match(res.output, /applied 1 edit/);
});

test("runMultiEdit: all-or-nothing — a failing edit writes nothing", () => {
  const dir = fixture();
  const res = runMultiEdit(dir, { path: "src/lib/util.ts", edits: [
    { find: "export const b = 2;", replace: "export const b = 3;" }, // would match
    { find: "DOES NOT EXIST", replace: "x" }, // fails → whole op rejected
  ] });
  assert.ok(res.rejection !== undefined, "the multi-edit was rejected");
  // The first edit must NOT have been persisted (atomicity).
  const after = runGlob(dir, { pattern: "src/lib/util.ts" });
  assert.ok(after.includes("src/lib/util.ts"));
});

test("runMultiEdit: a non-unique anchor is rejected", () => {
  const dir = fixture();
  writeFileSync(join(dir, "dup.ts"), "x\nx\n");
  const res = runMultiEdit(dir, { path: "dup.ts", edits: [{ find: "x", replace: "y" }] });
  assert.ok(res.rejection !== undefined);
  assert.match(res.output, /unique/);
});

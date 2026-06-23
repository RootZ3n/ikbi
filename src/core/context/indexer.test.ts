import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { indexFileTree } from "./indexer.js";

function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), "ikbi-idx-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "src", "core"));
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# hello");
  writeFileSync(join(root, "src", "index.ts"), "export const x = 1;");
  writeFileSync(join(root, "src", "core", "auth.ts"), "export function login() {}");
  writeFileSync(join(root, "node_modules", "dep", "junk.js"), "module.exports = {}");
  writeFileSync(join(root, ".git", "config"), "[core]");
  return root;
}

test("indexes files with path/size/ext/mtime and skips node_modules + .git", () => {
  const root = makeTree();
  try {
    const idx = indexFileTree(root);
    const paths = idx.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ["README.md", "src/core/auth.ts", "src/index.ts"]);
    assert.ok(!paths.some((p) => p.includes("node_modules")), "node_modules pruned");
    assert.ok(!paths.some((p) => p.includes(".git")), ".git pruned");
    const ts = idx.files.find((f) => f.path === "src/index.ts")!;
    assert.equal(ts.ext, ".ts");
    assert.ok(ts.size > 0);
    assert.ok(ts.mtimeMs > 0);
    assert.ok(ts.absPath.endsWith("index.ts"));
    assert.equal(idx.truncated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("paths use forward slashes regardless of platform", () => {
  const root = makeTree();
  try {
    const idx = indexFileTree(root);
    for (const f of idx.files) assert.ok(!f.path.includes("\\"), `${f.path} uses forward slashes`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("maxFiles caps the walk and reports truncation", () => {
  const root = mkdtempSync(join(tmpdir(), "ikbi-idx-"));
  try {
    for (let i = 0; i < 20; i++) writeFileSync(join(root, `f${i}.ts`), "x");
    const idx = indexFileTree(root, { maxFiles: 5 });
    assert.equal(idx.files.length, 5);
    assert.equal(idx.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("maxDepth bounds descent", () => {
  const root = mkdtempSync(join(tmpdir(), "ikbi-idx-"));
  try {
    mkdirSync(join(root, "a", "b", "c"), { recursive: true });
    writeFileSync(join(root, "top.ts"), "x");
    writeFileSync(join(root, "a", "mid.ts"), "x");
    writeFileSync(join(root, "a", "b", "c", "deep.ts"), "x");
    const idx = indexFileTree(root, { maxDepth: 1 });
    const paths = idx.files.map((f) => f.path).sort();
    assert.ok(paths.includes("top.ts"));
    assert.ok(paths.includes("a/mid.ts"));
    assert.ok(!paths.includes("a/b/c/deep.ts"), "deep file pruned by maxDepth");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("indexes 1000+ files quickly (well under a second)", () => {
  const root = mkdtempSync(join(tmpdir(), "ikbi-idx-perf-"));
  try {
    for (let d = 0; d < 20; d++) {
      const dir = join(root, `pkg${d}`);
      mkdirSync(dir);
      for (let i = 0; i < 60; i++) writeFileSync(join(dir, `m${i}.ts`), `export const v${i} = ${i};`);
    }
    const start = Date.now();
    const idx = indexFileTree(root);
    const elapsed = Date.now() - start;
    assert.equal(idx.files.length, 1200);
    assert.ok(elapsed < 1000, `indexed 1200 files in ${elapsed}ms (target <1000ms)`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

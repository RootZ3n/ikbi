import assert from "node:assert/strict";
import { test } from "node:test";

import type { FileIndex, IndexedFile } from "./indexer.js";
import { extractKeywords, scoreFile, scoreFiles, selectContext } from "./loader.js";

function file(path: string, size = 100, mtimeMs = 1000): IndexedFile {
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".")).toLowerCase() : "";
  return { path, absPath: `/repo/${path}`, size, ext, mtimeMs };
}

function index(files: IndexedFile[]): FileIndex {
  return { root: "/repo", files, truncated: false };
}

test("extractKeywords lower-cases, drops short tokens and stopwords", () => {
  const kw = extractKeywords("Fix the authentication bug in AuthService");
  assert.ok(kw.includes("authentication"));
  assert.ok(kw.includes("authservice"));
  assert.ok(kw.includes("bug"));
  assert.ok(!kw.includes("the"), "stopword dropped");
  assert.ok(!kw.includes("in"), "short token dropped");
});

test("a basename match scores far above a path-only match", () => {
  const exact = scoreFile(file("src/auth.ts"), ["auth"]);
  const pathOnly = scoreFile(file("src/auth/helpers.ts"), ["auth"]);
  const unrelated = scoreFile(file("src/widgets.ts"), ["auth"]);
  assert.ok(exact > pathOnly, "exact stem match beats path match");
  assert.ok(pathOnly > unrelated, "path match beats no match");
});

test("source files outweigh docs which outweigh other files at equal keyword match", () => {
  const src = scoreFile(file("a.ts"), []);
  const doc = scoreFile(file("a.md"), []);
  const other = scoreFile(file("a.png"), []);
  assert.ok(src > doc && doc > other);
});

test("scoreFiles ranks the most relevant file first, deterministically", () => {
  const idx = index([
    file("src/widgets.ts"),
    file("src/auth.ts"),
    file("src/auth/session.ts"),
  ]);
  const ranked = scoreFiles(idx, "fix the auth session bug");
  // session.ts matches BOTH "auth" (in its path) and "session" (its basename), so it outranks
  // auth.ts (one match); widgets.ts (no keyword match) ranks last.
  assert.equal(ranked[0]!.file.path, "src/auth/session.ts");
  assert.equal(ranked[1]!.file.path, "src/auth.ts");
  assert.equal(ranked[2]!.file.path, "src/widgets.ts");
  // deterministic: same input → same order
  const again = scoreFiles(idx, "fix the auth session bug");
  assert.deepEqual(ranked.map((r) => r.file.path), again.map((r) => r.file.path));
});

test("hot paths get a relevance bonus", () => {
  const plain = scoreFile(file("src/util.ts"), [], {});
  const hot = scoreFile(file("src/util.ts"), [], { hot: true });
  assert.ok(hot > plain);
});

test("selectContext lazily reads only the files it admits, within budget", () => {
  const idx = index([
    file("src/auth.ts", 40),
    file("src/widgets.ts", 40),
    file("README.md", 40),
  ]);
  const reads: string[] = [];
  const read = (abs: string): string => {
    reads.push(abs);
    return "x".repeat(40); // ~10 tokens each
  };
  const { files } = selectContext(idx, "fix auth", { maxTokens: 12, readFile: read });
  // budget of 12 tokens fits one ~10-token file → the top-ranked auth.ts.
  assert.equal(files.length, 1);
  assert.equal(files[0]!.path, "src/auth.ts");
  assert.ok(files[0]!.content.length > 0);
  assert.ok(files[0]!.tokens > 0);
});

test("selectContext skips files larger than maxFileBytes", () => {
  const idx = index([file("src/auth.ts", 5_000_000)]);
  const { files } = selectContext(idx, "auth", { maxFileBytes: 1024, readFile: () => "x" });
  assert.equal(files.length, 0);
});

test("selectContext skips files that fail to read", () => {
  const idx = index([file("src/auth.ts", 10), file("src/login.ts", 10)]);
  const read = (abs: string): string => {
    if (abs.endsWith("auth.ts")) throw new Error("EACCES");
    return "ok";
  };
  const { files } = selectContext(idx, "auth login", { readFile: read });
  assert.deepEqual(files.map((f) => f.path), ["src/login.ts"]);
});

test("with no keyword matches, only positively-weighted (source/doc) files load", () => {
  const idx = index([file("a.ts", 10), file("b.png", 10)]);
  const { files } = selectContext(idx, "zzz no matches here", { readFile: () => "ok", minScore: 0 });
  // both have a positive base weight, but source ranks first
  assert.equal(files[0]!.path, "a.ts");
});

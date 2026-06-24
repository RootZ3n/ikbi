import assert from "node:assert/strict";
import { test } from "node:test";

import { detectProject, summarize, type DetectPorts, type ProjectDetection } from "./detect.js";

/** Build in-memory ports from a relative-path → contents map (rooted at "/repo"). */
function fakePorts(files: Record<string, string>): DetectPorts {
  const abs = new Map<string, string>();
  for (const [rel, content] of Object.entries(files)) abs.set(`/repo/${rel}`, content);
  return {
    exists: (p) => abs.has(p),
    readText: (p) => abs.get(p),
  };
}

function detect(files: Record<string, string>): ProjectDetection {
  return detectProject("/repo", fakePorts(files));
}

test("TypeScript + pnpm + React + vitest", () => {
  const d = detect({
    "package.json": JSON.stringify({ dependencies: { react: "^18" }, devDependencies: { vitest: "^1", typescript: "^5" } }),
    "tsconfig.json": "{}",
    "pnpm-lock.yaml": "",
  });
  assert.equal(d.primaryLanguage, "TypeScript");
  assert.equal(d.packageManager, "pnpm");
  assert.ok(d.frameworks.includes("React"));
  assert.ok(d.testRunners.includes("vitest"));
  assert.ok(d.buildTools.includes("pnpm"));
});

test("plain JavaScript with npm lockfile (no tsconfig, no typescript dep)", () => {
  const d = detect({ "package.json": JSON.stringify({ dependencies: {} }), "package-lock.json": "" });
  assert.equal(d.primaryLanguage, "JavaScript");
  assert.equal(d.packageManager, "npm");
});

test("Next.js detected from deps", () => {
  const d = detect({ "package.json": JSON.stringify({ dependencies: { next: "14", react: "18" } }), "yarn.lock": "" });
  assert.ok(d.frameworks.includes("Next.js"));
  assert.ok(d.frameworks.includes("React"));
  assert.equal(d.packageManager, "yarn");
});

test("Express + jest", () => {
  const d = detect({ "package.json": JSON.stringify({ dependencies: { express: "4" }, devDependencies: { jest: "29" } }) });
  assert.ok(d.frameworks.includes("Express"));
  assert.ok(d.testRunners.includes("jest"));
  assert.equal(d.packageManager, "npm", "defaults to npm with no lockfile");
});

test("node:test inferred from the test script", () => {
  const d = detect({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }) });
  assert.ok(d.testRunners.includes("node:test"));
});

test("Python with Poetry + FastAPI + pytest", () => {
  const d = detect({
    "pyproject.toml": "[tool.poetry]\nname='x'\n[tool.poetry.dependencies]\nfastapi='*'\npytest='*'",
  });
  assert.equal(d.primaryLanguage, "Python");
  assert.ok(d.buildTools.includes("poetry"));
  assert.ok(d.frameworks.includes("FastAPI"));
  assert.ok(d.testRunners.includes("pytest"));
});

test("Python with requirements.txt + Django uses pip", () => {
  const d = detect({ "requirements.txt": "Django==5.0\ngunicorn" });
  assert.equal(d.primaryLanguage, "Python");
  assert.ok(d.buildTools.includes("pip"));
  assert.ok(d.frameworks.includes("Django"));
});

test("Go project: go build + go test", () => {
  const d = detect({ "go.mod": "module example.com/x\n\ngo 1.22\nrequire github.com/gin-gonic/gin v1.9.0" });
  assert.equal(d.primaryLanguage, "Go");
  assert.ok(d.buildTools.includes("go"));
  assert.ok(d.testRunners.includes("go test"));
  assert.ok(d.frameworks.includes("Gin"));
});

test("Rust project: cargo + cargo test", () => {
  const d = detect({ "Cargo.toml": "[package]\nname='x'\n[dependencies]\nactix-web='4'" });
  assert.equal(d.primaryLanguage, "Rust");
  assert.ok(d.buildTools.includes("cargo"));
  assert.ok(d.testRunners.includes("cargo test"));
  assert.ok(d.frameworks.includes("Actix"));
});

test("Java + Maven + Spring", () => {
  const d = detect({ "pom.xml": "<project><dependency>org.springframework.boot:spring-boot-starter</dependency></project>" });
  assert.equal(d.primaryLanguage, "Java");
  assert.ok(d.buildTools.includes("maven"));
  assert.ok(d.frameworks.includes("Spring"));
});

test("Ruby on Rails via Gemfile", () => {
  const d = detect({ "Gemfile": "gem 'rails', '7.1'\ngem 'rspec'" });
  assert.equal(d.primaryLanguage, "Ruby");
  assert.ok(d.frameworks.includes("Rails"));
  assert.ok(d.testRunners.includes("rspec"));
});

test("polyglot: Node + Python both reported", () => {
  const d = detect({ "package.json": JSON.stringify({ dependencies: {} }), "pyproject.toml": "[project]\nname='x'" });
  assert.deepEqual([...d.languages].sort(), ["JavaScript", "Python"]);
});

test("Docker + git markers", () => {
  const d = detect({ "Dockerfile": "FROM node", "docker-compose.yml": "services:", ".git": "" });
  assert.equal(d.hasDocker, true);
  assert.equal(d.hasGit, true);
  assert.ok(d.markers.includes("Dockerfile"));
  assert.ok(d.markers.includes(".git"));
});

test("empty/unrecognized directory", () => {
  const d = detect({ "README.md": "# hi" });
  assert.equal(d.primaryLanguage, undefined);
  assert.equal(d.languages.length, 0);
  assert.match(summarize(d), /unrecognized/);
});

test("malformed package.json is fail-soft (treated as absent)", () => {
  const d = detect({ "package.json": "{ not json" });
  // No language from a broken package.json, but it must not throw.
  assert.equal(d.primaryLanguage, undefined);
});

test("summarize renders language, framework, and tooling", () => {
  const d = detect({
    "package.json": JSON.stringify({ dependencies: { react: "18" }, devDependencies: { vitest: "1", typescript: "5" } }),
    "tsconfig.json": "{}",
    "pnpm-lock.yaml": "",
  });
  const s = summarize(d);
  assert.match(s, /TypeScript/);
  assert.match(s, /React/);
  assert.match(s, /pnpm/);
  assert.match(s, /vitest/);
});

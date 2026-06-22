/**
 * Tests for repo-doctor module — analyzers and report generation.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { DIMENSIONS, runAllAnalyzers, runAnalyzer } from "./index.js";
import { analyze as analyzeFileHealth } from "./analyzers/file-health.js";
import { analyze as analyzeDependencyHealth } from "./analyzers/dependency-health.js";
import { analyze as analyzeTestHealth } from "./analyzers/test-health.js";
import { analyze as analyzeDocHealth } from "./analyzers/doc-health.js";
import { analyze as analyzeImportHealth } from "./analyzers/import-health.js";
import { analyze as analyzeStructureHealth } from "./analyzers/structure-health.js";

function tmpRepo(): string {
  const dir = join(tmpdir(), `repo-doctor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Dimension constants ──────────────────────────────────────────────────

test("DIMENSIONS has 6 entries", () => {
  assert.equal(DIMENSIONS.length, 6);
});

test("DIMENSIONS includes all expected dimensions", () => {
  const expected = ["file-health", "dependency-health", "test-health", "doc-health", "import-health", "structure-health"];
  for (const dim of expected) {
    assert.ok(DIMENSIONS.includes(dim as typeof DIMENSIONS[number]), `missing dimension: ${dim}`);
  }
});

// ── File health analyzer ─────────────────────────────────────────────────

test("file-health: small files score 100", () => {
  const dir = tmpRepo();
  try {
    writeFileSync(join(dir, "small.ts"), "export const x = 1;\n");
    const report = analyzeFileHealth(dir);
    assert.equal(report.dimension, "file-health");
    assert.equal(report.score, 100);
    assert.equal(report.findings.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file-health: large file produces warning", () => {
  const dir = tmpRepo();
  try {
    const content = Array.from({ length: 600 }, (_, i) => `// line ${i}`).join("\n");
    writeFileSync(join(dir, "big.ts"), content);
    const report = analyzeFileHealth(dir);
    assert.ok(report.score < 100);
    assert.ok(report.findings.length > 0);
    assert.equal(report.findings[0]!.severity, "warning");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file-health: very large file produces critical finding", () => {
  const dir = tmpRepo();
  try {
    const content = Array.from({ length: 1100 }, (_, i) => `// line ${i}`).join("\n");
    writeFileSync(join(dir, "huge.ts"), content);
    const report = analyzeFileHealth(dir);
    assert.ok(report.findings.some((f) => f.severity === "critical"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Dependency health analyzer ───────────────────────────────────────────

test("dependency-health: no circular deps scores 100", () => {
  const dir = tmpRepo();
  try {
    writeFileSync(join(dir, "package.json"), '{"name":"test"}');
    writeFileSync(join(dir, "a.ts"), 'import { b } from "./b.js";\nexport const a = 1;\n');
    writeFileSync(join(dir, "b.ts"), "export const b = 2;\n");
    const report = analyzeDependencyHealth(dir);
    assert.equal(report.dimension, "dependency-health");
    assert.equal(report.score, 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dependency-health: circular dep produces critical finding", () => {
  const dir = tmpRepo();
  try {
    writeFileSync(join(dir, "package.json"), '{"name":"test"}');
    writeFileSync(join(dir, "a.ts"), 'import { b } from "./b.js";\nexport const a = 1;\n');
    writeFileSync(join(dir, "b.ts"), 'import { a } from "./a.js";\nexport const b = 2;\n');
    const report = analyzeDependencyHealth(dir);
    assert.ok(report.findings.some((f) => f.severity === "critical"));
    assert.ok(report.score < 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dependency-health: missing package.json reduces score", () => {
  const dir = tmpRepo();
  try {
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    const report = analyzeDependencyHealth(dir);
    assert.ok(report.findings.some((f) => f.message.includes("package.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Test health analyzer ─────────────────────────────────────────────────

test("test-health: file with test scores 100", () => {
  const dir = tmpRepo();
  try {
    writeFileSync(join(dir, "foo.ts"), "export const foo = 1;\n");
    writeFileSync(join(dir, "foo.test.ts"), 'import { foo } from "./foo.js";\n');
    const report = analyzeTestHealth(dir);
    assert.equal(report.dimension, "test-health");
    assert.equal(report.score, 100);
    assert.equal(report.findings.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test-health: file without test produces finding", () => {
  const dir = tmpRepo();
  try {
    writeFileSync(join(dir, "foo.ts"), "export const foo = 1;\n");
    const report = analyzeTestHealth(dir);
    assert.ok(report.score < 100);
    assert.ok(report.findings.length > 0);
    assert.equal(report.findings[0]!.severity, "warning");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Doc health analyzer ──────────────────────────────────────────────────

test("doc-health: scores for JSDoc coverage", () => {
  const dir = tmpRepo();
  try {
    writeFileSync(join(dir, "index.ts"), [
      "/** documented */",
      "export function a() {}",
      "/** documented */",
      "export function b() {}",
      "/** documented */",
      "export function c() {}",
    ].join("\n"));
    const report = analyzeDocHealth(dir);
    assert.equal(report.dimension, "doc-health");
    assert.ok(report.score > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doc-health: many undocumented exports reduces score", () => {
  const dir = tmpRepo();
  try {
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(`export function fn${i}() {}`);
    }
    writeFileSync(join(dir, "index.ts"), lines.join("\n"));
    const report = analyzeDocHealth(dir);
    assert.ok(report.findings.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Import health analyzer ───────────────────────────────────────────────

test("import-health: used imports score 100", () => {
  const dir = tmpRepo();
  try {
    writeFileSync(join(dir, "index.ts"), 'import { foo } from "./foo.js";\nconsole.log(foo);\n');
    writeFileSync(join(dir, "foo.ts"), "export const foo = 1;\n");
    const report = analyzeImportHealth(dir);
    assert.equal(report.dimension, "import-health");
    assert.ok(report.score >= 95);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Structure health analyzer ────────────────────────────────────────────

test("structure-health: flat code scores 100", () => {
  const dir = tmpRepo();
  try {
    writeFileSync(join(dir, "flat.ts"), "export const x = 1;\nexport const y = 2;\n");
    const report = analyzeStructureHealth(dir);
    assert.equal(report.dimension, "structure-health");
    assert.equal(report.score, 100);
    assert.equal(report.findings.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("structure-health: deeply nested code reduces score", () => {
  const dir = tmpRepo();
  try {
    const nested = "if (true) { if (true) { if (true) { if (true) { if (true) { if (true) { } } } } } }";
    writeFileSync(join(dir, "nested.ts"), `export function f() { ${nested} }\n`);
    const report = analyzeStructureHealth(dir);
    assert.ok(report.findings.length > 0);
    assert.ok(report.score < 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Composite report ─────────────────────────────────────────────────────

test("runAllAnalyzers returns all 6 dimensions", () => {
  const dir = tmpRepo();
  try {
    writeFileSync(join(dir, "index.ts"), "export const x = 1;\n");
    const report = runAllAnalyzers(dir);
    assert.equal(report.dimensions.length, 6);
    assert.ok(report.overallScore >= 0 && report.overallScore <= 100);
    assert.ok(report.scannedAt);
    assert.equal(report.repoPath, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runAnalyzer returns single dimension", () => {
  const dir = tmpRepo();
  try {
    writeFileSync(join(dir, "index.ts"), "export const x = 1;\n");
    const report = runAnalyzer("file-health", dir);
    assert.equal(report.dimension, "file-health");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runAnalyzer throws for unknown dimension", () => {
  assert.throws(() => runAnalyzer("unknown" as never, "."));
});

test("runAllAnalyzers on empty repo returns valid report", () => {
  const dir = tmpRepo();
  try {
    const report = runAllAnalyzers(dir);
    assert.equal(report.dimensions.length, 6);
    assert.ok(report.overallScore >= 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

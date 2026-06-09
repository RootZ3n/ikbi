/**
 * ikbi project-index — fixture-backed acceptance tests.
 *
 * Builds a real monorepo on disk (2 packages under a pnpm workspace), then exercises the
 * deterministic index end to end: package detection, script discovery, cross-package import
 * resolution, file→test mapping, .gitignore/skip-dir honoring, single-file incremental refresh,
 * and reason-tagged query.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { createProjectIndex } from "./index.js";

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** Build the fixture monorepo; returns { repo, stateRoot } (caller cleans up). */
function makeFixture(): { repo: string; stateRoot: string } {
  const repo = mkdtempSync(join(tmpdir(), "ikbi-pi-repo-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "ikbi-pi-state-"));

  write(repo, "package.json", JSON.stringify({ name: "fixture-root", private: true, scripts: { test: "pnpm -r test", build: "pnpm -r build" } }));
  write(repo, "pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n");
  write(repo, ".gitignore", "ignored/\n*.log\n");

  // ignored by .gitignore — must NOT be indexed
  write(repo, "ignored/secret.ts", "export const secret = 1;\n");
  write(repo, "noise.log", "should be skipped\n");
  // skip-dir — must NOT be indexed
  write(repo, "node_modules/dep/index.js", "module.exports = {};\n");

  // package A — imports package B across the workspace, plus a colocated test
  write(repo, "packages/a/package.json", JSON.stringify({ name: "@fix/a", version: "1.0.0", scripts: { test: "vitest run", build: "tsc -p ." } }));
  write(repo, "packages/a/src/index.ts", 'import { b } from "@fix/b";\nimport { helper } from "./util";\nexport const a = b + helper();\n');
  write(repo, "packages/a/src/util.ts", "export function helper(): number {\n  return 41;\n}\n");
  write(repo, "packages/a/src/util.test.ts", 'import { helper } from "./util";\nimport { describe, it } from "node:test";\ndescribe("helper", () => it("works", () => helper()));\n');

  // package B — the import target
  write(repo, "packages/b/package.json", JSON.stringify({ name: "@fix/b", version: "1.0.0", scripts: { test: "vitest run" } }));
  write(repo, "packages/b/src/index.ts", "export const b = 1;\n");

  return { repo, stateRoot };
}

test("project-index: detects package roots, scripts, cross-package import, colocated test; honors ignore", async () => {
  const { repo, stateRoot } = makeFixture();
  try {
    const idx = createProjectIndex({ stateRoot });
    const data = await idx.build(repo);

    // .gitignore + skip-dir honored
    const paths = new Set(data.files.map((f) => f.path));
    assert.ok(!paths.has("ignored/secret.ts"), ".gitignore dir excluded");
    assert.ok(!paths.has("noise.log"), ".gitignore *.log excluded");
    assert.ok(![...paths].some((p) => p.startsWith("node_modules/")), "node_modules skipped");
    assert.ok(paths.has("packages/a/src/index.ts") && paths.has("packages/b/src/index.ts"), "source files indexed");

    // package roots
    const roots = new Set(data.packages.map((p) => p.root));
    assert.ok(roots.has("packages/a") && roots.has("packages/b"), "detected both package roots");
    assert.ok(roots.has(""), "detected the repo-root package");

    // scripts + manager (pnpm-workspace.yaml at root ⇒ pnpm)
    const pkgA = data.packages.find((p) => p.root === "packages/a");
    assert.ok(pkgA, "package A present");
    assert.equal(pkgA?.manager, "pnpm", "manager inferred as pnpm");
    assert.equal(pkgA?.scripts.test, "vitest run", "test script discovered");
    assert.equal(pkgA?.scripts.build, "tsc -p .", "build script discovered");
    assert.equal(pkgA?.testCommand, "pnpm test", "convenience test command");
    assert.equal(pkgA?.buildCommand, "pnpm run build", "convenience build command");

    // cross-package import resolves to B's entry file
    const crossEdge = data.imports.find((e) => e.from === "packages/a/src/index.ts" && e.specifier === "@fix/b");
    assert.ok(crossEdge, "the @fix/b import was recorded");
    assert.equal(crossEdge?.kind, "package", "classified as a package import");
    assert.equal(crossEdge?.to, "packages/b/src/index.ts", "resolved to package B's entry file");

    // file → colocated test
    assert.deepEqual(data.fileToTests["packages/a/src/util.ts"], ["packages/a/src/util.test.ts"], "source maps to colocated test");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("project-index: incremental refresh after ONE edit reparses exactly one file", async () => {
  const { repo, stateRoot } = makeFixture();
  try {
    const idx = createProjectIndex({ stateRoot });
    await idx.build(repo);

    // edit exactly one source file (append → size + content + mtime all change)
    appendFileSync(join(repo, "packages/a/src/util.ts"), "\n// touched\n");

    const result = await idx.refresh(repo);
    assert.deepEqual(result.reparsed, ["packages/a/src/util.ts"], "exactly the edited file was re-parsed");
    assert.deepEqual(result.added, [], "nothing added");
    assert.deepEqual(result.removed, [], "nothing removed");
    assert.ok(result.unchanged >= 4, "the rest of the files were left unchanged");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("project-index: query callers returns the importing file with reason imported-by-seed", async () => {
  const { repo, stateRoot } = makeFixture();
  try {
    const idx = createProjectIndex({ stateRoot });
    await idx.build(repo);

    const callers = await idx.query(repo, { seeds: ["packages/b/src/index.ts"], want: "callers" });
    const importer = callers.find((r) => r.path === "packages/a/src/index.ts");
    assert.ok(importer, "package A (the importer) is returned as a caller of B");
    assert.ok(importer?.reasons.includes("imported-by-seed"), "tagged with reason imported-by-seed");
    // a seed never returns itself
    assert.ok(!callers.some((r) => r.path === "packages/b/src/index.ts"), "seed excluded from its own results");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

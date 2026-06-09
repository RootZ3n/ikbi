/**
 * ikbi project-retrieval — fixture-backed acceptance tests.
 *
 * A "large-ish" monorepo whose relevant file lives OUTSIDE the first 40 traversal files (45 root
 * filler modules), so a blind 40-file sample would miss it. Retrieval must find it via goal terms +
 * the import/test graph, tag reasons, always include project rules, and emit "why selected" notes.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { createProjectIndex } from "../project-index/index.js";
import { createProjectRetrieval } from "./index.js";

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** A monorepo with 45 root filler files + a feature package whose widget is the relevant target. */
export function makeBigFixture(): { repo: string; stateRoot: string } {
  const repo = mkdtempSync(join(tmpdir(), "ikbi-pr-repo-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "ikbi-pr-state-"));

  for (let i = 0; i < 45; i += 1) {
    const n = String(i).padStart(2, "0");
    write(repo, `noise${n}.ts`, `export const n${n} = ${i};\n`); // first-40-sample filler, irrelevant
  }
  write(repo, "CLAUDE.md", "# Project rules\n- Prefer readable code.\n");
  write(repo, "package.json", JSON.stringify({ name: "big-root", private: true, scripts: { build: "tsc -b" } }));
  write(repo, "pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n");

  write(repo, "packages/core/package.json", JSON.stringify({ name: "@big/core", scripts: { build: "tsc" } }));
  write(repo, "packages/core/src/index.ts", "export const core = 1;\n");

  write(repo, "packages/feature/package.json", JSON.stringify({ name: "@big/feature", scripts: { test: "vitest run" } }));
  write(repo, "packages/feature/src/widget.ts", 'export function renderWidget(): string {\n  return "widget";\n}\n'); // TARGET
  write(repo, "packages/feature/src/widget.test.ts", 'import { renderWidget } from "./widget";\nimport { it } from "node:test";\nit("w", () => renderWidget());\n');
  write(repo, "packages/feature/src/index.ts", 'import { renderWidget } from "./widget";\nexport const ui = renderWidget();\n');

  // 10 files sharing the stem "common" (across dirs) — a term matching all of them is too generic.
  for (let i = 0; i < 10; i += 1) write(repo, `mod${i}/common.ts`, `export const c${i} = ${i};\n`);

  return { repo, stateRoot };
}

test("project-retrieval: finds the out-of-sample target + colocated test, tags reasons, rules first", async () => {
  const { repo, stateRoot } = makeBigFixture();
  try {
    const retrieval = createProjectRetrieval({ index: createProjectIndex({ stateRoot }) });
    const res = await retrieval.retrieve({ repoPath: repo, goal: "Fix the widget bug in the feature package" });

    assert.equal(res.mode, "index");
    const byPath = new Map(res.files.map((f) => [f.path, f]));

    // target found via a goal term (it is NOT among the first 40 traversal files)
    assert.ok(byPath.has("packages/feature/src/widget.ts"), "found the widget source");
    assert.ok(byPath.get("packages/feature/src/widget.ts")?.reasons.includes("goal-name-match"), "tagged goal-name-match");
    assert.ok(res.seeds.includes("packages/feature/src/widget.ts"), "widget resolved as a seed");

    // colocated test pulled through the graph
    assert.ok(byPath.has("packages/feature/src/widget.test.ts"), "found the colocated test");
    assert.ok(byPath.get("packages/feature/src/widget.test.ts")?.reasons.includes("test-of-seed"), "tagged test-of-seed");

    // project rules always included and ordered first
    assert.equal(res.files[0]?.path, "CLAUDE.md", "project rules ordered first");
    assert.ok(byPath.get("CLAUDE.md")?.reasons.includes("project-rules"), "tagged project-rules");

    // every selected file carries a why; irrelevant filler is not selected
    assert.ok(res.files.every((f) => f.why.length > 0), "every file has a 'why selected' note");
    assert.ok(!byPath.has("noise00.ts"), "irrelevant filler not selected");
    assert.ok(res.receipts.length > 0, "a decision trail is produced");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("project-retrieval: caller expansion tags the importer imported-by-seed", async () => {
  const { repo, stateRoot } = makeBigFixture();
  try {
    const retrieval = createProjectRetrieval({ index: createProjectIndex({ stateRoot }) });
    const res = await retrieval.retrieve({ repoPath: repo, goal: "investigate the widget" });
    const importer = res.files.find((f) => f.path === "packages/feature/src/index.ts");
    assert.ok(importer, "the importer of the seed is selected");
    assert.ok(importer?.reasons.includes("imported-by-seed"), "tagged imported-by-seed");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("project-retrieval: a generic term that matches everything is dropped as a seed", async () => {
  const { repo, stateRoot } = makeBigFixture();
  try {
    const retrieval = createProjectRetrieval({ index: createProjectIndex({ stateRoot }) });
    // "common" matches 10 files (stem) → too generic → must be dropped, not exploded into seeds
    const res = await retrieval.retrieve({ repoPath: repo, goal: "fix the common helpers" });
    assert.ok(res.receipts.some((r) => /too generic/.test(r)), "generic term reported as dropped");
    assert.ok(!res.seeds.some((s) => s.includes("common")), "no common-stem file became a seed");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

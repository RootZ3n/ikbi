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

import { createProjectIndex, projectIndexConfig } from "../project-index/index.js";
import { createProjectRetrieval, projectRetrievalConfig } from "./index.js";

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

  // 10 dirs each with common.ts + index.ts — generic stems/filenames that must NOT explode seeds.
  for (let i = 0; i < 10; i += 1) {
    write(repo, `mod${i}/common.ts`, `export const c${i} = ${i};\n`);
    write(repo, `mod${i}/index.ts`, `export const i${i} = ${i};\n`);
  }

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

// ── F1: generic path tokens must not seed the whole repo ────────────────────────────
test("F1: a generic path token (index.ts) does NOT seed every index.ts in the repo", async () => {
  const { repo, stateRoot } = makeBigFixture(); // has 12+ index.ts files
  try {
    const retrieval = createProjectRetrieval({ index: createProjectIndex({ stateRoot }) });
    const res = await retrieval.retrieve({ repoPath: repo, goal: "update the index.ts entry files" });
    assert.ok(res.receipts.some((r) => /index\.ts.*too generic/.test(r)), "the generic path token is reported as dropped");
    assert.equal(res.seeds.length, 0, "no seeds mined from the generic token");
    assert.ok(res.files.every((f) => !f.reasons.includes("goal-path-match")), "nothing tagged goal-path-match");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("F1: an EXACT path token still seeds precisely that one file", async () => {
  const { repo, stateRoot } = makeBigFixture();
  try {
    const retrieval = createProjectRetrieval({ index: createProjectIndex({ stateRoot }) });
    const res = await retrieval.retrieve({ repoPath: repo, goal: "fix packages/feature/src/index.ts" });
    assert.deepEqual(res.seeds, ["packages/feature/src/index.ts"], "exactly the named file is seeded");
    assert.ok(res.files.find((f) => f.path === "packages/feature/src/index.ts")?.reasons.includes("goal-path-match"), "tagged goal-path-match");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

// ── F2: tight budget keeps the top-scored target over a smaller manifest ─────────────
function makeBudgetFixture(): { repo: string; stateRoot: string } {
  const repo = mkdtempSync(join(tmpdir(), "ikbi-pr-bud-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "ikbi-pr-bud-state-"));
  write(repo, "CLAUDE.md", "# rules\n");
  write(repo, "packages/f/package.json", JSON.stringify({ name: "@b/f" }));
  write(repo, "packages/f/src/widget.ts", "export const w = 1;\n");
  write(repo, "packages/f/src/widget.test.ts", 'import "./widget";\n');
  write(repo, "packages/f/src/index.ts", 'import "./widget";\n');
  return { repo, stateRoot };
}

test("F2: under a tight budget, the highest-scored target is kept and a smaller manifest never jumps ahead", async () => {
  const { repo, stateRoot } = makeBudgetFixture();
  try {
    const retrieval = createProjectRetrieval({ index: createProjectIndex({ stateRoot }) });
    // perFileCap 10, budget 20 → rules(10) + exactly ONE non-rules(10); the rest is dropped.
    const res = await retrieval.retrieve({ repoPath: repo, goal: "fix the widget", budgetBytes: 20, perFileCapBytes: 10 });
    const paths = res.files.map((f) => f.path);
    assert.ok(paths.includes("packages/f/src/widget.ts"), "the top-scored target is kept");
    assert.ok(!paths.includes("packages/f/package.json"), "the lower-scored manifest did NOT jump ahead of dropped higher items");
    assert.ok(res.truncatedByBudget, "marked truncated");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

// ── F3: rules respect budget; the dropped rule is recorded ───────────────────────────
function makeRulesFixture(): { repo: string; stateRoot: string } {
  const repo = mkdtempSync(join(tmpdir(), "ikbi-pr-rules-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "ikbi-pr-rules-state-"));
  write(repo, "CLAUDE.md", "# root rules\n");
  write(repo, "packages/f/AGENTS.md", "# nested rules\n");
  write(repo, "packages/f/package.json", JSON.stringify({ name: "@b/f" }));
  write(repo, "packages/f/src/a.ts", "export const a = 1;\n");
  return { repo, stateRoot };
}

test("F3: under budget pressure only as many rules as fit are kept; the dropped rule is recorded", async () => {
  const { repo, stateRoot } = makeRulesFixture();
  try {
    const retrieval = createProjectRetrieval({ index: createProjectIndex({ stateRoot }) });
    // budget fits exactly ONE rules file (perFileCap 10, budget 10).
    const res = await retrieval.retrieve({ repoPath: repo, goal: "anything", budgetBytes: 10, perFileCapBytes: 10 });
    const paths = res.files.map((f) => f.path);
    assert.ok(paths.includes("CLAUDE.md"), "the first rules file is kept");
    assert.ok(!paths.includes("packages/f/AGENTS.md"), "the second rules file is dropped for budget (not force-included)");
    assert.ok(res.receipts.some((r) => /AGENTS\.md.*dropped/.test(r)), "the dropped rules file is recorded in the receipts");
    assert.ok(res.truncatedByBudget, "marked truncated");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

// ── P0/A3: relevance seed ranking (no alphabetical drop of critical seeds) ──────────
test("P0/A3: the seed cap keeps the high-relevance seed, not the alphabetically-first trivial one", async () => {
  const repo = mkdtempSync(join(tmpdir(), "ikbi-pr-rank-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "ikbi-pr-rank-state-"));
  try {
    write(repo, "package.json", JSON.stringify({ name: "r" }));
    write(repo, "src/constants.ts", "export const c = 1;\n"); // alphabetically-early, trivial (name-match, weight 12)
    write(repo, "src/z-critical-auth.ts", "export const a = 1;\n"); // critical (path-match, weight 20)
    const retrieval = createProjectRetrieval({ index: createProjectIndex({ stateRoot }), config: { ...projectRetrievalConfig, maxSeeds: 1 } });
    const res = await retrieval.retrieve({ repoPath: repo, goal: "fix z-critical-auth.ts; also update constants" });
    assert.ok(res.seeds.includes("src/z-critical-auth.ts"), "the critical (higher-relevance) seed survives the cap");
    assert.ok(!res.seeds.includes("src/constants.ts"), "the alphabetically-earlier trivial seed was dropped, not the critical one");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

// ── P0/F6: low-confidence on an incomplete (truncated) index ────────────────────────
test("P0/F6: a truncated index → retrieval flags LOW CONFIDENCE (does not proceed as if enough)", async () => {
  const { repo, stateRoot } = makeBigFixture(); // 60+ files
  try {
    // force the index to truncate (incomplete view) — the retrieval must NOT present this as enough.
    const retrieval = createProjectRetrieval({ index: createProjectIndex({ stateRoot, config: { ...projectIndexConfig, maxFiles: 1 } }) });
    const res = await retrieval.retrieve({ repoPath: repo, goal: "fix the widget bug" });
    assert.equal(res.lowConfidence, true, "low confidence is flagged");
    assert.match(res.lowConfidenceReason ?? "", /truncated|covers/, "reason names the incomplete view");
    assert.ok(res.receipts.some((r) => /LOW CONFIDENCE/.test(r)), "low confidence is surfaced loudly in receipts");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

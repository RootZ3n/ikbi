/**
 * ikbi project-index — fixture-backed acceptance tests.
 *
 * Builds a real monorepo on disk (2 packages under a pnpm workspace), then exercises the
 * deterministic index end to end: package detection, script discovery, cross-package import
 * resolution, file→test mapping, .gitignore/skip-dir honoring, single-file incremental refresh,
 * and reason-tagged query.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { createProjectIndex, projectIndexConfig } from "./index.js";

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

// ── R-A: git HEAD / provenance ────────────────────────────────────────────────────
test("R-A: a HEAD change triggers a safe full rebuild; same HEAD stays incremental", async () => {
  const { repo, stateRoot } = makeFixture();
  try {
    let head = "1111111111111111111111111111111111111111";
    const idx = createProjectIndex({ stateRoot, git: () => ({ head, branch: "main" }) });
    const built = await idx.build(repo);
    assert.equal(built.git?.head, head, "HEAD recorded in the index");
    assert.equal(built.git?.branch, "main", "branch recorded");

    const same = await idx.refresh(repo);
    assert.equal(same.headChanged, false, "same HEAD → no change");
    assert.equal(same.rebuilt, false, "same HEAD → incremental, no rebuild");

    head = "2222222222222222222222222222222222222222";
    const changed = await idx.refresh(repo);
    assert.equal(changed.headChanged, true, "HEAD change detected");
    assert.equal(changed.rebuilt, true, "a safe full rebuild was performed");
    assert.equal(changed.data.git?.head, head, "the new HEAD is persisted");
    assert.ok(changed.reparsed.length >= 5, "rebuild reparsed the whole tree");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("R-A: the real reader records HEAD + branch for an actual git repo", async () => {
  const { repo, stateRoot } = makeFixture();
  try {
    try {
      const g = (args: string[]): void => void execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "ignore"] });
      g(["init", "-q", "-b", "trunk"]);
      g(["config", "user.email", "t@example.com"]);
      g(["config", "user.name", "t"]);
      g(["add", "-A"]);
      g(["commit", "-qm", "init"]);
    } catch {
      return; // git unavailable / too old → skip (the injected-stub test covers behavior)
    }
    const data = await createProjectIndex({ stateRoot }).build(repo); // default real reader
    assert.ok(data.git, "provenance captured for a git repo");
    assert.match(data.git?.head ?? "", /^[0-9a-f]{40}$/, "HEAD is a full sha");
    assert.equal(data.git?.branch, "trunk", "branch recorded");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

// ── R-B: racy-clean refresh (same-size, same-mtime in-place edit) ───────────────────
test("R-B: refresh catches a same-size, same-mtime in-place edit", async () => {
  const { repo, stateRoot } = makeFixture();
  try {
    const idx = createProjectIndex({ stateRoot });
    const target = "packages/b/src/index.ts";
    const abs = join(repo, target);
    await idx.build(repo);

    const st = statSync(abs);
    const before = readFileSync(abs, "utf8");
    const after = before.replace("export const b = 1;", "export const b = 9;"); // same byte length
    assert.equal(after.length, before.length, "edit preserves byte size");
    writeFileSync(abs, after);
    utimesSync(abs, st.atime, st.mtime); // restore the original mtime → defeats the cheap probe

    const r = await idx.refresh(repo);
    assert.deepEqual(r.reparsed, [target], "the in-place edit was caught and reparsed (exactly one file)");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

// ── R-F: relative import with omitted extension ─────────────────────────────────────
test("R-F: a relative import with an omitted extension resolves to the .ts file", async () => {
  const { repo, stateRoot } = makeFixture();
  try {
    const data = await createProjectIndex({ stateRoot }).build(repo);
    const e = data.imports.find((x) => x.from === "packages/a/src/index.ts" && x.specifier === "./util");
    assert.ok(e, "the ./util import is recorded");
    assert.equal(e?.kind, "relative", "classified relative");
    assert.equal(e?.to, "packages/a/src/util.ts", "resolved ./util → util.ts (extension inferred)");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

// ── R-E: .gitignore matcher (anchored / **glob / nested / negation) + maxFiles ──────
function makeIgnoreFixture(): { repo: string; stateRoot: string } {
  const repo = mkdtempSync(join(tmpdir(), "ikbi-pi-ign-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "ikbi-pi-ign-state-"));
  write(repo, ".gitignore", "/ignored-root.ts\n**/*.log\ngen/\n");
  write(repo, "src/.gitignore", "*.draft.ts\n!keep.draft.ts\n");
  write(repo, "ignored-root.ts", "export const x = 1;\n"); // anchored at root → ignored
  write(repo, "src/ignored-root.ts", "export const x = 1;\n"); // anchor only at root → INCLUDED
  write(repo, "a.log", "log\n"); // **/*.log → ignored
  write(repo, "deep/inner/b.log", "log\n"); // **/*.log (nested) → ignored
  write(repo, "gen/x.ts", "export const g = 1;\n"); // gen/ dir → ignored
  write(repo, "src/note.draft.ts", "export const n = 1;\n"); // nested *.draft.ts → ignored
  write(repo, "src/keep.draft.ts", "export const k = 1;\n"); // negation !keep.draft.ts → INCLUDED
  write(repo, "src/main.ts", "export const m = 1;\n"); // included
  return { repo, stateRoot };
}

test("R-E: .gitignore honors anchored, **/*.glob, nested file rules, and negation", async () => {
  const { repo, stateRoot } = makeIgnoreFixture();
  try {
    const data = await createProjectIndex({ stateRoot }).build(repo);
    const paths = new Set(data.files.map((f) => f.path));
    for (const p of ["ignored-root.ts", "a.log", "deep/inner/b.log", "gen/x.ts", "src/note.draft.ts"]) {
      assert.ok(!paths.has(p), `excluded: ${p}`);
    }
    for (const p of ["src/ignored-root.ts", "src/keep.draft.ts", "src/main.ts"]) {
      assert.ok(paths.has(p), `included: ${p}`);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("R-E/safety: maxFiles cap sets truncated and bounds the file list", async () => {
  const { repo, stateRoot } = makeFixture();
  try {
    const idx = createProjectIndex({ stateRoot, config: { ...projectIndexConfig, maxFiles: 2 } });
    const data = await idx.build(repo);
    assert.equal(data.truncated, true, "hit the maxFiles cap");
    assert.ok(data.files.length <= 2, "file list bounded by maxFiles");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

// ── P0: tsconfig path-alias resolution (F2/A4) ─────────────────────────────────────
test("P0/F2: a tsconfig path alias resolves into the import graph + reverse dependents are found", async () => {
  const repo = mkdtempSync(join(tmpdir(), "ikbi-pi-alias-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "ikbi-pi-alias-state-"));
  try {
    write(repo, "package.json", JSON.stringify({ name: "aliased", scripts: { test: "vitest run" } }));
    write(repo, "tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/lib/*"] } } }));
    write(repo, "src/lib/auth.ts", "export const auth = 1;\n");
    write(repo, "src/app.ts", 'import { auth } from "@lib/auth";\nexport const app = auth;\n');
    const idx = createProjectIndex({ stateRoot });
    const data = await idx.build(repo);

    const edge = data.imports.find((e) => e.from === "src/app.ts" && e.specifier === "@lib/auth");
    assert.ok(edge, "the alias import edge exists");
    assert.equal(edge?.kind, "alias", "tagged as an alias edge");
    assert.equal(edge?.to, "src/lib/auth.ts", "alias @lib/auth resolved to src/lib/auth.ts");
    assert.equal(data.aliases?.present, true);
    assert.equal(data.aliases?.unresolved, 0);

    const callers = await idx.query(repo, { seeds: ["src/lib/auth.ts"], want: "callers" });
    assert.ok(callers.some((r) => r.path === "src/app.ts"), "reverse dependent (importer via alias) is found");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("P0/F2: an alias-shaped import that does not resolve is counted as unresolved (graph hole)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "ikbi-pi-alias2-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "ikbi-pi-alias2-state-"));
  try {
    write(repo, "package.json", JSON.stringify({ name: "aliased" }));
    write(repo, "tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/lib/*"] } } }));
    write(repo, "src/app.ts", 'import { gone } from "@lib/missing";\nexport const app = gone;\n');
    const data = await createProjectIndex({ stateRoot }).build(repo);
    assert.equal(data.aliases?.present, true);
    assert.equal(data.aliases?.unresolved, 1, "the unresolvable alias import is counted");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

// ── P0: test directory mapping (tests/, e2e/, __tests__, *.spec) ────────────────────
test("P0: tests/, e2e/, and *.spec files are mapped to their source", async () => {
  const repo = mkdtempSync(join(tmpdir(), "ikbi-pi-tdir-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "ikbi-pi-tdir-state-"));
  try {
    write(repo, "package.json", JSON.stringify({ name: "tdir", scripts: { test: "vitest run" } }));
    write(repo, "src/auth.ts", "export const auth = 1;\n");
    write(repo, "tests/auth.test.ts", 'import "../src/auth";\n');
    write(repo, "e2e/auth.e2e.ts", 'import "../src/auth";\n');
    write(repo, "src/widget.ts", "export const w = 1;\n");
    write(repo, "src/widget.spec.ts", 'import "./widget";\n');
    const data = await createProjectIndex({ stateRoot }).build(repo);

    assert.ok((data.fileToTests["src/auth.ts"] ?? []).includes("tests/auth.test.ts"), "tests/ dir test mapped");
    assert.ok((data.fileToTests["src/auth.ts"] ?? []).includes("e2e/auth.e2e.ts"), "e2e/ dir test mapped");
    assert.ok((data.fileToTests["src/widget.ts"] ?? []).includes("src/widget.spec.ts"), "*.spec mapped");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

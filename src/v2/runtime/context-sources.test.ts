/**
 * CONTEXT SOURCES — path safety and adopted v1 selection semantics.
 *
 * The confinement tests are the important half: context reads must never leave the
 * repository, and anything unreadable must be represented rather than skipped.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  MAX_ARTIFACT_BYTES,
  PRODUCTION_CONTEXT_SOURCES,
  extractGoalTargets,
  goalTargetFilesSource,
  readConfined,
  repositoryInstructionsSource,
} from "./context-sources.js";

const roots: string[] = [];

function makeRepo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "ikbi-v2-ctx-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const collect = (source: typeof repositoryInstructionsSource, repoPath: string, goal = "do a thing") => source.collect({ goal, repoPath });

// ── path safety ─────────────────────────────────────────────────────────────

test("safety: a traversing path is refused before any I/O", () => {
  const root = makeRepo({ "in.md": "inside" });
  const outcome = readConfined(root, "../etc/passwd");
  assert.ok(!outcome.ok);
  assert.equal(outcome.reason, "outside_repository");
});

test("safety: an absolute path is refused", () => {
  const root = makeRepo();
  const outcome = readConfined(root, "/etc/passwd");
  assert.ok(!outcome.ok);
  assert.equal(outcome.reason, "outside_repository");
});

test("safety: a symlink ESCAPING the repository is refused", () => {
  const outside = makeRepo({ "secret.md": "OUTSIDE-SECRET" });
  const root = makeRepo();
  symlinkSync(join(outside, "secret.md"), join(root, "AGENTS.md"));
  const outcome = readConfined(root, "AGENTS.md");
  assert.ok(!outcome.ok, "the escape was not followed");
  assert.equal(outcome.reason, "outside_repository");
});

test("safety: a symlink staying INSIDE the repository is followed — the stated policy", () => {
  const root = makeRepo({ "docs/real.md": "INSIDE-CONTENT" });
  symlinkSync(join(root, "docs/real.md"), join(root, "AGENTS.md"));
  const outcome = readConfined(root, "AGENTS.md");
  assert.ok(outcome.ok);
  assert.equal(outcome.content, "INSIDE-CONTENT");
});

test("safety: a directory is refused rather than read", () => {
  const root = makeRepo({ "dir/file.md": "x" });
  const outcome = readConfined(root, "dir");
  assert.ok(!outcome.ok);
  assert.equal(outcome.reason, "not_a_regular_file");
});

test("safety: a missing file is represented truthfully", () => {
  const outcome = readConfined(makeRepo(), "AGENTS.md");
  assert.ok(!outcome.ok);
  assert.equal(outcome.reason, "not_found");
});

test("safety: an empty file is reported as empty, not as content", () => {
  const root = makeRepo({ "AGENTS.md": "   \n" });
  const outcome = readConfined(root, "AGENTS.md");
  assert.ok(!outcome.ok);
  assert.equal(outcome.reason, "empty");
});

test("safety: an ordinary in-repo file is accepted and hashed as observed", () => {
  const root = makeRepo({ "AGENTS.md": "hello" });
  const outcome = readConfined(root, "AGENTS.md");
  assert.ok(outcome.ok);
  assert.equal(outcome.content, "hello");
  assert.equal(outcome.sha256, createHash("sha256").update(Buffer.from("hello")).digest("hex"));
});

test("safety: a file over the byte cap is truncated, and says so, but hashes the WHOLE file", () => {
  const body = "y".repeat(MAX_ARTIFACT_BYTES + 500);
  const root = makeRepo({ "AGENTS.md": body });
  const outcome = readConfined(root, "AGENTS.md");
  assert.ok(outcome.ok);
  assert.equal(outcome.truncated, true);
  assert.equal(outcome.originalBytes, body.length);
  assert.ok(outcome.content.length < body.length);
  assert.equal(outcome.sha256, createHash("sha256").update(Buffer.from(body)).digest("hex"), "the digest names the real state, not the bounded copy");
});

// ── repository instructions ─────────────────────────────────────────────────

test("instructions: CLAUDE.md wins over AGENTS.md — first present wins, as v1 does", async () => {
  const root = makeRepo({ "CLAUDE.md": "C", "AGENTS.md": "A" });
  const { candidates } = await collect(repositoryInstructionsSource, root);
  assert.deepEqual(candidates.map((c) => c.path), ["CLAUDE.md"]);
});

test("instructions: AGENTS.md is used when CLAUDE.md is absent", async () => {
  const root = makeRepo({ "AGENTS.md": "A" });
  const { candidates } = await collect(repositoryInstructionsSource, root);
  assert.deepEqual(candidates.map((c) => c.path), ["AGENTS.md"]);
});

test("instructions: the .ikbi set is ADDITIVE, and each file is its own artifact", async () => {
  const root = makeRepo({ "AGENTS.md": "A", "IKBI.md": "I", ".ikbi/project.md": "P" });
  const { candidates } = await collect(repositoryInstructionsSource, root);
  assert.deepEqual(candidates.map((c) => c.path), ["AGENTS.md", "IKBI.md", ".ikbi/project.md"]);
  assert.equal(new Set(candidates.map((c) => c.observedSha256)).size, 3, "each carries its own state binding");
});

test("instructions: a repository with none contributes nothing and reports nothing missing", async () => {
  const { candidates, omissions } = await collect(repositoryInstructionsSource, makeRepo());
  assert.deepEqual(candidates, []);
  assert.deepEqual(omissions, [], "an absent optional instruction file is not an omission worth recording");
});

test("instructions: an escaping symlink IS recorded as an omission", async () => {
  const outside = makeRepo({ "secret.md": "OUTSIDE" });
  const root = makeRepo();
  symlinkSync(join(outside, "secret.md"), join(root, "AGENTS.md"));
  const { candidates, omissions } = await collect(repositoryInstructionsSource, root);
  assert.deepEqual(candidates, []);
  assert.equal(omissions[0]?.reason, "outside_repository");
  assert.equal(omissions[0]?.path, "AGENTS.md");
});

// ── goal targets ────────────────────────────────────────────────────────────

test("targets: goal-named paths are extracted with v1's rules", () => {
  assert.deepEqual(extractGoalTargets("fix src/a.ts and ./b.md"), ["src/a.ts", "b.md"]);
  assert.deepEqual(extractGoalTargets("edit ../outside.ts"), [], "traversal never becomes a target");
  assert.deepEqual(extractGoalTargets("edit /etc/passwd.ts"), [], "absolute never becomes a target");
  assert.deepEqual(extractGoalTargets("look at notes.xyz"), [], "unknown extensions are not targets");
  assert.deepEqual(extractGoalTargets("a.ts a.ts a.ts"), ["a.ts"], "deduplicated");
  assert.equal(extractGoalTargets(Array.from({ length: 30 }, (_, i) => `f${i}.ts`).join(" ")).length, 10, "capped");
});

test("targets: a named file is read and state-bound", async () => {
  const root = makeRepo({ "src/widget.ts": "export const widget = 1;" });
  const { candidates } = await collect(goalTargetFilesSource, root, "make src/widget.ts green");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.path, "src/widget.ts");
  assert.equal(candidates[0]?.category, "target_file");
  assert.equal(candidates[0]?.observedSha256, createHash("sha256").update(Buffer.from("export const widget = 1;")).digest("hex"));
});

test("targets: a named file that does NOT exist is an omission, not silence", async () => {
  const { candidates, omissions } = await collect(goalTargetFilesSource, makeRepo(), "edit src/ghost.ts");
  assert.deepEqual(candidates, []);
  assert.equal(omissions[0]?.reason, "not_found");
  assert.equal(omissions[0]?.path, "src/ghost.ts", "the builder needs to know the goal names a file the repo lacks");
});

test("sources: the production list is exactly the two deterministic contributors", () => {
  assert.deepEqual(PRODUCTION_CONTEXT_SOURCES.map((s) => s.id), ["repository_instructions", "goal_target_files"]);
});

/**
 * CONTEXT SOURCES — reading through the run's source snapshot.
 *
 * V2-006A moved every repository read behind the `SourceSnapshotReader`, so these tests
 * drive the sources against a fake reader. Path confinement, symlink policy and the
 * working-tree/HEAD distinction now belong to the snapshot layer and are tested there.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { DEFAULT_SOURCE_POLICY, type SourceReadOutcome, type SourceSnapshot, type SourceSnapshotReader } from "../core/source.js";
import {
  MAX_ARTIFACT_BYTES,
  PRODUCTION_CONTEXT_SOURCES,
  extractGoalTargets,
  goalTargetFilesSource,
  repositoryInstructionsSource,
} from "./context-sources.js";

const sha = (text: string): string => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

/** A reader over a fixed set of paths. Anything else is missing. */
function readerOf(files: Readonly<Record<string, string>>, over: Readonly<Record<string, SourceReadOutcome>> = {}): SourceSnapshotReader {
  const snapshot = {
    snapshotId: "s".repeat(64) as SourceSnapshot["snapshotId"],
    repositoryRoot: "/repo",
    headCommit: "c".repeat(40),
    headTree: "t".repeat(40),
    clean: true,
    policy: DEFAULT_SOURCE_POLICY,
    entries: [],
    exclusions: [],
    counts: { modified: 0, deleted: 0, untrackedIncluded: 0, excluded: 0 },
    capturedAt: 1,
  } satisfies SourceSnapshot;
  return {
    snapshot,
    read: async (path) => {
      const forced = over[path];
      if (forced !== undefined) return forced;
      const content = files[path];
      if (content === undefined) return { ok: false, reason: "missing", detail: "not in the snapshot" };
      return { ok: true, content, byteLength: Buffer.byteLength(content), contentSha256: sha(content), origin: "snapshot_delta" };
    },
  };
}

const collect = (source: typeof repositoryInstructionsSource, reader: SourceSnapshotReader, goal = "do a thing") =>
  source.collect({ goal, source: reader });

// ── repository instructions ─────────────────────────────────────────────────

test("instructions: CLAUDE.md wins over AGENTS.md — first present wins, as v1 does", async () => {
  const { candidates } = await collect(repositoryInstructionsSource, readerOf({ "CLAUDE.md": "C", "AGENTS.md": "A" }));
  assert.deepEqual(candidates.map((c) => c.path), ["CLAUDE.md"]);
});

test("instructions: AGENTS.md is used when CLAUDE.md is absent", async () => {
  const { candidates } = await collect(repositoryInstructionsSource, readerOf({ "AGENTS.md": "A" }));
  assert.deepEqual(candidates.map((c) => c.path), ["AGENTS.md"]);
});

test("instructions: the .ikbi set is ADDITIVE, and each file is its own artifact", async () => {
  const { candidates } = await collect(repositoryInstructionsSource, readerOf({ "AGENTS.md": "A", "IKBI.md": "I", ".ikbi/project.md": "P" }));
  assert.deepEqual(candidates.map((c) => c.path), ["AGENTS.md", "IKBI.md", ".ikbi/project.md"]);
  assert.equal(new Set(candidates.map((c) => c.observedSha256)).size, 3, "each carries its own state binding");
});

test("instructions: a repository with none contributes nothing and reports nothing missing", async () => {
  const { candidates, omissions } = await collect(repositoryInstructionsSource, readerOf({}));
  assert.deepEqual(candidates, []);
  assert.deepEqual(omissions, [], "an absent optional instruction file is not an omission worth recording");
});

test("instructions: a snapshot read failure IS recorded as an omission", async () => {
  const reader = readerOf({}, { "AGENTS.md": { ok: false, reason: "not_a_regular_file", detail: "the snapshot has a symlink here" } });
  const { candidates, omissions } = await collect(repositoryInstructionsSource, reader);
  assert.deepEqual(candidates, []);
  assert.equal(omissions[0]?.reason, "not_a_regular_file");
  assert.equal(omissions[0]?.path, "AGENTS.md");
});

test("instructions: a file over the byte cap is truncated, and still hashes the WHOLE state", async () => {
  const body = "y".repeat(MAX_ARTIFACT_BYTES + 500);
  const { candidates } = await collect(repositoryInstructionsSource, readerOf({ "AGENTS.md": body }));
  assert.equal(candidates[0]?.truncated, true);
  assert.equal(candidates[0]?.originalBytes, body.length);
  assert.ok((candidates[0]?.content.length ?? 0) < body.length);
  assert.equal(candidates[0]?.observedSha256, sha(body), "the digest names the snapshot's state, not the bounded copy");
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
  const { candidates } = await collect(goalTargetFilesSource, readerOf({ "src/widget.ts": "export const widget = 1;" }), "make src/widget.ts green");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.path, "src/widget.ts");
  assert.equal(candidates[0]?.category, "target_file");
  assert.equal(candidates[0]?.observedSha256, sha("export const widget = 1;"));
});

test("targets: a named file that does NOT exist is an omission, not silence", async () => {
  const { candidates, omissions } = await collect(goalTargetFilesSource, readerOf({}), "edit src/ghost.ts");
  assert.deepEqual(candidates, []);
  assert.equal(omissions[0]?.reason, "not_found");
  assert.equal(omissions[0]?.path, "src/ghost.ts", "the builder needs to know the goal names a file the repo lacks");
});

test("sources: the production list is exactly the two deterministic contributors", () => {
  assert.deepEqual(PRODUCTION_CONTEXT_SOURCES.map((s) => s.id), ["repository_instructions", "goal_target_files"]);
});

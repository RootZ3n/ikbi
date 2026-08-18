/**
 * THE RETRIEVAL CONTEXT SOURCE — what it offers, what it refuses, and what it reports.
 *
 * Hermetic: a fake `SourceSnapshotReader` stands in for the snapshot, so these tests pin
 * the SOURCE's behaviour (enumeration, exclusion, truncation, deduplication, reporting)
 * without a repository. Ranking itself is pinned in `core/retrieval.test.ts`.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { DEFAULT_RETRIEVAL_BUDGET } from "../core/retrieval.js";
import { MAX_RETRIEVED_ARTIFACT_BYTES, RETRIEVAL_SOURCE_ID, createRetrievalSource } from "./retrieval-source.js";
import type { SourceSnapshot, SourceSnapshotReader } from "../core/source.js";
import type { V2SnapshotDigest } from "../core/identity.js";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A reader over an in-memory file map. `list()` returns exactly its keys. */
function readerOf(files: Readonly<Record<string, string>>, snapshotId = "snapshot_" + "a".repeat(64)): SourceSnapshotReader {
  const snapshot = {
    snapshotId: snapshotId as V2SnapshotDigest,
    repositoryRoot: "/nowhere",
    headCommit: "0".repeat(40),
    headTree: "1".repeat(40),
    clean: true,
    policy: { includeTrackedModifications: true, includeTrackedDeletions: true, includeUntracked: true, includeIgnored: false },
    entries: [],
    exclusions: [],
    counts: { modified: 0, deleted: 0, untrackedIncluded: 0, excluded: 0 },
    capturedAt: 0,
  } satisfies SourceSnapshot;

  return {
    snapshot,
    list: async () => Object.keys(files).sort(),
    read: async (path) => {
      const content = files[path];
      if (content === undefined) return { ok: false, reason: "missing", detail: "not in this snapshot" };
      return { ok: true, content, byteLength: Buffer.byteLength(content), contentSha256: sha(content), origin: "head_blob" };
    },
  };
}

const collect = (files: Readonly<Record<string, string>>, goal: string, alreadyOffered: readonly string[] = []) => {
  const source = createRetrievalSource();
  return source.collect({ goal, source: readerOf(files), alreadyOffered }).then((result) => ({ ...result, report: source.lastResult() }));
};

// ── discovery ───────────────────────────────────────────────────────────────

test("retrieval source: a goal naming NO file still yields repository evidence", async () => {
  const { candidates } = await collect(
    { "src/session-token.ts": "export function refreshSessionToken() {}\n", "src/colours.ts": "export const red = 1;\n" },
    "make the session token refresh correctly",
  );
  assert.deepEqual(candidates.map((c) => c.path), ["src/session-token.ts"]);
});

test("retrieval source: every candidate lands in the LOWEST priority band", async () => {
  const { candidates } = await collect({ "src/session.ts": "session\n" }, "fix session");
  assert.deepEqual([...new Set(candidates.map((c) => c.category))], ["retrieved_repository_evidence"]);
  assert.deepEqual([...new Set(candidates.map((c) => c.sourceId))], [RETRIEVAL_SOURCE_ID]);
});

test("retrieval source: a candidate states WHY it was retrieved, with its rank and score", async () => {
  const { candidates } = await collect({ "src/session.ts": "session\n" }, "fix session");
  assert.match(candidates[0]!.reason, /^retrieved \(rank 1, score \d+\): .*filename-matches-term/);
});

test("retrieval source: a goal with no usable terms retrieves NOTHING rather than guessing", async () => {
  const { candidates, report } = await collect({ "src/a.ts": "x\n", "src/b.ts": "y\n" }, "do it");
  assert.deepEqual(candidates, [], "offering arbitrary files would be noise dressed as evidence");
  assert.equal(report?.examinedCount, 0, "and nothing was even read");
});

// ── the snapshot is the only source of truth ────────────────────────────────

test("retrieval source: it enumerates ONLY what the snapshot lists", async () => {
  // A file the reader can serve but does not list is not part of this run's source.
  const listed = { "src/session.ts": "session\n" };
  const source = createRetrievalSource();
  const reader = readerOf(listed);
  const narrowed: SourceSnapshotReader = { ...reader, list: async () => [] };
  const { candidates } = await source.collect({ goal: "fix session", source: narrowed, alreadyOffered: [] });
  assert.deepEqual(candidates, [], "enumeration is the snapshot's answer, not the filesystem's");
});

test("retrieval source: an unreadable path is recorded, never silently skipped", async () => {
  const source = createRetrievalSource();
  const reader = readerOf({ "src/session.ts": "session\n" });
  const lying: SourceSnapshotReader = { ...reader, list: async () => ["src/session.ts", "src/ghost.ts"] };
  await source.collect({ goal: "fix session", source: lying, alreadyOffered: [] });
  const report = source.lastResult()!;
  assert.deepEqual(
    report.exclusions.filter((e) => e.path === "src/ghost.ts"),
    [{ path: "src/ghost.ts", reason: "unreadable_in_snapshot" }],
  );
});

// ── exclusions ──────────────────────────────────────────────────────────────

test("retrieval source: lockfiles and vendored trees are excluded WITH a reason", async () => {
  const { candidates, report } = await collect(
    {
      "src/session.ts": "session\n",
      "pnpm-lock.yaml": "session: 1\n",
      "node_modules/session/index.js": "session\n",
    },
    "fix session",
  );
  assert.deepEqual(candidates.map((c) => c.path), ["src/session.ts"]);
  assert.deepEqual(
    report!.exclusions.map((e) => `${e.path}:${e.reason}`).sort(),
    ["node_modules/session/index.js:vendored", "pnpm-lock.yaml:lockfile"],
  );
});

test("retrieval source: a binary file is excluded even with a source-looking extension", async () => {
  const { candidates, report } = await collect({ "src/session.ts": "sess\0ion\n" }, "fix session");
  assert.deepEqual(candidates, []);
  assert.deepEqual(report!.exclusions, [{ path: "src/session.ts", reason: "binary" }]);
});

// ── truncation ──────────────────────────────────────────────────────────────

test("retrieval source: a large file is truncated but its digest still covers the WHOLE file", async () => {
  const body = `// session\n${"x".repeat(MAX_RETRIEVED_ARTIFACT_BYTES * 2)}`;
  const { candidates } = await collect({ "src/session.ts": body }, "fix session");
  const candidate = candidates[0]!;
  assert.equal(candidate.truncated, true);
  assert.ok(Buffer.byteLength(candidate.content) <= MAX_RETRIEVED_ARTIFACT_BYTES);
  assert.equal(candidate.originalBytes, Buffer.byteLength(body), "the true size is reported, not the truncated one");
  assert.equal(candidate.observedSha256, sha(body), "the state binding is to the file, not to the excerpt");
});

// ── deduplication ───────────────────────────────────────────────────────────

test("retrieval source: a file a higher band already carries is suppressed and REPORTED", async () => {
  const { candidates, omissions, report } = await collect(
    { "src/session.ts": "session\n", "src/session-helper.ts": "session\n" },
    "fix session",
    ["src/session.ts"],
  );
  assert.deepEqual(candidates.map((c) => c.path), ["src/session-helper.ts"]);
  assert.deepEqual(omissions.map((o) => `${o.path}:${o.reason}`), ["src/session.ts:duplicate"]);
  assert.deepEqual(report!.duplicatesSuppressed, ["src/session.ts"]);
});

test("retrieval source: suppressing a duplicate FREES its slot for the next best file", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 10; i += 1) files[`src/session-${i}.ts`] = "session\n";
  const source = createRetrievalSource({ ...DEFAULT_RETRIEVAL_BUDGET, maxCandidates: 3 });
  const { candidates } = await source.collect({
    goal: "fix session",
    source: readerOf(files),
    alreadyOffered: ["src/session-0.ts", "src/session-1.ts"],
  });
  assert.equal(candidates.length, 3, "still three, not one");
  assert.equal(candidates.some((c) => c.path === "src/session-0.ts"), false);
});

test("retrieval source: offered ranks are renumbered 1..n over what actually shipped", async () => {
  const { candidates } = await collect({ "src/session-a.ts": "session\n", "src/session-b.ts": "session\n" }, "fix session", [
    "src/session-a.ts",
  ]);
  assert.match(candidates[0]!.reason, /rank 1,/, "rank 1 names the best thing this source contributed");
});

// ── reporting ───────────────────────────────────────────────────────────────

test("retrieval source: the report accounts for everything examined, matched and offered", async () => {
  const { report } = await collect(
    { "src/session.ts": "session\n", "src/other.ts": "unrelated\n", "logo.png": "binary-ish\n" },
    "fix session",
  );
  assert.equal(report!.examinedCount, 3, "every listed path is accounted for");
  assert.equal(report!.matchedCount, 1);
  assert.equal(report!.candidates.length, 1);
  assert.equal(report!.exclusions.length, 1, "the png never became a candidate or a match");
  assert.equal(report!.sourceSnapshotId, "snapshot_" + "a".repeat(64), "bound to the snapshot it searched");
});

test("retrieval source: a fresh instance reports NOTHING until it has collected", () => {
  assert.equal(createRetrievalSource().lastResult(), undefined, "no retrieval may be claimed before one happens");
});

test("retrieval source: two instances never report each other's retrieval", async () => {
  const a = createRetrievalSource();
  const b = createRetrievalSource();
  await a.collect({ goal: "fix session", source: readerOf({ "src/session.ts": "session\n" }), alreadyOffered: [] });
  assert.notEqual(a.lastResult(), undefined);
  assert.equal(b.lastResult(), undefined, "state is per instance, never module-global");
});

test("retrieval source: the same snapshot and goal produce the same retrieval identity", async () => {
  const files = { "src/session.ts": "session\n", "src/session-two.ts": "session\n" };
  const first = await collect(files, "fix session");
  const second = await collect(files, "fix session");
  assert.equal(first.report!.retrievalId, second.report!.retrievalId);
  assert.deepEqual(first.candidates, second.candidates);
});

test("retrieval source: a CHANGED file changes the retrieval identity", async () => {
  const a = await collect({ "src/session.ts": "session\n" }, "fix session");
  const b = await collect({ "src/session.ts": "session // edited\n" }, "fix session");
  assert.notEqual(a.report!.retrievalId, b.report!.retrievalId, "the ranking is bound to the bytes it saw");
});

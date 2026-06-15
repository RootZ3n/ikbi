/**
 * Phase 2 — Operator Experience: tests for the new failure-detail + next-hints + diff-breakdown
 * utilities added to cli.ts. These are all PURE functions; no real orchestrator is invoked.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkerResult } from "./contract.js";
import { formatFailureDetail, formatNextHints, parseFileDiff } from "./cli.js";

// ── parseFileDiff ─────────────────────────────────────────────────────────────

const SAMPLE_DIFF = [
  "diff --git a/src/add.ts b/src/add.ts",
  "--- a/src/add.ts",
  "+++ b/src/add.ts",
  "@@ -1,2 +1,3 @@",
  "-export const add = (a, b) => a - b;",
  "+export const add = (a, b) => a + b;",
  "+// fixed",
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n");

test("parseFileDiff extracts per-file insertions and deletions", () => {
  const files = parseFileDiff(SAMPLE_DIFF);
  assert.equal(files.length, 2, "two files");
  assert.equal(files[0]!.file, "src/add.ts");
  assert.equal(files[0]!.insertions, 2, "+add+comment");
  assert.equal(files[0]!.deletions, 1, "-old-add");
  assert.equal(files[1]!.file, "README.md");
  assert.equal(files[1]!.insertions, 1);
  assert.equal(files[1]!.deletions, 1);
});

test("parseFileDiff: empty diff returns empty array", () => {
  assert.deepEqual(parseFileDiff(""), []);
  assert.deepEqual(parseFileDiff("   \n"), []);
});

test("parseFileDiff: single file no changes returns zero counts", () => {
  const files = parseFileDiff("diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n");
  assert.equal(files.length, 1);
  assert.equal(files[0]!.insertions, 0);
  assert.equal(files[0]!.deletions, 0);
});

test("parseFileDiff: does not count +++ / --- file headers as content lines", () => {
  const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n+real line\n";
  const files = parseFileDiff(diff);
  assert.equal(files[0]!.insertions, 1, "only the real +line is counted");
  assert.equal(files[0]!.deletions, 0);
});

// ── formatFailureDetail ───────────────────────────────────────────────────────

function failed(overrides: Partial<WorkerResult> & { roles?: WorkerResult["roles"] }): WorkerResult {
  return {
    contractVersion: "1.0.0",
    taskId: "build-1234",
    outcome: "failure",
    roles: [],
    promoted: false,
    ...overrides,
  };
}

test("formatFailureDetail: returns empty string for a success result", () => {
  const r = failed({ outcome: "success", promoted: true });
  assert.equal(formatFailureDetail(r), "");
});

test("formatFailureDetail: reports which role failed", () => {
  const r = failed({
    roles: [
      { role: "scout", outcome: "success" },
      { role: "verifier", outcome: "failure", summary: "tests blew up" },
    ],
  });
  const out = formatFailureDetail(r);
  assert.match(out, /Build FAILED — verifier/);
  assert.match(out, /Reason: tests blew up/);
});

test("formatFailureDetail: verifier failure lists failed checks (not passing ones)", () => {
  const r = failed({
    roles: [
      {
        role: "verifier",
        outcome: "failure",
        summary: "checks failed",
        detail: {
          checks: [
            { name: "jest-test", passed: false },
            { name: "eslint", passed: true },
          ],
        },
      },
    ],
  });
  const out = formatFailureDetail(r);
  assert.match(out, /Checks failed: jest-test/);
  assert.doesNotMatch(out, /eslint/, "passing checks are not listed");
});

test("formatFailureDetail: verifier blockReasons surface when present", () => {
  const r = failed({
    roles: [
      {
        role: "verifier",
        outcome: "failure",
        summary: "blocked",
        detail: { blockReasons: ["no test runner found", "missing config"] },
      },
    ],
  });
  const out = formatFailureDetail(r);
  assert.match(out, /Blocked: no test runner found; missing config/);
});

test("formatFailureDetail: builder failure lists files touched", () => {
  const r = failed({
    roles: [
      {
        role: "builder",
        outcome: "failure",
        summary: "builder bailed",
        detail: { filesWritten: ["src/a.ts", "src/b.ts"] },
      },
    ],
  });
  const out = formatFailureDetail(r);
  assert.match(out, /Build FAILED — builder/);
  assert.match(out, /Files touched: src\/a\.ts, src\/b\.ts/);
});

test("formatFailureDetail: shows workspace id when present", () => {
  const r = failed({ workspaceId: "ws-abc123" });
  const out = formatFailureDetail(r);
  assert.match(out, /Workspace: ws-abc123/);
  assert.match(out, /ikbi diff ws-abc123/);
});

test("formatFailureDetail: says undo not available for non-promoted builds", () => {
  const r = failed({ promoted: false });
  assert.match(formatFailureDetail(r), /Undo available: no/);
});

test("formatFailureDetail: says undo available when promoted", () => {
  // Unusual case (failure + promoted = false normally) but test the branch anyway
  const r = failed({ promoted: true });
  assert.match(formatFailureDetail(r), /Undo available: yes/);
});

test("formatFailureDetail: rejected outcome labels correctly", () => {
  const r = failed({ outcome: "rejected" });
  assert.match(formatFailureDetail(r), /Build REJECTED/);
});

test("formatFailureDetail: partial outcome labels correctly", () => {
  const r = failed({ outcome: "partial" });
  assert.match(formatFailureDetail(r), /Build PARTIAL/);
});

// ── formatNextHints ───────────────────────────────────────────────────────────

function result(overrides: Partial<WorkerResult>): WorkerResult {
  return {
    contractVersion: "1.0.0",
    taskId: "build-9999",
    outcome: "success",
    roles: [],
    promoted: false,
    ...overrides,
  };
}

test("formatNextHints: returns empty string when there are no actionable hints", () => {
  // No workspace, success but no promotion (unusual) — nothing specific to suggest.
  const r = result({ outcome: "success", promoted: false });
  // promoted=false + no workspace → diff + discard hints don't fire, undo doesn't fire.
  // receipts hint fires only for non-success. So: empty.
  assert.equal(formatNextHints(r), "");
});

test("formatNextHints: success + promoted suggests undo and diff", () => {
  const r = result({ outcome: "success", promoted: true, workspaceId: "ws-xyz" });
  const out = formatNextHints(r);
  assert.match(out, /Next:/);
  assert.match(out, /ikbi undo build-9999/);
  assert.match(out, /ikbi diff ws-xyz/);
});

test("formatNextHints: failure + workspace suggests diff + discard + receipts", () => {
  const r = result({ outcome: "failure", promoted: false, workspaceId: "ws-abc" });
  const out = formatNextHints(r);
  assert.match(out, /ikbi diff ws-abc/);
  assert.match(out, /ikbi workspace discard ws-abc/);
  assert.match(out, /ikbi receipts --task build-9999/);
});

test("formatNextHints: failure without workspace still suggests receipts", () => {
  const r = result({ outcome: "failure", promoted: false });
  const out = formatNextHints(r);
  assert.match(out, /ikbi receipts --task build-9999/);
  assert.doesNotMatch(out, /ikbi diff/, "no diff hint without a workspace");
});

test("formatNextHints: success + not promoted suggests diff + discard (gate-denied-like)", () => {
  // e.g., build succeeded internally but user toggled off promotion in code
  const r = result({ outcome: "success", promoted: false, workspaceId: "ws-gate" });
  const out = formatNextHints(r);
  assert.match(out, /ikbi diff ws-gate/);
  assert.match(out, /ikbi workspace discard ws-gate/);
  assert.doesNotMatch(out, /ikbi undo/, "no undo hint when not promoted");
});

test("formatNextHints: the — separator appears at the same column in every hint line", () => {
  const r = result({ outcome: "failure", promoted: false, workspaceId: "ws-short" });
  const lines = formatNextHints(r).split("\n").filter((l) => l.startsWith("  ikbi"));
  // The padEnd means the "—" appears at the same position on every line.
  const dashPositions = lines.map((l) => l.indexOf("—"));
  assert.ok(dashPositions.length > 0, "at least one hint line");
  const pos0 = dashPositions[0]!;
  assert.ok(dashPositions.every((p) => p === pos0), `— appears at column ${String(pos0)} on all lines`);
});

/**
 * SG-2 (audit): `ikbi diff <workspace-id>` prints a workspace's git diff + a change summary,
 * and a build prints a one-line diff summary after it completes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkspaceHandle, WorkspaceRecord } from "../../core/workspace/contract.js";
import { createDiffCli, formatDiffSummary, summarizeDiff } from "./cli.js";

const SAMPLE_DIFF = [
  "diff --git a/src/add.ts b/src/add.ts",
  "--- a/src/add.ts",
  "+++ b/src/add.ts",
  "@@ -1,2 +1,3 @@",
  "-export const add = (a, b) => a - b;",
  "+export const add = (a, b) => a + b;",
  "+// fixed the operator",
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n");

function rec(id: string): WorkspaceRecord {
  return { id, targetRepo: "/repo", baseBranch: "main", baseRef: "base", scratchBranch: `ikbi/ws/${id}`, path: `/wt/${id}`, identity: { agentId: "w" }, state: "promoted", createdAt: 0, updatedAt: 0 };
}

function capture() {
  let out = "";
  let err = "";
  let exit: number | undefined;
  return { stdout: (s: string) => void (out += s), stderr: (s: string) => void (err += s), setExit: (c: number) => void (exit = c), get out() { return out; }, get err() { return err; }, get exit() { return exit; } };
}

// ── summarizeDiff (pure) ──────────────────────────────────────────────────────

test("summarizeDiff counts files + insertions/deletions (ignoring +++/--- headers)", () => {
  const s = summarizeDiff(SAMPLE_DIFF);
  assert.equal(s.files, 2, "two files changed");
  assert.equal(s.insertions, 3, "+add fix, +comment, +new");
  assert.equal(s.deletions, 2, "-old add, -old README");
  assert.equal(formatDiffSummary(s), "Δ 2 files changed, +3/-2");
});

test("summarizeDiff: a single-file change pluralizes correctly", () => {
  assert.equal(formatDiffSummary(summarizeDiff("diff --git a/x b/x\n+a\n")), "Δ 1 file changed, +1/-0");
});

// ── the diff command ──────────────────────────────────────────────────────────

test("`ikbi diff <id>` prints the workspace diff AND a change summary", async () => {
  const cap = capture();
  let askedHandle: WorkspaceHandle | undefined;
  const workspaces = {
    get: async (id: string) => (id === "ws-good" ? rec("ws-good") : undefined),
    diff: async (h: WorkspaceHandle) => { askedHandle = h; return SAMPLE_DIFF; },
  };
  const cli = createDiffCli({ workspaces, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit });
  await cli.diff(["ws-good"]);

  assert.equal(cap.exit, undefined, "a found workspace exits 0");
  assert.match(cap.out, /export const add = \(a, b\) => a \+ b;/, "the actual changes are shown");
  assert.match(cap.out, /Δ 2 files changed, \+3\/-2/, "the one-line summary is appended");
  assert.equal(askedHandle?.id, "ws-good", "diffed the requested workspace");
});

test("`ikbi diff` fails closed on a missing id or unknown workspace", async () => {
  const workspaces = { get: async () => undefined, diff: async () => "" };

  const noId = capture();
  await createDiffCli({ workspaces, stdout: noId.stdout, stderr: noId.stderr, setExit: noId.setExit }).diff([]);
  assert.equal(noId.exit, 1);
  assert.match(noId.err, /workspace id is required/);

  const unknown = capture();
  await createDiffCli({ workspaces, stdout: unknown.stdout, stderr: unknown.stderr, setExit: unknown.setExit }).diff(["nope"]);
  assert.equal(unknown.exit, 1);
  assert.match(unknown.err, /no workspace "nope" found/);
});

test("`ikbi diff` reports cleanly when the workspace has no changes", async () => {
  const cap = capture();
  const workspaces = { get: async (id: string) => rec(id), diff: async () => "   \n" };
  await createDiffCli({ workspaces, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).diff(["ws-empty"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /workspace ws-empty: no changes/);
});

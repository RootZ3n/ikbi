/**
 * Phase 2 — diff improvements: per-file breakdown and workspace state in `ikbi diff`.
 * (The original diff-cli.test.ts tests are NOT modified — only additive here.)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkspaceRecord } from "../../core/workspace/contract.js";
import { createDiffCli } from "./cli.js";

const SAMPLE_DIFF = [
  "diff --git a/src/add.ts b/src/add.ts",
  "--- a/src/add.ts",
  "+++ b/src/add.ts",
  "@@ -1,2 +1,3 @@",
  "-old line",
  "+new line one",
  "+new line two",
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1 @@",
  "-old readme",
  "+new readme",
].join("\n");

function rec(id: string, state: WorkspaceRecord["state"] = "promoted"): WorkspaceRecord {
  return {
    id, targetRepo: "/repo", baseBranch: "main", baseRef: "base",
    scratchBranch: `ikbi/ws/${id}`, path: `/wt/${id}`,
    identity: { agentId: "w" }, state, createdAt: 0, updatedAt: 0,
  };
}

function capture() {
  let out = "";
  let err = "";
  let exit: number | undefined;
  return {
    stdout: (s: string) => void (out += s),
    stderr: (s: string) => void (err += s),
    setExit: (c: number) => void (exit = c),
    get out() { return out; },
    get err() { return err; },
    get exit() { return exit; },
  };
}

// ── per-file breakdown ────────────────────────────────────────────────────────

test("`ikbi diff` shows a per-file +/- breakdown after the summary line", async () => {
  const cap = capture();
  const workspaces = {
    get: async (id: string) => rec(id),
    diff: async () => SAMPLE_DIFF,
  };
  const cli = createDiffCli({ workspaces, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, colorize: false });
  await cli.diff(["ws-test"]);

  assert.equal(cap.exit, undefined);
  // The existing Δ summary line is still present
  assert.match(cap.out, /Δ 2 files changed/);
  // Per-file breakdown
  assert.match(cap.out, /src\/add\.ts/, "first file listed");
  assert.match(cap.out, /README\.md/, "second file listed");
  // Check the +/- counts appear (exact positions may vary due to padding)
  assert.match(cap.out, /\+2\/-1/, "src/add.ts counts: +2 lines added, -1 removed");
  assert.match(cap.out, /\+1\/-1/, "README.md counts");
});

// ── workspace state ───────────────────────────────────────────────────────────

test("`ikbi diff` shows workspace state for a promoted workspace", async () => {
  const cap = capture();
  const workspaces = { get: async (id: string) => rec(id, "promoted"), diff: async () => SAMPLE_DIFF };
  const cli = createDiffCli({ workspaces, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, colorize: false });
  await cli.diff(["ws-promo"]);
  assert.match(cap.out, /Workspace ws-promo:.*promoted/);
});

test("`ikbi diff` shows workspace state for a failed (retained) workspace", async () => {
  const cap = capture();
  const workspaces = { get: async (id: string) => rec(id, "failed"), diff: async () => SAMPLE_DIFF };
  const cli = createDiffCli({ workspaces, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, colorize: false });
  await cli.diff(["ws-fail"]);
  assert.match(cap.out, /Workspace ws-fail:.*failed/);
});

test("`ikbi diff` shows state even for a workspace with no changes", async () => {
  const cap = capture();
  const workspaces = { get: async (id: string) => rec(id, "allocated"), diff: async () => "   \n" };
  const cli = createDiffCli({ workspaces, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, colorize: false });
  await cli.diff(["ws-empty"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /no changes/);
  assert.match(cap.out, /State:.*in-progress/);
});

test("`ikbi diff` shows workspace state for a discarded workspace", async () => {
  const cap = capture();
  const workspaces = { get: async (id: string) => rec(id, "discarded"), diff: async () => SAMPLE_DIFF };
  const cli = createDiffCli({ workspaces, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, colorize: false });
  await cli.diff(["ws-gone"]);
  assert.match(cap.out, /Workspace ws-gone:.*discarded/);
});

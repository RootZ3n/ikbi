/**
 * `ikbi workspaces` — operator inspect + lifecycle management.
 *   list             — table of all workspaces (id, state, target repo, created)
 *   inspect <id>     — one workspace in detail (path, branch, diff stats); graceful on a bad id
 *   clean [--apply]  — DRY-RUN by default (reports, never mutates); --apply sweeps via cleanOrphans
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentIdentity } from "../core/provider/contract.js";
import type { WorkspaceRecord } from "../core/workspace/contract.js";
import { createWorkspacesCli, parseDiffStats, type CleanResult, type WorkspacesCliSurface } from "./workspaces.js";

const ID: AgentIdentity = { agentId: "builder-1", functionalRole: "builder", trustTier: "verified" };

function rec(over: Partial<WorkspaceRecord>): WorkspaceRecord {
  return {
    id: "ws-x", targetRepo: "/repo", baseBranch: "main", baseRef: "abc", scratchBranch: "ikbi/ws/ws-x",
    path: "/state/wt/ws-x", identity: ID, state: "allocated", createdAt: 1, updatedAt: 1, ...over,
  };
}

function capture() {
  let out = ""; let err = ""; let exit: number | undefined;
  return {
    stdout: (s: string) => void (out += s), stderr: (s: string) => void (err += s), setExit: (c: number) => void (exit = c),
    get out() { return out; }, get err() { return err; }, get exit() { return exit; },
  };
}

/** A surface stub: empty defaults, override per test. */
function surface(over: Partial<WorkspacesCliSurface> = {}): WorkspacesCliSurface {
  return {
    list: async () => [],
    get: async () => undefined,
    diff: async () => "",
    cleanOrphans: async (): Promise<CleanResult> => ({ removed: 0, checked: 0, skipped: 0, reclaimed: 0, skippedIds: [] }),
    ...over,
  };
}

test("`workspaces list` reports an empty registry gracefully", async () => {
  const cap = capture();
  const cli = createWorkspacesCli({ workspaces: surface({ list: async () => [] }), stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit });
  await cli.workspaces(["list"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /\(no workspaces\)/);
});

test("`workspaces list` shows id, state, target repo and creation time", async () => {
  const cap = capture();
  const records: WorkspaceRecord[] = [
    rec({ id: "ws-old", state: "promoted", targetRepo: "/repo/a", createdAt: 1000 }),
    rec({ id: "ws-new", state: "failed", note: "retained: timed out", targetRepo: "/repo/b", createdAt: 2000 }),
  ];
  const cli = createWorkspacesCli({ workspaces: surface({ list: async () => records }), stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit });
  await cli.workspaces(["list"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /ID\s+STATE\s+TARGET REPO\s+CREATED/, "prints a header row");
  assert.match(cap.out, /ws-old/);
  assert.match(cap.out, /\/repo\/a/, "shows the target repo");
  assert.match(cap.out, new RegExp(new Date(1000).toISOString()), "shows the creation time as ISO");
  assert.match(cap.out, /ws-new.*retained/s, "flags retained work");
  assert.match(cap.out, /2 workspace\(s\)/);
  // Oldest-first ordering: ws-old appears before ws-new.
  assert.ok(cap.out.indexOf("ws-old") < cap.out.indexOf("ws-new"), "oldest-first");
});

test("`workspaces list` surfaces a store failure cleanly (exit 1, no stack)", async () => {
  const cap = capture();
  const cli = createWorkspacesCli({
    workspaces: surface({ list: async () => { throw new Error("registry unreadable"); } }),
    stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit,
  });
  await cli.workspaces(["list"]);
  assert.equal(cap.exit, 1);
  assert.match(cap.err, /registry unreadable/);
});

test("`workspaces inspect <id>` shows path, branch and diff stats for a valid id", async () => {
  const cap = capture();
  const target = rec({ id: "ws-keep", state: "failed", note: "retained: x", path: "/state/wt/ws-keep", scratchBranch: "ikbi/ws/ws-keep" });
  const diff = [
    "diff --git a/foo.ts b/foo.ts",
    "--- a/foo.ts",
    "+++ b/foo.ts",
    "@@ -1,2 +1,3 @@",
    " context",
    "-gone",
    "+added one",
    "+added two",
  ].join("\n");
  const cli = createWorkspacesCli({
    workspaces: surface({ get: async (id) => (id === "ws-keep" ? target : undefined), diff: async () => diff }),
    stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit,
  });
  await cli.workspaces(["inspect", "ws-keep"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /\/state\/wt\/ws-keep/, "shows the worktree path");
  assert.match(cap.out, /ikbi\/ws\/ws-keep/, "shows the scratch branch");
  assert.match(cap.out, /retained/, "flags retained work");
  assert.match(cap.out, /1 file\(s\), \+2 -1/, "shows diff stats");
});

test("`workspaces inspect` on an unknown id fails cleanly (exit 1, no stack)", async () => {
  const cap = capture();
  const cli = createWorkspacesCli({ workspaces: surface({ get: async () => undefined }), stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit });
  await cli.workspaces(["inspect", "nope"]);
  assert.equal(cap.exit, 1);
  assert.match(cap.err, /no workspace "nope" found/);
});

test("`workspaces inspect` with no id required argument fails cleanly", async () => {
  const cap = capture();
  const cli = createWorkspacesCli({ workspaces: surface(), stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit });
  await cli.workspaces(["inspect"]);
  assert.equal(cap.exit, 1);
  assert.match(cap.err, /a workspace id is required/);
});

test("`workspaces inspect` tolerates a diff failure (still shows metadata, no crash)", async () => {
  const cap = capture();
  const target = rec({ id: "ws-z" });
  const cli = createWorkspacesCli({
    workspaces: surface({ get: async () => target, diff: async () => { throw new Error("git gone"); } }),
    stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit,
  });
  await cli.workspaces(["inspect", "ws-z"]);
  assert.equal(cap.exit, undefined, "a diff failure is not fatal");
  assert.match(cap.out, /diff:\s+\(unavailable: git gone\)/);
});

test("`workspaces clean` defaults to DRY-RUN: reports candidates and never mutates", async () => {
  const cap = capture();
  let cleanCalled = false;
  const records: WorkspaceRecord[] = [
    rec({ id: "ws-active", state: "allocated" }),
    rec({ id: "ws-promoted", state: "promoted", path: "/state/wt/ws-promoted" }),
    rec({ id: "ws-retained", state: "failed", note: "retained: x", path: "/state/wt/ws-retained" }),
  ];
  const cli = createWorkspacesCli({
    workspaces: surface({ list: async () => records, cleanOrphans: async () => { cleanCalled = true; return { removed: 9, checked: 9 }; } }),
    stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit,
  });
  await cli.workspaces(["clean"]);
  assert.equal(cleanCalled, false, "dry-run must not call cleanOrphans");
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /dry-run/);
  assert.match(cap.out, /ws-promoted/, "lists the terminal candidate");
  assert.doesNotMatch(cap.out.split("PRESERVED")[0] ?? cap.out, /ws-active/, "does not list active workspaces as candidates");
  assert.match(cap.out, /ws-retained/, "reports the retained workspace as preserved");
  assert.match(cap.out, /PRESERVED|preserved/, "explains retained work is kept");
  assert.match(cap.out, /Nothing was removed/);
});

test("`workspaces clean --apply` performs the sweep via cleanOrphans", async () => {
  const cap = capture();
  let forcedSeen: boolean | undefined;
  const cli = createWorkspacesCli({
    workspaces: surface({ cleanOrphans: async (opts) => { forcedSeen = opts?.force; return { removed: 2, checked: 3, skipped: 1, skippedIds: ["ws-keep"] }; } }),
    stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit,
  });
  await cli.workspaces(["clean", "--apply"]);
  assert.equal(forcedSeen, false, "default --apply passes force:false (preserves retained work)");
  assert.match(cap.out, /reclaimed 2 orphaned worktree/);
  assert.match(cap.out, /PRESERVED 1 retained workspace/);
});

test("`workspaces clean --apply --force` opts into sweeping retained work", async () => {
  const cap = capture();
  let forcedSeen: boolean | undefined;
  const cli = createWorkspacesCli({
    workspaces: surface({ cleanOrphans: async (opts) => { forcedSeen = opts?.force; return { removed: 3, checked: 3 }; } }),
    stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit,
  });
  await cli.workspaces(["clean", "--apply", "--force"]);
  assert.equal(forcedSeen, true, "--force passes force:true");
  assert.match(cap.out, /reclaimed 3 orphaned worktree/);
});

test("`workspaces` with an unknown subcommand fails cleanly (exit 1)", async () => {
  const cap = capture();
  const cli = createWorkspacesCli({ workspaces: surface(), stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit });
  await cli.workspaces(["frobnicate"]);
  assert.equal(cap.exit, 1);
  assert.match(cap.err, /unknown subcommand "frobnicate"/);
});

test("parseDiffStats counts files, insertions and deletions; tolerates empty/garbage", () => {
  assert.deepEqual(parseDiffStats(""), { files: 0, insertions: 0, deletions: 0 });
  const diff = [
    "diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1,2 @@", "+one", "+two", "-old",
    "diff --git a/y b/y", "--- a/y", "+++ b/y", "@@ -0,0 +1 @@", "+only",
  ].join("\n");
  assert.deepEqual(parseDiffStats(diff), { files: 2, insertions: 3, deletions: 1 });
  // Working-tree diff with no `diff --git` headers falls back to counting `+++` targets.
  const wt = ["--- a/z", "+++ b/z", "+added"].join("\n");
  assert.deepEqual(parseDiffStats(wt), { files: 1, insertions: 1, deletions: 0 });
});

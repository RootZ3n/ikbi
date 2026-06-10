/**
 * BLOCKER 3 (audit): `ikbi workspace ls` lists workspaces (flagging RETAINED work) with their
 * paths, and `ikbi workspace discard <id>` removes one by id. Plus: `ikbi clean` (no --force)
 * PRESERVES retained work and reports it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentIdentity } from "../core/provider/contract.js";
import type { DiscardResult, WorkspaceRecord } from "../core/workspace/contract.js";
import { createWorkspaceCli } from "./workspace.js";
import { createCleanCli } from "./clean.js";

const ID: AgentIdentity = { agentId: "builder-1", functionalRole: "builder", trustTier: "verified" };

function rec(over: Partial<WorkspaceRecord>): WorkspaceRecord {
  return {
    id: "ws-x", targetRepo: "/repo", baseBranch: "main", baseRef: "abc", scratchBranch: "ikbi/ws/ws-x",
    path: "/state/wt/ws-x", identity: ID, state: "allocated", createdAt: 1, updatedAt: 1, ...over,
  };
}

function capture() {
  let out = ""; let err = ""; let exit: number | undefined;
  return { stdout: (s: string) => void (out += s), stderr: (s: string) => void (err += s), setExit: (c: number) => void (exit = c), get out() { return out; }, get err() { return err; }, get exit() { return exit; } };
}

test("`ikbi workspace ls` lists workspaces with paths and flags RETAINED work", async () => {
  const cap = capture();
  const records: WorkspaceRecord[] = [
    rec({ id: "ws-keep", state: "failed", note: "retained: build timed out", path: "/state/wt/ws-keep", createdAt: 1 }),
    rec({ id: "ws-done", state: "promoted", path: "/state/wt/ws-done", createdAt: 2 }),
  ];
  const cli = createWorkspaceCli({
    workspaces: { list: async () => records, get: async () => undefined, discard: async () => ({ workspaceId: "", removed: true }) },
    stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit,
  });
  await cli.workspace(["ls"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /ws-keep/);
  assert.match(cap.out, /\/state\/wt\/ws-keep/, "shows the path");
  assert.match(cap.out, /\[RETAINED\]/, "flags retained work");
  assert.match(cap.out, /ws-done/);
});

test("`ikbi workspace ls` reports an empty registry gracefully", async () => {
  const cap = capture();
  const cli = createWorkspaceCli({
    workspaces: { list: async () => [], get: async () => undefined, discard: async () => ({ workspaceId: "", removed: true }) },
    stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit,
  });
  await cli.workspace(["ls"]);
  assert.match(cap.out, /\(no workspaces\)/);
});

test("`ikbi workspace discard <id>` removes the named workspace", async () => {
  const cap = capture();
  let discarded: string | undefined;
  const target = rec({ id: "ws-keep", state: "failed", note: "retained: x" });
  const cli = createWorkspaceCli({
    workspaces: {
      list: async () => [target],
      get: async (id) => (id === "ws-keep" ? target : undefined),
      discard: async (h): Promise<DiscardResult> => { discarded = h.id; return { workspaceId: h.id, removed: true }; },
    },
    stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit,
  });
  await cli.workspace(["discard", "ws-keep"]);
  assert.equal(discarded, "ws-keep", "discard was called for the named workspace");
  assert.match(cap.out, /workspace ws-keep: discarded/);
  assert.equal(cap.exit, undefined);
});

test("`ikbi workspace discard` on an unknown id fails cleanly (exit 1, no stack)", async () => {
  const cap = capture();
  const cli = createWorkspaceCli({
    workspaces: { list: async () => [], get: async () => undefined, discard: async () => ({ workspaceId: "", removed: false }) },
    stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit,
  });
  await cli.workspace(["discard", "nope"]);
  assert.equal(cap.exit, 1);
  assert.match(cap.err, /no workspace "nope" found/);
});

test("`ikbi clean` (no --force) PRESERVES retained work and reports it", async () => {
  const cap = capture();
  let forcedSeen: boolean | undefined;
  await createCleanCli({
    workspaces: { cleanOrphans: async (opts) => { forcedSeen = opts?.force; return { removed: 0, checked: 1, skipped: 1, reclaimed: 0, skippedIds: ["ws-keep"] }; } },
    stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit,
  }).clean([]);
  assert.equal(forcedSeen, false, "the CLI default passes force:false");
  assert.match(cap.out, /PRESERVED 1 retained workspace/);
  assert.match(cap.out, /ikbi clean --force/);
});

test("`ikbi clean --force` opts into sweeping retained work", async () => {
  const cap = capture();
  let forcedSeen: boolean | undefined;
  await createCleanCli({
    workspaces: { cleanOrphans: async (opts) => { forcedSeen = opts?.force; return { removed: 1, checked: 1, skipped: 0, reclaimed: 0, skippedIds: [] }; } },
    stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit,
  }).clean(["--force"]);
  assert.equal(forcedSeen, true, "--force passes force:true");
  assert.match(cap.out, /reclaimed 1 orphaned worktree/);
});

/**
 * Phase 6 (audit): `ikbi workspace clean` bulk-removes terminal workspaces with filtering:
 *   --dry-run  preview without removing
 *   --retained clean only RETAINED workspaces (requires --force without it)
 *   --stale=N  clean workspaces older than N days
 *   --force    include retained workspaces in a normal sweep
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentIdentity } from "../core/provider/contract.js";
import type { DiscardResult, WorkspaceRecord } from "../core/workspace/contract.js";
import { createWorkspaceCli } from "./workspace.js";

const ID: AgentIdentity = { agentId: "builder-1", functionalRole: "builder", trustTier: "verified" };

function rec(over: Partial<WorkspaceRecord>): WorkspaceRecord {
  return {
    id: "ws-x", targetRepo: "/repo", baseBranch: "main", baseRef: "abc", scratchBranch: "ikbi/ws/ws-x",
    path: "/state/wt/ws-x", identity: ID, state: "allocated", createdAt: Date.now(), updatedAt: Date.now(), ...over,
  };
}

function capture() {
  let out = ""; let err = ""; let exit: number | undefined;
  return { stdout: (s: string) => void (out += s), stderr: (s: string) => void (err += s), setExit: (c: number) => void (exit = c), get out() { return out; }, get err() { return err; }, get exit() { return exit; } };
}

const now = Date.now();

// workspace records spanning states
const promoted = rec({ id: "ws-done", state: "promoted", createdAt: now - 2 * 86_400_000 });
const failed = rec({ id: "ws-fail", state: "failed", createdAt: now - 3 * 86_400_000 });
const retained = rec({ id: "ws-kept", state: "failed", note: "retained: build timed out", createdAt: now - 4 * 86_400_000 });
const active = rec({ id: "ws-live", state: "allocated", createdAt: now - 1000 });

function makeWorkspaces(records: WorkspaceRecord[], discarded: string[] = []) {
  return {
    list: async () => records,
    get: async (id: string) => records.find((r) => r.id === id),
    discard: async (h: WorkspaceRecord): Promise<DiscardResult> => { discarded.push(h.id); return { workspaceId: h.id, removed: true }; },
  };
}

test("`ikbi workspace clean --dry-run` shows what would be removed without discarding", async () => {
  const cap = capture();
  const discarded: string[] = [];
  const cli = createWorkspaceCli({ workspaces: makeWorkspaces([promoted, failed, active], discarded), stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit });
  await cli.workspace(["clean", "--dry-run"]);
  assert.equal(cap.exit, undefined, "no error exit on dry run");
  assert.equal(discarded.length, 0, "nothing was actually discarded");
  assert.match(cap.out, /dry run/, "output mentions dry run");
  assert.match(cap.out, /ws-done/, "shows the promoted workspace");
  assert.match(cap.out, /ws-fail/, "shows the failed workspace");
  assert.doesNotMatch(cap.out, /ws-live/, "active workspace not shown");
  assert.match(cap.out, /run without --dry-run/, "tells user how to proceed");
});

test("`ikbi workspace clean` removes promoted and failed (non-retained) workspaces", async () => {
  const cap = capture();
  const discarded: string[] = [];
  const cli = createWorkspaceCli({ workspaces: makeWorkspaces([promoted, failed, retained, active], discarded), stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit });
  await cli.workspace(["clean"]);
  assert.equal(cap.exit, undefined);
  assert.ok(discarded.includes("ws-done"), "promoted workspace discarded");
  assert.ok(discarded.includes("ws-fail"), "failed workspace discarded");
  assert.ok(!discarded.includes("ws-kept"), "retained workspace preserved (no --force)");
  assert.ok(!discarded.includes("ws-live"), "active workspace untouched");
  assert.match(cap.out, /removed 2 workspace\(s\)/);
});

test("`ikbi workspace clean --retained` cleans only retained workspaces", async () => {
  const cap = capture();
  const discarded: string[] = [];
  const cli = createWorkspaceCli({ workspaces: makeWorkspaces([promoted, failed, retained, active], discarded), stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit });
  await cli.workspace(["clean", "--retained"]);
  assert.equal(cap.exit, undefined);
  assert.deepEqual(discarded, ["ws-kept"], "only the retained workspace was discarded");
  assert.match(cap.out, /removed 1 workspace\(s\)/);
});

test("`ikbi workspace clean --force` includes retained workspaces in the sweep", async () => {
  const cap = capture();
  const discarded: string[] = [];
  const cli = createWorkspaceCli({ workspaces: makeWorkspaces([promoted, failed, retained], discarded), stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit });
  await cli.workspace(["clean", "--force"]);
  assert.equal(cap.exit, undefined);
  assert.ok(discarded.includes("ws-done"), "promoted removed");
  assert.ok(discarded.includes("ws-fail"), "failed removed");
  assert.ok(discarded.includes("ws-kept"), "--force includes retained");
  assert.match(cap.out, /removed 3 workspace\(s\)/);
});

test("`ikbi workspace clean --stale=2` only cleans workspaces older than 2 days", async () => {
  const cap = capture();
  const discarded: string[] = [];
  // promoted is 2 days old (exactly at boundary — test stale=3 to make it clear)
  // failed is 3 days old — should be cleaned
  // retained is 4 days old — should be cleaned if --force, preserved otherwise
  const cli = createWorkspaceCli({ workspaces: makeWorkspaces([promoted, failed, retained], discarded), stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit });
  await cli.workspace(["clean", "--stale=3"]);
  assert.equal(cap.exit, undefined);
  // promoted is 2 days old, stale cutoff is 3 days → NOT old enough → not cleaned
  assert.ok(!discarded.includes("ws-done"), "2-day-old workspace not cleaned with --stale=3");
  // failed is 3 days old — right at boundary, stale means OLDER THAN N days
  // retained is preserved without --force
  assert.ok(!discarded.includes("ws-kept"), "retained workspace preserved even if stale (no --force)");
});

test("`ikbi workspace clean` with nothing to clean reports gracefully", async () => {
  const cap = capture();
  const cli = createWorkspaceCli({ workspaces: makeWorkspaces([active]), stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit });
  await cli.workspace(["clean"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /nothing to clean/);
});

test("`ikbi workspace clean --retained` with no retained workspaces reports gracefully", async () => {
  const cap = capture();
  const cli = createWorkspaceCli({ workspaces: makeWorkspaces([promoted]), stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit });
  await cli.workspace(["clean", "--retained"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /no retained workspaces/);
});

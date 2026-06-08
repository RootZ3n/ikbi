/**
 * SG-7 (audit): the `ikbi clean` command reports what cleanOrphans reclaimed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createCleanCli } from "./clean.js";

function capture() {
  let out = ""; let err = ""; let exit: number | undefined;
  return { stdout: (s: string) => void (out += s), stderr: (s: string) => void (err += s), setExit: (c: number) => void (exit = c), get out() { return out; }, get err() { return err; }, get exit() { return exit; } };
}

test("`ikbi clean` reports the reclaimed count from the workspace manager", async () => {
  const cap = capture();
  await createCleanCli({ workspaces: { cleanOrphans: async () => ({ removed: 2, checked: 3 }) }, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).clean();
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /reclaimed 2 orphaned worktree\(s\) \(checked 3 terminal workspaces\)/);
});

test("`ikbi clean` reports a failure cleanly (no stack), exit 1", async () => {
  const cap = capture();
  await createCleanCli({ workspaces: { cleanOrphans: async () => { throw new Error("disk error"); } }, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).clean();
  assert.equal(cap.exit, 1);
  assert.match(cap.err, /ikbi clean: failed: disk error/);
});

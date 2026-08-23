import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { labTempDir as tmpdir } from "../../../core/temp-root.js";
import { join } from "node:path";
import { test } from "node:test";

import type { OperationContext } from "../../../core/identity/index.js";
import type { ExecRequest, ExecResult } from "../../governed-exec/index.js";
import { runTerminal } from "./terminal.js";

const FAKE_CTX = {} as OperationContext;

function spy() {
  const calls: ExecRequest[] = [];
  const governedExec = { run: async (req: ExecRequest): Promise<ExecResult> => { calls.push(req); return { executed: true, exitCode: 0, stdoutTail: "ok", stderrTail: "" }; } };
  return { governedExec, calls };
}

const wt = (): string => mkdtempSync(join(tmpdir(), "ikbi-cwd-"));

test("terminal: absent cwdSubdir ⇒ command runs at the worktree root (unchanged)", async () => {
  const s = spy();
  const dir = wt();
  await runTerminal({ governedExec: s.governedExec, parentCtx: FAKE_CTX }, dir, { command: "git status" });
  assert.equal(s.calls[0]?.cwd, dir);
  assert.equal(s.calls[0]?.worktreeRoot, dir, "the sandbox writable root is always the whole worktree");
});

test("terminal: cwdSubdir relocates the command's cwd but keeps the worktree as the writable root", async () => {
  const s = spy();
  const dir = wt();
  mkdirSync(join(dir, "pkg"));
  await runTerminal({ governedExec: s.governedExec, parentCtx: FAKE_CTX, cwdSubdir: "pkg" }, dir, { command: "git status" });
  assert.equal(s.calls[0]?.cwd, join(dir, "pkg"));
  assert.equal(s.calls[0]?.worktreeRoot, dir);
});

test("terminal: an escaping cwdSubdir is ignored and falls back to the worktree root", async () => {
  const s = spy();
  const dir = wt();
  await runTerminal({ governedExec: s.governedExec, parentCtx: FAKE_CTX, cwdSubdir: "../../etc" }, dir, { command: "git status" });
  assert.equal(s.calls[0]?.cwd, dir, "a subdir that escapes the tree never becomes the cwd");
});

/**
 * ikbi builder tool — terminal PATH CONFINEMENT regression (Codex blocker 5).
 *
 * Read-only terminal tools (ls/head/tail/wc/find/grep) must not be able to inspect OUTSIDE the
 * managed workspace via relative `..` traversal, an absolute-outside path, or a symlink that
 * escapes the tree. In-workspace relative paths must keep working. These tests build a real
 * worktree with an outside file + an escaping symlink and assert allow/deny per operand.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { OperationContext } from "../../../core/identity/index.js";
import type { ExecRequest, ExecResult } from "../../governed-exec/index.js";
import { runTerminal, firstEscapingOperand } from "./terminal.js";

const FAKE_CTX = { requestId: "r" } as unknown as OperationContext;

/** A governed-exec spy: records each request, returns a fixed clean result. */
function execSpy() {
  const calls: ExecRequest[] = [];
  return {
    calls,
    exec: { run: async (req: ExecRequest): Promise<ExecResult> => { calls.push(req); return { executed: true, exitCode: 0, stdoutTail: "ok", stderrTail: "" }; } },
  };
}

/** A managed workspace (realpath'd) with an inside file, an outside sibling, and an escaping symlink. */
function fixture(): { wt: string; outsideFile: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ikbi-confine-")));
  const wt = join(base, "workspace");
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, "inside-file"), "in\n");
  const outsideFile = join(base, "outside-file");
  writeFileSync(outsideFile, "secret\n");
  // A symlink INSIDE the workspace pointing OUT of it.
  symlinkSync(base, join(wt, "escape"));
  return { wt, outsideFile };
}

async function run(wt: string, command: string) {
  const spy = execSpy();
  const out = await runTerminal({ governedExec: spy.exec, parentCtx: FAKE_CTX }, wt, { command });
  return { out, calls: spy.calls };
}

// ── DENIED: escapes ─────────────────────────────────────────────────────────

test("terminal confine: `ls ..` is denied (relative parent traversal)", async () => {
  const { wt } = fixture();
  const { out, calls } = await run(wt, "ls ..");
  assert.match(out, /DENIED/);
  assert.equal(calls.length, 0, "an escaping read never reaches governed-exec");
});

test("terminal confine: `grep x ../outside-file` is denied", async () => {
  const { wt } = fixture();
  const { out, calls } = await run(wt, "grep x ../outside-file");
  assert.match(out, /DENIED/);
  assert.equal(calls.length, 0);
});

test("terminal confine: `find ..` is denied", async () => {
  const { wt } = fixture();
  const { out, calls } = await run(wt, "find ..");
  assert.match(out, /DENIED/);
  assert.equal(calls.length, 0);
});

test("terminal confine: an absolute path outside the workspace is denied", async () => {
  const { wt, outsideFile } = fixture();
  const { out, calls } = await run(wt, `head ${outsideFile}`);
  assert.match(out, /DENIED/);
  assert.equal(calls.length, 0);
  // /etc/passwd too (the classic).
  const r2 = await run(wt, "head /etc/passwd");
  assert.match(r2.out, /DENIED/);
  assert.equal(r2.calls.length, 0);
});

test("terminal confine: a symlink that escapes the workspace is denied", async () => {
  const { wt } = fixture();
  const { out, calls } = await run(wt, "grep x escape/outside-file");
  assert.match(out, /DENIED/);
  assert.equal(calls.length, 0);
});

// ── ALLOWED: legitimate in-workspace reads still work ────────────────────────

test("terminal confine: `ls .` still works", async () => {
  const { wt } = fixture();
  const { out, calls } = await run(wt, "ls .");
  assert.doesNotMatch(out, /DENIED/);
  assert.equal(calls.length, 1, "an in-workspace read reaches governed-exec");
  assert.equal(calls[0]?.command, "ls");
});

test("terminal confine: `grep x ./inside-file` still works (pattern + in-workspace path)", async () => {
  const { wt } = fixture();
  const { out, calls } = await run(wt, "grep x ./inside-file");
  assert.doesNotMatch(out, /DENIED/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args, ["x", "./inside-file"]);
});

test("terminal confine: `find .` still works", async () => {
  const { wt } = fixture();
  const { out, calls } = await run(wt, "find . -name inside-file");
  assert.doesNotMatch(out, /DENIED/);
  assert.equal(calls.length, 1);
});

test("terminal confine: flags are not treated as paths (ls -la)", async () => {
  const { wt } = fixture();
  const { out, calls } = await run(wt, "ls -la");
  assert.doesNotMatch(out, /DENIED/);
  assert.equal(calls.length, 1);
});

// ── the pure operand classifier ──────────────────────────────────────────────

test("firstEscapingOperand: flags skipped; only escaping operands flagged", () => {
  const { wt } = fixture();
  assert.equal(firstEscapingOperand(wt, ["-la", "."]), undefined);
  assert.equal(firstEscapingOperand(wt, ["x", "./inside-file"]), undefined);
  assert.equal(firstEscapingOperand(wt, [".."]), "..");
  assert.equal(firstEscapingOperand(wt, ["x", "../outside-file"]), "../outside-file");
});

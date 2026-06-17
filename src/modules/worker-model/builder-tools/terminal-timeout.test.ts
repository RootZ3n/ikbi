import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { OperationContext } from "../../../core/identity/index.js";
import type { ExecRequest, ExecResult } from "../../governed-exec/index.js";
import { runTerminal, DEFAULT_TERMINAL_TIMEOUT_MS, MAX_TERMINAL_TIMEOUT_MS } from "./terminal.js";

const FAKE_CTX = {} as OperationContext;

function spy() {
  const calls: ExecRequest[] = [];
  const governedExec = { run: async (req: ExecRequest): Promise<ExecResult> => { calls.push(req); return { executed: true, exitCode: 0, stdoutTail: "ok", stderrTail: "" }; } };
  return { governedExec, calls };
}

const wt = (): string => mkdtempSync(join(tmpdir(), "ikbi-term-"));

test("terminal: no timeout_ms ⇒ the generous default is applied", async () => {
  const s = spy();
  await runTerminal({ governedExec: s.governedExec, parentCtx: FAKE_CTX }, wt(), { command: "git status" });
  assert.equal(s.calls[0]?.timeoutMs, DEFAULT_TERMINAL_TIMEOUT_MS);
});

test("terminal: a model-requested timeout_ms is honored", async () => {
  const s = spy();
  await runTerminal({ governedExec: s.governedExec, parentCtx: FAKE_CTX }, wt(), { command: "git status", timeout_ms: 45_000 });
  assert.equal(s.calls[0]?.timeoutMs, 45_000);
});

test("terminal: an absurd timeout_ms is clamped to the hard ceiling", async () => {
  const s = spy();
  await runTerminal({ governedExec: s.governedExec, parentCtx: FAKE_CTX }, wt(), { command: "git status", timeout_ms: 99_999_999 });
  assert.equal(s.calls[0]?.timeoutMs, MAX_TERMINAL_TIMEOUT_MS);
});

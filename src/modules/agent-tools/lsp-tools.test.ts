/**
 * ikbi lsp_diagnostic tool-wrapper tests — arg validation + governed-exec wiring.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExecRequest, ExecResult } from "../governed-exec/index.js";
import type { OperationContext } from "../../core/identity/index.js";
import { clearDetectionCache } from "../lsp/index.js";
import { lspDiagnosticTool, runLspDiagnostic } from "./lsp-tools.js";

const fakeCtx = { identity: { agentId: "tester" } } as unknown as OperationContext;

function dirWithTs(): string {
  clearDetectionCache();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-lsptool-"));
  writeFileSync(join(dir, "tsconfig.json"), "{}");
  return dir;
}

function exec(result: ExecResult): { run: (req: ExecRequest) => Promise<ExecResult> } {
  return { run: async () => result };
}

test("lspDiagnosticTool: schema shape", () => {
  assert.equal(lspDiagnosticTool.name, "lsp_diagnostic");
  const params = lspDiagnosticTool.parameters as { properties: Record<string, unknown> };
  assert.ok("language" in params.properties);
});

test("runLspDiagnostic: fails closed without parentCtx", async () => {
  const dir = dirWithTs();
  const out = await runLspDiagnostic({ governedExec: exec({ executed: true }), worktreeReal: dir }, {});
  assert.match(out, /ERROR: lsp_diagnostic is unavailable/);
});

test("runLspDiagnostic: rejects an unknown language", async () => {
  const dir = dirWithTs();
  const out = await runLspDiagnostic({ governedExec: exec({ executed: true }), worktreeReal: dir, parentCtx: fakeCtx }, { language: "cobol" });
  assert.match(out, /unknown language "cobol"/);
});

test("runLspDiagnostic: returns a formatted report on success", async () => {
  const dir = dirWithTs();
  const out = await runLspDiagnostic(
    { governedExec: exec({ executed: true, exitCode: 1, stdoutTail: "src/a.ts(1,1): error TS1005: ';' expected." }), worktreeReal: dir, parentCtx: fakeCtx },
    { language: "typescript" },
  );
  assert.match(out, /LSP diagnostics/);
  assert.match(out, /TS1005/);
});

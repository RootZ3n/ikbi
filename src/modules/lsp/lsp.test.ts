/**
 * ikbi LSP module tests — detection, output parsers, and the governed-exec-driven runner.
 * No real compilers run: governed-exec is mocked, fixtures are captured tool output.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExecRequest, ExecResult } from "../governed-exec/index.js";
import type { OperationContext } from "../../core/identity/index.js";
import {
  clearDetectionCache,
  countDiagnostics,
  detectLanguages,
  formatLspReport,
  parseCargo,
  parseGoVet,
  parsePyright,
  parseTsc,
  runLspDiagnostics,
} from "./index.js";

function tmp(): string {
  clearDetectionCache();
  return mkdtempSync(join(tmpdir(), "ikbi-lsp-"));
}

const fakeCtx = { identity: { agentId: "tester" } } as unknown as OperationContext;

// ---- detection ----

test("detectLanguages: tsconfig.json marks a TypeScript project", () => {
  const dir = tmp();
  writeFileSync(join(dir, "tsconfig.json"), "{}");
  const got = detectLanguages(dir);
  assert.equal(got.length, 1);
  assert.equal(got[0]?.language, "typescript");
  assert.equal(got[0]?.marker, "tsconfig.json");
});

test("detectLanguages: go.mod + Cargo.toml detected together, stable order", () => {
  const dir = tmp();
  writeFileSync(join(dir, "go.mod"), "module x\n");
  writeFileSync(join(dir, "Cargo.toml"), "[package]\n");
  const got = detectLanguages(dir);
  assert.deepEqual(got.map((d) => d.language), ["go", "rust"]);
});

test("detectLanguages: extension fallback finds python when no manifest", () => {
  const dir = tmp();
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "main.py"), "print(1)\n");
  const got = detectLanguages(dir);
  assert.equal(got.length, 1);
  assert.equal(got[0]?.language, "python");
  assert.equal(got[0]?.marker, "*.py");
});

test("detectLanguages: caches per directory (second call returns same ref)", () => {
  const dir = tmp();
  writeFileSync(join(dir, "tsconfig.json"), "{}");
  const a = detectLanguages(dir);
  const b = detectLanguages(dir);
  assert.equal(a, b);
});

test("detectLanguages: empty dir detects nothing", () => {
  const dir = tmp();
  assert.deepEqual(detectLanguages(dir), []);
});

// ---- parsers ----

test("parseTsc: parses paren-form diagnostics", () => {
  const out = "src/foo.ts(12,5): error TS2322: Type 'x' is not assignable to type 'y'.\nsrc/bar.ts(3,1): warning TS6133: 'a' is declared but never used.";
  const diags = parseTsc(out);
  assert.equal(diags.length, 2);
  assert.deepEqual(diags[0], { file: "src/foo.ts", line: 12, column: 5, severity: "error", code: "TS2322", message: "Type 'x' is not assignable to type 'y'.", source: "tsc" });
  assert.equal(diags[1]?.severity, "warning");
});

test("parseTsc: ignores non-diagnostic lines", () => {
  assert.deepEqual(parseTsc("Files: 12\nSemantic errors: 0\n"), []);
});

test("parsePyright: parses generalDiagnostics with 0-based positions → 1-based", () => {
  const json = JSON.stringify({
    generalDiagnostics: [
      { file: "/p/app.py", severity: "error", message: "x is not defined", rule: "reportUndefinedVariable", range: { start: { line: 9, character: 4 } } },
    ],
  });
  const diags = parsePyright(`some banner\n${json}\n`);
  assert.equal(diags.length, 1);
  assert.equal(diags[0]?.line, 10);
  assert.equal(diags[0]?.column, 5);
  assert.equal(diags[0]?.code, "reportUndefinedVariable");
  assert.equal(diags[0]?.severity, "error");
});

test("parsePyright: garbage returns empty", () => {
  assert.deepEqual(parsePyright("not json at all"), []);
});

test("parseGoVet: parses file:line:col diagnostics, skips framing", () => {
  const out = "# example.com/m\n./main.go:10:2: undefined: foo\nutil/x.go:3: missing return";
  const diags = parseGoVet(out);
  assert.equal(diags.length, 2);
  assert.deepEqual(diags[0], { file: "main.go", line: 10, column: 2, severity: "error", message: "undefined: foo", source: "go vet" });
  assert.equal(diags[1]?.column, 0);
});

test("parseCargo: parses compiler-message JSON lines", () => {
  const line = JSON.stringify({
    reason: "compiler-message",
    message: { level: "error", message: "cannot find value `x`", code: { code: "E0425" }, spans: [{ file_name: "src/main.rs", line_start: 4, column_start: 9, is_primary: true }] },
  });
  const other = JSON.stringify({ reason: "compiler-artifact" });
  const diags = parseCargo(`${other}\n${line}\n`);
  assert.equal(diags.length, 1);
  assert.deepEqual(diags[0], { file: "src/main.rs", line: 4, column: 9, severity: "error", message: "cannot find value `x`", source: "cargo", code: "E0425" });
});

// ---- runner ----

function mockExec(byCommand: Record<string, ExecResult>): { run: (req: ExecRequest) => Promise<ExecResult>; calls: ExecRequest[] } {
  const calls: ExecRequest[] = [];
  return {
    calls,
    run: async (req: ExecRequest) => {
      calls.push(req);
      return byCommand[req.command] ?? { executed: true, exitCode: 0, stdoutTail: "", stderrTail: "" };
    },
  };
}

test("runLspDiagnostics: TS project → runs tsc and parses diagnostics", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "tsconfig.json"), "{}");
  const exec = mockExec({ npx: { executed: true, exitCode: 1, stdoutTail: "src/a.ts(1,1): error TS1005: ';' expected.", stderrTail: "" } });
  const report = await runLspDiagnostics({ governedExec: exec, parentCtx: fakeCtx }, { rootDir: dir });
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0]?.ran, true);
  assert.equal(report.results[0]?.diagnostics.length, 1);
  assert.equal(report.results[0]?.diagnostics[0]?.code, "TS1005");
  assert.equal(exec.calls[0]?.command, "npx");
  assert.deepEqual([...(exec.calls[0]?.args ?? [])], ["tsc", "--noEmit", "--pretty", "false"]);
});

test("runLspDiagnostics: fails closed without parentCtx (nothing runs)", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "tsconfig.json"), "{}");
  const exec = mockExec({});
  const report = await runLspDiagnostics({ governedExec: exec }, { rootDir: dir });
  assert.equal(report.results[0]?.ran, false);
  assert.equal(exec.calls.length, 0);
  assert.match(report.results[0]?.note ?? "", /no parent identity/);
});

test("runLspDiagnostics: denied binary reported, not run", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "go.mod"), "module x\n");
  const exec = mockExec({ go: { executed: false, denied: true, reason: "binary not allowlisted" } });
  const report = await runLspDiagnostics({ governedExec: exec, parentCtx: fakeCtx }, { rootDir: dir });
  assert.equal(report.results[0]?.ran, false);
  assert.match(report.results[0]?.note ?? "", /denied/);
});

test("runLspDiagnostics: clean project → ran with zero diagnostics", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "tsconfig.json"), "{}");
  const exec = mockExec({ npx: { executed: true, exitCode: 0, stdoutTail: "", stderrTail: "" } });
  const report = await runLspDiagnostics({ governedExec: exec, parentCtx: fakeCtx }, { rootDir: dir });
  assert.equal(report.results[0]?.ran, true);
  assert.equal(report.results[0]?.diagnostics.length, 0);
  assert.equal(countDiagnostics(report).errors, 0);
});

test("runLspDiagnostics: language filter runs only the requested language", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "tsconfig.json"), "{}");
  writeFileSync(join(dir, "go.mod"), "module x\n");
  const exec = mockExec({});
  const report = await runLspDiagnostics({ governedExec: exec, parentCtx: fakeCtx }, { rootDir: dir, language: "go" });
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0]?.language, "go");
  assert.equal(exec.calls[0]?.command, "go");
});

test("formatLspReport: renders summary + diagnostics", () => {
  const dir = tmp();
  const report = {
    detected: [{ language: "typescript" as const, marker: "tsconfig.json" }],
    results: [
      { language: "typescript" as const, command: "npx tsc", ran: true, diagnostics: [{ file: "a.ts", line: 2, column: 3, severity: "error" as const, message: "boom", source: "tsc", code: "TS1" }] },
    ],
  };
  void dir;
  const out = formatLspReport(report);
  assert.match(out, /1 error\(s\)/);
  assert.match(out, /a\.ts:2:3 error \[TS1\]: boom/);
});

test("formatLspReport: no project type detected", () => {
  assert.match(formatLspReport({ detected: [], results: [] }), /no supported project type/);
});

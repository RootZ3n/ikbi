/**
 * `ikbi audit --compare` — CLI integration tests for multi-model comparison.
 *
 * Tests cover: --compare flag parsing, wiring to multi-audit, formatted output,
 * error handling, single-model degrade, and empty findings.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkspaceRecord } from "../core/workspace/contract.js";
import type { Receipt } from "../core/receipt/index.js";
import { createAuditCli } from "./audit.js";
import type { ComparisonResult } from "../modules/worker-model/multi-audit.js";

// ── helpers ────────────────────────────────────────────────────────────────────

function capture() {
  let out = ""; let err = ""; let exit: number | undefined;
  return { stdout: (s: string) => void (out += s), stderr: (s: string) => void (err += s), setExit: (c: number) => void (exit = c), get out() { return out; }, get err() { return err; }, get exit() { return exit; } };
}

function fakeFS(existing: string[]) {
  const set = new Set(existing);
  const fileExists = async (p: string): Promise<boolean> => set.has(p);
  const readFileText = async (p: string): Promise<string> => {
    if (!set.has(p)) throw new Error(`not found: ${p}`);
    return "";
  };
  return { fileExists, readFileText };
}

function noWorkspaces() { return { list: async (): Promise<WorkspaceRecord[]> => [] }; }
function noReceipts() { return { query: async (): Promise<Receipt[]> => [] }; }

function makeComparisonResult(overrides: Partial<ComparisonResult> = {}): ComparisonResult {
  return {
    models: [
      { model: "model-a", findings: [{ title: "f1", detail: "finding one" }], durationMs: 420, cost: 0.003 },
      { model: "model-b", findings: [{ title: "f1", detail: "finding two" }], durationMs: 1200, cost: 0.008 },
    ],
    agreement: [],
    unique: { "model-a": [{ title: "f1", detail: "finding one" }], "model-b": [{ title: "f1", detail: "finding two" }] },
    contradictions: [],
    summary: "test summary",
    ...overrides,
  };
}

// ── --compare flag parsing ─────────────────────────────────────────────────────

test("audit --compare runs multi-model comparison and shows report", async () => {
  const { fileExists, readFileText } = fakeFS(["/repo", "/repo/package.json"]);
  const cap = capture();
  const comparisonResult = makeComparisonResult();

  await createAuditCli({
    fileExists, readFileText, workspaces: noWorkspaces(), receipts: noReceipts(),
    stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit,
    runMultiAudit: async () => comparisonResult,
  }).audit(["/repo", "--compare", "model-a,model-b"]);

  assert.equal(cap.exit, undefined, "should not set exit code");
  assert.match(cap.out, /Multi-Model Audit: model-a vs model-b/);
  assert.match(cap.out, /AGREEMENT/);
  assert.match(cap.out, /CONTRADICTIONS/);
  assert.match(cap.out, /Coverage/);
  // Existing filesystem audit should still run
  assert.match(cap.out, /Type:\s+Node\.js/);
  assert.match(cap.out, /Workspaces/);
});

test("audit --compare still shows filesystem audit output", async () => {
  const { fileExists, readFileText } = fakeFS(["/repo", "/repo/package.json", "/repo/pnpm-lock.yaml"]);
  const cap = capture();
  const comparisonResult = makeComparisonResult();

  await createAuditCli({
    fileExists, readFileText, workspaces: noWorkspaces(), receipts: noReceipts(),
    stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit,
    runMultiAudit: async () => comparisonResult,
  }).audit(["/repo", "--compare", "m1,m2"]);

  // Filesystem audit
  assert.match(cap.out, /Repo:\s+\/repo/);
  assert.match(cap.out, /Type:\s+Node\.js/);
  assert.match(cap.out, /Package manager:\s+pnpm/);
  // Multi-audit
  assert.match(cap.out, /Multi-Model Audit/);
});

test("audit --compare with agreement findings in report", async () => {
  const { fileExists, readFileText } = fakeFS(["/repo"]);
  const cap = capture();
  const comparisonResult = makeComparisonResult({
    agreement: [{ file: "src/foo.ts", title: "complex code", modelATitle: "complex code", modelBTitle: "code is complex" }],
    unique: { "model-a": [], "model-b": [] },
  });

  await createAuditCli({
    fileExists, readFileText, workspaces: noWorkspaces(), receipts: noReceipts(),
    stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit,
    runMultiAudit: async () => comparisonResult,
  }).audit(["/repo", "--compare", "m1,m2"]);

  assert.match(cap.out, /AGREEMENT.*1/);
  assert.match(cap.out, /complex code/);
});

test("audit --compare shows unique findings per model", async () => {
  const { fileExists, readFileText } = fakeFS(["/repo"]);
  const cap = capture();
  const comparisonResult = makeComparisonResult({
    agreement: [],
    unique: {
      "model-a": [{ title: "f1", detail: "only model-a found this", path: "src/a.ts" }],
      "model-b": [{ title: "f2", detail: "only model-b found this", path: "src/b.ts" }],
    },
  });

  await createAuditCli({
    fileExists, readFileText, workspaces: noWorkspaces(), receipts: noReceipts(),
    stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit,
    runMultiAudit: async () => comparisonResult,
  }).audit(["/repo", "--compare", "m1,m2"]);

  assert.match(cap.out, /UNIQUE TO model-a/);
  assert.match(cap.out, /only model-a found this/);
  assert.match(cap.out, /UNIQUE TO model-b/);
  assert.match(cap.out, /only model-b found this/);
});

test("audit --compare shows contradictions in report", async () => {
  const { fileExists, readFileText } = fakeFS(["/repo"]);
  const cap = capture();
  const comparisonResult = makeComparisonResult({
    contradictions: [{
      file: "src/auth.ts",
      modelAFinding: { title: "f1", detail: "good tests", path: "src/auth.ts" },
      modelBFinding: { title: "f2", detail: "no tests at all", path: "src/auth.ts" },
    }],
  });

  await createAuditCli({
    fileExists, readFileText, workspaces: noWorkspaces(), receipts: noReceipts(),
    stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit,
    runMultiAudit: async () => comparisonResult,
  }).audit(["/repo", "--compare", "m1,m2"]);

  assert.match(cap.out, /CONTRADICTIONS.*1/);
  assert.match(cap.out, /good tests/);
  assert.match(cap.out, /no tests at all/);
});

// ── Single model --compare ─────────────────────────────────────────────────────

test("audit --compare with single model degrades gracefully", async () => {
  const { fileExists, readFileText } = fakeFS(["/repo"]);
  const cap = capture();
  const comparisonResult = makeComparisonResult({
    models: [
      { model: "solo", findings: [{ title: "f1", detail: "solo finding" }], durationMs: 100, cost: 0.001 },
    ],
    unique: { solo: [{ title: "f1", detail: "solo finding" }] },
  });

  await createAuditCli({
    fileExists, readFileText, workspaces: noWorkspaces(), receipts: noReceipts(),
    stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit,
    runMultiAudit: async () => comparisonResult,
  }).audit(["/repo", "--compare", "solo"]);

  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /Multi-Model Audit: solo/);
});

// ── Error handling ─────────────────────────────────────────────────────────────

test("audit --compare handles multi-audit runner error", async () => {
  const { fileExists, readFileText } = fakeFS(["/repo"]);
  const cap = capture();

  await createAuditCli({
    fileExists, readFileText, workspaces: noWorkspaces(), receipts: noReceipts(),
    stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit,
    runMultiAudit: async () => { throw new Error("provider exploded"); },
  }).audit(["/repo", "--compare", "m1,m2"]);

  assert.equal(cap.exit, 1);
  assert.match(cap.err, /multi-model comparison failed/);
  assert.match(cap.err, /provider exploded/);
  // Filesystem audit should still have run before the error
  assert.match(cap.out, /Type:/);
});

// ── Empty findings ─────────────────────────────────────────────────────────────

test("audit --compare with empty findings from both models", async () => {
  const { fileExists, readFileText } = fakeFS(["/repo"]);
  const cap = capture();
  const comparisonResult = makeComparisonResult({
    models: [
      { model: "m1", findings: [], durationMs: 50, cost: 0 },
      { model: "m2", findings: [], durationMs: 50, cost: 0 },
    ],
    agreement: [],
    unique: { m1: [], m2: [] },
    contradictions: [],
  });

  await createAuditCli({
    fileExists, readFileText, workspaces: noWorkspaces(), receipts: noReceipts(),
    stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit,
    runMultiAudit: async () => comparisonResult,
  }).audit(["/repo", "--compare", "m1,m2"]);

  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /AGREEMENT \(0\)/);
});

// ── Missing --compare value ────────────────────────────────────────────────────

test("audit --compare without value is treated as normal audit", async () => {
  const { fileExists, readFileText } = fakeFS(["/repo"]);
  const cap = capture();

  await createAuditCli({
    fileExists, readFileText, workspaces: noWorkspaces(), receipts: noReceipts(),
    stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit,
  }).audit(["/repo", "--compare"]);

  // --compare without a value → parseCompareFlag returns undefined → normal audit
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /Repo:/);
  assert.doesNotMatch(cap.out, /Multi-Model Audit/);
});

test("audit without --compare does NOT run multi-audit", async () => {
  const { fileExists, readFileText } = fakeFS(["/repo"]);
  const cap = capture();
  let multiAuditCalled = false;

  await createAuditCli({
    fileExists, readFileText, workspaces: noWorkspaces(), receipts: noReceipts(),
    stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit,
    runMultiAudit: async () => { multiAuditCalled = true; return makeComparisonResult(); },
  }).audit(["/repo"]);

  assert.equal(multiAuditCalled, false, "multi-audit should not be called without --compare");
});

// ── help/usage ─────────────────────────────────────────────────────────────────

test("audit usage message includes --compare hint", async () => {
  const cap = capture();
  await createAuditCli({ stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).audit([]);
  assert.match(cap.err, /--compare/);
});

/**
 * `ikbi audit <repo>` — read-only repo diagnostic snapshot.
 *
 * Tests cover: repo type detection, package manager, TypeScript, lockfile,
 * workspace listing, receipt history, missing repo path, and missing arg.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkspaceRecord } from "../core/workspace/contract.js";
import type { Receipt } from "../core/receipt/index.js";
import { createAuditCli } from "./audit.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function capture() {
  let out = ""; let err = ""; let exit: number | undefined;
  return { stdout: (s: string) => void (out += s), stderr: (s: string) => void (err += s), setExit: (c: number) => void (exit = c), get out() { return out; }, get err() { return err; }, get exit() { return exit; } };
}

/** Build a fake fileExists that returns true only for the given set of paths. */
function fakeFS(existing: string[]) {
  const set = new Set(existing);
  const fileExists = async (p: string): Promise<boolean> => set.has(p);
  const readFileText = async (p: string): Promise<string> => {
    if (!set.has(p)) throw new Error(`not found: ${p}`);
    if (p.endsWith("package.json")) return JSON.stringify({ scripts: { test: "pnpm test" } });
    return "";
  };
  return { fileExists, readFileText };
}

function noWorkspaces() { return { list: async (): Promise<WorkspaceRecord[]> => [] }; }
function noReceipts() { return { query: async (): Promise<Receipt[]> => [] }; }

// ── missing arg ───────────────────────────────────────────────────────────────

test("audit fails with usage message when no repo path is given", async () => {
  const cap = capture();
  await createAuditCli({ stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).audit([]);
  assert.equal(cap.exit, 1);
  assert.match(cap.err, /repo path is required/);
});

test("audit fails when the repo path does not exist", async () => {
  const cap = capture();
  const { fileExists, readFileText } = fakeFS([]); // nothing exists
  await createAuditCli({ fileExists, readFileText, workspaces: noWorkspaces(), receipts: noReceipts(), stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).audit(["/nonexistent/repo"]);
  assert.equal(cap.exit, 1);
  assert.match(cap.err, /not found/);
});

// ── repo type detection ───────────────────────────────────────────────────────

test("audit detects a Node.js repo (package.json)", async () => {
  const { fileExists, readFileText } = fakeFS(["/repo", "/repo/package.json", "/repo/pnpm-lock.yaml"]);
  const cap = capture();
  await createAuditCli({ fileExists, readFileText, workspaces: noWorkspaces(), receipts: noReceipts(), stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).audit(["/repo"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /Type:\s+Node\.js/);
});

test("audit detects a Rust repo (Cargo.toml)", async () => {
  const { fileExists, readFileText } = fakeFS(["/repo", "/repo/Cargo.toml"]);
  const cap = capture();
  await createAuditCli({ fileExists, readFileText, workspaces: noWorkspaces(), receipts: noReceipts(), stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).audit(["/repo"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /Type:\s+Rust/);
});

test("audit detects a Go repo (go.mod)", async () => {
  const { fileExists, readFileText } = fakeFS(["/repo", "/repo/go.mod"]);
  const cap = capture();
  await createAuditCli({ fileExists, readFileText, workspaces: noWorkspaces(), receipts: noReceipts(), stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).audit(["/repo"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /Type:\s+Go/);
});

test("audit detects a Python repo (pyproject.toml)", async () => {
  const { fileExists, readFileText } = fakeFS(["/repo", "/repo/pyproject.toml"]);
  const cap = capture();
  await createAuditCli({ fileExists, readFileText, workspaces: noWorkspaces(), receipts: noReceipts(), stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).audit(["/repo"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /Type:\s+Python/);
});

test("audit shows unknown type when no known indicator is present", async () => {
  const { fileExists, readFileText } = fakeFS(["/repo"]);
  const cap = capture();
  await createAuditCli({ fileExists, readFileText, workspaces: noWorkspaces(), receipts: noReceipts(), stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).audit(["/repo"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /Type:\s+\(unknown\)/);
});

// ── package manager and lockfile ──────────────────────────────────────────────

test("audit detects pnpm from pnpm-lock.yaml", async () => {
  const { fileExists, readFileText } = fakeFS(["/repo", "/repo/package.json", "/repo/pnpm-lock.yaml"]);
  const cap = capture();
  await createAuditCli({ fileExists, readFileText, workspaces: noWorkspaces(), receipts: noReceipts(), stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).audit(["/repo"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /Package manager:\s+pnpm/);
  assert.match(cap.out, /Lockfile:\s+pnpm-lock\.yaml/);
  assert.match(cap.out, /Test command:\s+pnpm test/);
});

test("audit shows (none) for package manager when no lockfile exists", async () => {
  const { fileExists, readFileText } = fakeFS(["/repo", "/repo/package.json"]);
  const cap = capture();
  await createAuditCli({ fileExists, readFileText, workspaces: noWorkspaces(), receipts: noReceipts(), stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).audit(["/repo"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /Package manager:\s+\(none\)/);
});

// ── TypeScript ────────────────────────────────────────────────────────────────

test("audit reports TypeScript when tsconfig.json is present", async () => {
  const { fileExists, readFileText } = fakeFS(["/repo", "/repo/package.json", "/repo/tsconfig.json"]);
  const cap = capture();
  await createAuditCli({ fileExists, readFileText, workspaces: noWorkspaces(), receipts: noReceipts(), stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).audit(["/repo"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /TypeScript:\s+yes/);
});

test("audit reports no TypeScript when tsconfig.json is absent", async () => {
  const { fileExists, readFileText } = fakeFS(["/repo", "/repo/package.json"]);
  const cap = capture();
  await createAuditCli({ fileExists, readFileText, workspaces: noWorkspaces(), receipts: noReceipts(), stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).audit(["/repo"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /TypeScript:\s+no/);
});

// ── workspace listing ─────────────────────────────────────────────────────────

test("audit lists active workspaces for the repo", async () => {
  const { fileExists, readFileText } = fakeFS(["/repo"]);
  const ws: WorkspaceRecord = { id: "ws-abc", targetRepo: "/repo", baseBranch: "main", baseRef: "abc", scratchBranch: "ikbi/ws/ws-abc", path: "/wt/ws-abc", identity: { agentId: "b" }, state: "allocated", createdAt: 0, updatedAt: 0 };
  const workspaces = { list: async () => [ws] };
  const cap = capture();
  await createAuditCli({ fileExists, readFileText, workspaces, receipts: noReceipts(), stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).audit(["/repo"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /ws-abc/);
  assert.match(cap.out, /allocated/);
});

test("audit shows (none) when no workspaces exist for the repo", async () => {
  const { fileExists, readFileText } = fakeFS(["/repo"]);
  const cap = capture();
  await createAuditCli({ fileExists, readFileText, workspaces: noWorkspaces(), receipts: noReceipts(), stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).audit(["/repo"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /Workspaces:.*none/);
});

test("audit only lists workspaces for the target repo (not other repos)", async () => {
  const { fileExists, readFileText } = fakeFS(["/repo"]);
  const ws1: WorkspaceRecord = { id: "ws-mine", targetRepo: "/repo", baseBranch: "main", baseRef: "a", scratchBranch: "ikbi/ws/ws-mine", path: "/wt/ws-mine", identity: { agentId: "b" }, state: "allocated", createdAt: 0, updatedAt: 0 };
  const ws2: WorkspaceRecord = { id: "ws-other", targetRepo: "/other-repo", baseBranch: "main", baseRef: "b", scratchBranch: "ikbi/ws/ws-other", path: "/wt/ws-other", identity: { agentId: "b" }, state: "promoted", createdAt: 0, updatedAt: 0 };
  const workspaces = { list: async () => [ws1, ws2] };
  const cap = capture();
  await createAuditCli({ fileExists, readFileText, workspaces, receipts: noReceipts(), stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).audit(["/repo"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /ws-mine/);
  assert.doesNotMatch(cap.out, /ws-other/);
});

// ── receipt history ───────────────────────────────────────────────────────────

test("audit shows receipt count and last build info from receipts", async () => {
  const { fileExists, readFileText } = fakeFS(["/repo"]);
  const r: Receipt = {
    contractVersion: "1.0.0", id: "r1", seq: 0, timestamp: 1000000,
    identity: { agentId: "op", trustTier: "operator" },
    operation: "worker.run.summary",
    outcome: { status: "success", detail: "fast_forward" },
    requestId: "task-abc",
    project: "/repo",
    metadata: { workspaceId: "ws-1", verificationResult: "success", targetRepo: "/repo", promoted: true },
  } as unknown as Receipt;
  const receipts = { query: async () => [r] };
  const cap = capture();
  await createAuditCli({ fileExists, readFileText, workspaces: noWorkspaces(), receipts, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).audit(["/repo"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /Receipt history:\s+1 receipt/);
  assert.match(cap.out, /Last build:.*success/);
  assert.match(cap.out, /task-abc/);
});

test("audit shows (none) when there are no build receipts for the repo", async () => {
  const { fileExists, readFileText } = fakeFS(["/repo"]);
  const cap = capture();
  await createAuditCli({ fileExists, readFileText, workspaces: noWorkspaces(), receipts: noReceipts(), stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).audit(["/repo"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /Last build:\s+\(none\)/);
});

test("audit handles workspace list errors gracefully", async () => {
  const { fileExists, readFileText } = fakeFS(["/repo"]);
  const workspaces = { list: async (): Promise<WorkspaceRecord[]> => { throw new Error("store error"); } };
  const cap = capture();
  await createAuditCli({ fileExists, readFileText, workspaces, receipts: noReceipts(), stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).audit(["/repo"]);
  assert.equal(cap.exit, undefined, "audit still succeeds even if workspace store errors");
  assert.match(cap.out, /Workspaces:.*none/);
});

test("audit handles receipt query errors gracefully", async () => {
  const { fileExists, readFileText } = fakeFS(["/repo"]);
  const receipts = { query: async (): Promise<Receipt[]> => { throw new Error("store error"); } };
  const cap = capture();
  await createAuditCli({ fileExists, readFileText, workspaces: noWorkspaces(), receipts, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).audit(["/repo"]);
  assert.equal(cap.exit, undefined, "audit still succeeds even if receipt store errors");
  assert.match(cap.out, /Last build:\s+\(none\)/);
});

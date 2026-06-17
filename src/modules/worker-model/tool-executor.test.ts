/**
 * ikbi SHARED tool-executor — TESTS.
 *
 * Proves the one governance + execution path both the builder and the chat share:
 *   1. write_file to a governed surface (CLAUDE.md) → PROPOSED, nothing written.
 *   2. write_file to a non-governed path → writes normally.
 *   3. patch to a governed surface → PROPOSED (no edit applied).
 *   4. multi_edit to a governed surface → PROPOSED.
 *   5. brain_put → PROPOSED (never reaches the brain bridge).
 *   6. brain_search / brain_think → pass through (not intercepted).
 *   7. terminal → routes through governed-exec.
 *   8. read_file → worktree confinement (and traversal escape rejected).
 *   9. No memoryGovernor in deps → NO interception (backward compatible).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolCall } from "../../core/provider/index.js";
import type { GbrainBridge } from "../../core/gbrain-bridge.js";
import type { OperationContext } from "../../core/identity/index.js";
import type { MemoryProposal } from "../memory-governor/contract.js";
import { createMemoryGovernor } from "../memory-governor/index.js";
import { executeTool, interceptMemoryGovernor, type ToolExecutorDeps } from "./tool-executor.js";

// ── Test doubles ─────────────────────────────────────────────────────────────

/** A minimal in-memory DocumentStore substitute (avoids the global substrate/config dependency). */
function inMemoryStore() {
  const m = new Map<string, MemoryProposal>();
  return {
    get: async (id: string) => m.get(id),
    put: async (id: string, v: MemoryProposal) => void m.set(id, v),
    list: async () => [...m.keys()],
  };
}

function governor() {
  return createMemoryGovernor({ store: inMemoryStore() as never });
}

/** A fresh worktree dir. */
function worktree(): string {
  return mkdtempSync(join(tmpdir(), "ikbi-tool-exec-"));
}

/** Construct a tool call with JSON-encoded args. */
function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `c-${name}`, name, arguments: JSON.stringify(args) } as ToolCall;
}

/** A fake gbrain bridge — brain tools never reach it for governed writes. */
const fakeBridge = {
  searchBrain: (_q: string) => ({ hits: [{ title: "Page A", snippet: "a snippet" }] }),
  thinkBrain: (_q: string) => ({ answer: "synthesized answer" }),
  putPage: (_slug: string, _content: string) => "",
  syncProject: (_path: string) => ({ imported: "", embedded: "" }),
} as unknown as GbrainBridge;

/** A minimal validated identity so the governed terminal authorizes. */
const fakeCtx = { agentId: "tester", requestId: "r-1" } as unknown as OperationContext;

const baseDeps = (root: string, over?: Partial<ToolExecutorDeps>): ToolExecutorDeps => ({
  worktreeReal: root,
  agentId: "ikbi-test",
  ...over,
});

// ── 1. write_file to a governed surface → proposal ───────────────────────────

test("executeTool: write_file to CLAUDE.md becomes a memory proposal (nothing written)", async () => {
  const root = worktree();
  const gov = governor();
  const res = await executeTool(baseDeps(root, { memoryGovernor: gov }), call("write_file", { path: "CLAUDE.md", content: "# Overwritten\n" }));

  assert.equal(res.proposed, true);
  assert.match(res.output, /^PROPOSED:/);
  assert.equal(existsSync(join(root, "CLAUDE.md")), false, "the governed file must NOT be written");
  const pending = await gov.list("pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.surface, "instruction_file");
  assert.equal(pending[0]!.target, "CLAUDE.md");
  assert.equal(pending[0]!.content, "# Overwritten\n");
});

// ── 2. write_file to a non-governed path → writes ────────────────────────────

test("executeTool: write_file to a normal path writes through the governor untouched", async () => {
  const root = worktree();
  const res = await executeTool(baseDeps(root, { memoryGovernor: governor() }), call("write_file", { path: "src/x.ts", content: "export const x = 1;\n" }));

  assert.equal(res.proposed, undefined);
  assert.equal(res.ok, true);
  assert.match(res.output, /wrote \d+ bytes to src\/x\.ts/);
  assert.equal(readFileSync(join(root, "src/x.ts"), "utf8"), "export const x = 1;\n");
});

// ── 3 + 4. patch / multi_edit to a governed surface → proposal ───────────────

test("executeTool: patch to .ikbi/project.md becomes a proposal (no edit applied)", async () => {
  const root = worktree();
  const gov = governor();
  // The file does NOT need to exist — governance intercepts BEFORE runPatch reads it.
  const res = await executeTool(baseDeps(root, { memoryGovernor: gov }), call("patch", { path: ".ikbi/project.md", old_string: "a", new_string: "b" }));

  assert.equal(res.proposed, true);
  assert.match(res.output, /^PROPOSED:/);
  const pending = await gov.list("pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.surface, "project_file");
  assert.equal(pending[0]!.content, "b", "the proposal records the new text");
});

test("executeTool: multi_edit to AGENTS.md becomes a proposal", async () => {
  const root = worktree();
  const gov = governor();
  const res = await executeTool(baseDeps(root, { memoryGovernor: gov }), call("multi_edit", { path: "AGENTS.md", edits: [{ find: "x", replace: "y" }] }));

  assert.equal(res.proposed, true);
  const pending = await gov.list("pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.target, "AGENTS.md");
});

// ── 5. brain_put → proposal (never reaches the bridge) ───────────────────────

test("executeTool: brain_put becomes a proposal, not a brain write", async () => {
  const root = worktree();
  const gov = governor();
  let putCalled = false;
  const bridge = { ...fakeBridge, putPage: () => { putCalled = true; return ""; } } as unknown as GbrainBridge;
  const res = await executeTool(baseDeps(root, { memoryGovernor: gov, gbrainBridge: bridge }), call("brain_put", { slug: "notes/x", content: "# X\n" }));

  assert.equal(res.proposed, true);
  assert.match(res.output, /brain page "notes\/x"/);
  assert.equal(putCalled, false, "brain_put must NOT reach the bridge when governed");
  const pending = await gov.list("pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.surface, "brain_page");
});

// ── 6. brain_search / brain_think → pass through ─────────────────────────────

test("executeTool: brain_search passes through the governor and returns results", async () => {
  const root = worktree();
  const res = await executeTool(baseDeps(root, { memoryGovernor: governor(), gbrainBridge: fakeBridge }), call("brain_search", { query: "anything" }));

  assert.equal(res.proposed, undefined);
  assert.equal(res.ok, true);
  assert.match(res.output, /Page A/);
});

// ── 7. terminal → governed exec ──────────────────────────────────────────────

test("executeTool: terminal routes through the injected governed-exec", async () => {
  const root = worktree();
  let ran = "";
  const fakeExec = { run: async (req: { command: string }) => { ran = req.command; return { executed: true, exitCode: 0, stdoutTail: "hi" }; } };
  const res = await executeTool(
    baseDeps(root, { governedExec: fakeExec as never, parentCtx: fakeCtx }),
    call("terminal", { command: "echo hi" }),
  );

  assert.equal(ran, "echo", "the governed-exec received the binary");
  assert.equal(res.ok, true);
  assert.match(res.output, /exit 0/);
});

test("executeTool: terminal without a governed-exec fails closed", async () => {
  const root = worktree();
  const res = await executeTool(baseDeps(root), call("terminal", { command: "echo hi" }));
  assert.equal(res.ok, false);
  assert.match(res.output, /unavailable/);
});

// ── 8. read_file confinement ─────────────────────────────────────────────────

test("executeTool: read_file reads inside the worktree and rejects a traversal escape", async () => {
  const root = worktree();
  writeFileSync(join(root, "note.txt"), "hello", "utf8");

  const ok = await executeTool(baseDeps(root), call("read_file", { path: "note.txt" }));
  assert.equal(ok.ok, true);
  assert.equal(ok.output, "hello");
  assert.equal(ok.rel, "note.txt");

  const escape = await executeTool(baseDeps(root), call("read_file", { path: "../../etc/passwd" }));
  assert.equal(escape.ok, false);
  assert.match(escape.output, /escapes the worktree/);
});

// ── 9. No governor → no interception (backward compatible) ───────────────────

test("executeTool: with NO governor, a write to CLAUDE.md executes normally", async () => {
  const root = worktree();
  const res = await executeTool(baseDeps(root), call("write_file", { path: "CLAUDE.md", content: "# Real write\n" }));

  assert.equal(res.proposed, undefined);
  assert.equal(res.ok, true);
  assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), "# Real write\n");
});

// ── interceptMemoryGovernor directly (the shared chokepoint) ─────────────────

test("interceptMemoryGovernor: no governor ⇒ never intercepts", async () => {
  const root = worktree();
  const r = await interceptMemoryGovernor(baseDeps(root), call("write_file", { path: "CLAUDE.md", content: "x" }));
  assert.equal(r.intercepted, false);
});

test("interceptMemoryGovernor: a non-governed tool is never intercepted", async () => {
  const root = worktree();
  const r = await interceptMemoryGovernor(baseDeps(root, { memoryGovernor: governor() }), call("read_file", { path: "a.ts" }));
  assert.equal(r.intercepted, false);
});

test("interceptMemoryGovernor: a governed write returns the PROPOSED message + a proposal id", async () => {
  const root = worktree();
  const r = await interceptMemoryGovernor(baseDeps(root, { memoryGovernor: governor() }), call("write_file", { path: "IKBI.md", content: "x" }));
  assert.equal(r.intercepted, true);
  if (r.intercepted) {
    assert.match(r.message, /^PROPOSED:/);
    assert.ok(r.proposalId.length > 0);
  }
});

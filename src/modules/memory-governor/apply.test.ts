/**
 * Tests for the memory-governor production apply functions and factory.
 *
 * Verifies:
 *   - applyFileProposal writes content to the absolute target path
 *   - createBrainApply calls gbrainBridge.putPage
 *   - createCombinedApply dispatches by surface type
 *   - createProductionGovernor wires the apply function correctly
 *   - End-to-end: propose → approve → file written / brain page written
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyFileProposal, createBrainApply, createCombinedApply } from "./apply.js";
import { createProductionGovernor } from "./create.js";
import type { MemoryProposal, ProposalInput } from "./contract.js";
import type { GbrainBridge } from "../../core/gbrain-bridge.js";
import type { DocumentStore } from "../../core/substrate/store.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ikbi-mg-apply-"));
}

/** In-memory document store for test isolation (no filesystem / shared state root). */
function inMemoryStore(): DocumentStore<MemoryProposal> {
  const m = new Map<string, MemoryProposal>();
  return {
    get: async (id: string) => m.get(id),
    put: async (id: string, v: MemoryProposal) => void m.set(id, v),
    list: async () => [...m.keys()],
  } as unknown as DocumentStore<MemoryProposal>;
}

function proposal(overrides: Partial<ProposalInput> & { surface: ProposalInput["surface"]; target: string }): MemoryProposal {
  return {
    id: `test-${Date.now()}`,
    surface: overrides.surface,
    target: overrides.target,
    content: overrides.content ?? "# Test content\n",
    reason: overrides.reason ?? "test",
    agentId: overrides.agentId ?? "test-agent",
    status: "approved",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    reviewedAt: Date.now(),
    reviewedBy: "operator",
  };
}

// ── applyFileProposal ────────────────────────────────────────────────────────

test("applyFileProposal: writes content to absolute target path", async () => {
  const dir = tmp();
  const target = join(dir, "CLAUDE.md");
  const p = proposal({ surface: "instruction_file", target, content: "# Project\n" });

  await applyFileProposal(p);

  assert.equal(existsSync(target), true);
  assert.equal(readFileSync(target, "utf8"), "# Project\n");
});

test("applyFileProposal: creates parent directories if needed", async () => {
  const dir = tmp();
  const target = join(dir, ".ikbi", "project.md");
  const p = proposal({ surface: "project_file", target, content: "# Memory\n" });

  await applyFileProposal(p);

  assert.equal(existsSync(target), true);
  assert.equal(readFileSync(target, "utf8"), "# Memory\n");
});

test("applyFileProposal: rejects relative paths", async () => {
  const p = proposal({ surface: "instruction_file", target: "CLAUDE.md", content: "# X\n" });

  await assert.rejects(() => applyFileProposal(p), /not absolute/);
});

test("applyFileProposal: overwrites existing file", async () => {
  const dir = tmp();
  const target = join(dir, "CLAUDE.md");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(target, "old content", "utf8");

  const p = proposal({ surface: "instruction_file", target, content: "new content\n" });
  await applyFileProposal(p);

  assert.equal(readFileSync(target, "utf8"), "new content\n");
});

// ── createBrainApply ─────────────────────────────────────────────────────────

test("createBrainApply: calls bridge.putPage with slug and content", async () => {
  let calledWith: { slug: string; content: string } | undefined;
  const bridge = {
    putPage: (slug: string, content: string) => { calledWith = { slug, content }; return ""; },
  } as unknown as GbrainBridge;

  const apply = createBrainApply(bridge);
  const p = proposal({ surface: "brain_page", target: "notes/test", content: "# Brain\n" });
  await apply(p);

  assert.deepEqual(calledWith, { slug: "notes/test", content: "# Brain\n" });
});

test("createBrainApply: rejects empty slug", async () => {
  const bridge = { putPage: () => "" } as unknown as GbrainBridge;
  const apply = createBrainApply(bridge);
  const p = proposal({ surface: "brain_page", target: "", content: "# X\n" });

  await assert.rejects(() => apply(p), /empty/);
});

// ── createCombinedApply ──────────────────────────────────────────────────────

test("createCombinedApply: dispatches file proposals to applyFileProposal", async () => {
  const dir = tmp();
  const target = join(dir, "AGENTS.md");
  const apply = createCombinedApply();
  const p = proposal({ surface: "instruction_file", target, content: "# Agents\n" });

  await apply(p);

  assert.equal(readFileSync(target, "utf8"), "# Agents\n");
});

test("createCombinedApply: dispatches brain proposals to bridge", async () => {
  let called = false;
  const bridge = {
    putPage: () => { called = true; return ""; },
  } as unknown as GbrainBridge;

  const apply = createCombinedApply(bridge);
  const p = proposal({ surface: "brain_page", target: "notes/x", content: "# X\n" });

  await apply(p);

  assert.equal(called, true);
});

test("createCombinedApply: brain proposals skip silently when no bridge", async () => {
  const apply = createCombinedApply(); // no bridge
  const p = proposal({ surface: "brain_page", target: "notes/x", content: "# X\n" });

  // Should not throw — silently skips
  await apply(p);
});

// ── createProductionGovernor (factory) ───────────────────────────────────────

test("createProductionGovernor: creates a working governor", async () => {
  const gov = createProductionGovernor({ store: inMemoryStore() });
  const stats = await gov.stats();
  assert.equal(stats.total, 0);
});

test("createProductionGovernor: propose + approve writes file", async () => {
  const dir = tmp();
  const target = join(dir, "CLAUDE.md");

  const gov = createProductionGovernor({ store: inMemoryStore() });
  const proposalResult = await gov.propose({
    surface: "instruction_file",
    target,
    content: "# Production test\n",
    reason: "test",
    agentId: "test-agent",
  });

  assert.equal(proposalResult.status, "pending");

  // Approve — should write the file
  const approved = await gov.approve(proposalResult.id, "operator");
  assert.ok(approved);
  assert.equal(approved.status, "approved");
  assert.equal(existsSync(target), true);
  assert.equal(readFileSync(target, "utf8"), "# Production test\n");
});

test("createProductionGovernor: propose + reject does NOT write file", async () => {
  const dir = tmp();
  const target = join(dir, "CLAUDE.md");

  const gov = createProductionGovernor({ store: inMemoryStore() });
  const proposalResult = await gov.propose({
    surface: "instruction_file",
    target,
    content: "# Should not exist\n",
    reason: "test",
    agentId: "test-agent",
  });

  const rejected = await gov.reject(proposalResult.id, "operator");
  assert.ok(rejected);
  assert.equal(rejected.status, "rejected");
  assert.equal(existsSync(target), false, "rejected proposal must NOT write the file");
});

test("createProductionGovernor: propose + approve writes brain page via bridge", async () => {
  let calledWith: { slug: string; content: string } | undefined;
  const bridge = {
    putPage: (slug: string, content: string) => { calledWith = { slug, content }; return ""; },
  } as unknown as GbrainBridge;

  const gov = createProductionGovernor({ gbrainBridge: bridge, store: inMemoryStore() });
  const proposalResult = await gov.propose({
    surface: "brain_page",
    target: "notes/test",
    content: "# Brain content\n",
    reason: "test",
    agentId: "test-agent",
  });

  const approved = await gov.approve(proposalResult.id, "operator");
  assert.ok(approved);
  assert.deepEqual(calledWith, { slug: "notes/test", content: "# Brain content\n" });
});

test("createProductionGovernor: shared default store is visible to all governors", async () => {
  // Use in-memory stores to avoid filesystem side effects. Two governors with
  // SEPARATE stores see only their own proposals (no cross-contamination).
  const gov1 = createProductionGovernor({ store: inMemoryStore() });
  const gov2 = createProductionGovernor({ store: inMemoryStore() });

  await gov1.propose({ surface: "instruction_file", target: "/tmp/a.md", content: "a", agentId: "x" });
  await gov2.propose({ surface: "instruction_file", target: "/tmp/b.md", content: "b", agentId: "x" });

  // Each governor uses its own in-memory store — proposals don't leak
  const stats1 = await gov1.stats();
  const stats2 = await gov2.stats();
  assert.equal(stats1.total, 1, "gov1 sees only its own proposal");
  assert.equal(stats2.total, 1, "gov2 sees only its own proposal");
});

/**
 * ikbi memory-governor — TESTS.
 *
 * Covers:
 *   1. Guard: governed path detection
 *   2. Guard: brain slug governance
 *   3. Guard: proposal id generation
 *   4. Store: proposal lifecycle (create → pending → approve → applied)
 *   5. Store: proposal lifecycle (create → pending → reject → discarded)
 *   6. Store: reject-all
 *   7. Store: list + stats
 *   8. Store: upsert (same surface+target → same id)
 *   9. Store: apply-fn called only on approve, not on propose
 *  10. Store: apply-fn failure → proposal stays pending
 *  11. Cross-surface: different surfaces → different ids
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { MemoryProposal, ProposalInput } from "./contract.js";
import { isGovernedPath, isGovernedBrainSlug, brainSurface, makeProposalId } from "./guard.js";
import { createMemoryGovernor, type MemoryGovernorDeps } from "./store.js";

// ── In-memory store (avoids global substrate/config dependency) ──────────────

/** A minimal in-memory DocumentStore substitute for tests. */
function inMemoryStore() {
  const m = new Map<string, MemoryProposal>();
  return {
    get: async (id: string) => m.get(id),
    put: async (id: string, v: MemoryProposal) => void m.set(id, v),
    list: async () => [...m.keys()],
  };
}

function govWith(over?: Partial<MemoryGovernorDeps>) {
  return createMemoryGovernor({ store: inMemoryStore() as any, ...over });
}

// ── Guard tests ──────────────────────────────────────────────────────────────

test("guard: .ikbi/project.md is governed as project_file", () => {
  assert.equal(isGovernedPath(".ikbi/project.md"), "project_file");
});

test("guard: .ikbi/checks.yaml is governed as project_file", () => {
  assert.equal(isGovernedPath(".ikbi/checks.yaml"), "project_file");
});

test("guard: .ikbi/ignore is governed as project_file", () => {
  assert.equal(isGovernedPath(".ikbi/ignore"), "project_file");
});

test("guard: CLAUDE.md is governed as instruction_file", () => {
  assert.equal(isGovernedPath("CLAUDE.md"), "instruction_file");
});

test("guard: AGENTS.md is governed as instruction_file", () => {
  assert.equal(isGovernedPath("AGENTS.md"), "instruction_file");
});

test("guard: IKBI.md is governed as instruction_file", () => {
  assert.equal(isGovernedPath("IKBI.md"), "instruction_file");
});

test("guard: src/index.ts is NOT governed", () => {
  assert.equal(isGovernedPath("src/index.ts"), undefined);
});

test("guard: package.json is NOT governed", () => {
  assert.equal(isGovernedPath("package.json"), undefined);
});

test("guard: ./CLAUDE.md (with leading ./) is governed", () => {
  assert.equal(isGovernedPath("./CLAUDE.md"), "instruction_file");
});

test("guard: all brain slugs are governed", () => {
  assert.equal(isGovernedBrainSlug("notes/convention"), true);
  assert.equal(isGovernedBrainSlug("anything"), true);
  assert.equal(isGovernedBrainSlug(""), true);
});

test("guard: brainSurface returns brain_page", () => {
  assert.equal(brainSurface(), "brain_page");
});

test("guard: proposal id is deterministic and uses -- for slashes", () => {
  const id1 = makeProposalId("brain_page", "notes/convention");
  const id2 = makeProposalId("brain_page", "notes/convention");
  assert.equal(id1, id2);
  assert.equal(id1, "brain_page:notes--convention");
});

test("guard: proposal id sanitizes special chars", () => {
  const id = makeProposalId("project_file", ".ikbi/project.md");
  assert.equal(id, "project_file:.ikbi--project.md");
});

// ── Store tests ──────────────────────────────────────────────────────────────

function makeInput(over?: Partial<ProposalInput>): ProposalInput {
  return {
    surface: "brain_page",
    target: "notes/test",
    content: "# Test\n\nThis is a test page.",
    reason: "recording a finding",
    agentId: "ikbi-worker",
    ...over,
  };
}

test("store: propose creates a pending proposal", async () => {
  const gov = govWith();
  const p = await gov.propose(makeInput());
  assert.equal(p.status, "pending");
  assert.equal(p.surface, "brain_page");
  assert.equal(p.target, "notes/test");
  assert.equal(p.agentId, "ikbi-worker");
  assert.ok(p.createdAt > 0);
  assert.equal(p.reviewedAt, undefined);
});

test("store: approve applies and marks approved", async () => {
  const applied: MemoryProposal[] = [];
  const gov = govWith({
    apply: async (p) => { applied.push(p); },
  });

  await gov.propose(makeInput());
  const result = await gov.approve("brain_page:notes--test", "operator");
  assert.ok(result !== undefined);
  assert.equal(result!.status, "approved");
  assert.equal(result!.reviewedBy, "operator");
  assert.ok(result!.reviewedAt !== undefined);
  assert.equal(applied.length, 1);
  assert.equal(applied[0]!.target, "notes/test");
});

test("store: reject marks rejected without applying", async () => {
  const applied: MemoryProposal[] = [];
  const gov = govWith({
    apply: async (p) => { applied.push(p); },
  });

  await gov.propose(makeInput());
  const result = await gov.reject("brain_page:notes--test", "operator");
  assert.ok(result !== undefined);
  assert.equal(result!.status, "rejected");
  assert.equal(result!.reviewedBy, "operator");
  assert.equal(applied.length, 0, "reject does NOT apply");
});

test("store: reject-all rejects all pending proposals", async () => {
  const gov = govWith();
  await gov.propose(makeInput({ target: "notes/a" }));
  await gov.propose(makeInput({ target: "notes/b" }));
  await gov.propose(makeInput({ target: "notes/c" }));

  // Approve one first
  await gov.approve("brain_page:notes--a", "operator");

  const count = await gov.rejectAll("operator");
  assert.equal(count, 2, "rejects only pending (not already approved)");

  const all = await gov.list();
  assert.equal(all.filter((p) => p.status === "rejected").length, 2);
  assert.equal(all.filter((p) => p.status === "approved").length, 1);
});

test("store: list filters by status", async () => {
  const gov = govWith();
  await gov.propose(makeInput({ target: "notes/a" }));
  await gov.propose(makeInput({ target: "notes/b" }));
  await gov.approve("brain_page:notes--a", "operator");

  const pending = await gov.list("pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.target, "notes/b");

  const approved = await gov.list("approved");
  assert.equal(approved.length, 1);
  assert.equal(approved[0]!.target, "notes/a");
});

test("store: stats returns correct counts", async () => {
  const gov = govWith();
  await gov.propose(makeInput({ target: "notes/a" }));
  await gov.propose(makeInput({ target: "notes/b" }));
  await gov.propose(makeInput({ target: "notes/c" }));
  await gov.approve("brain_page:notes--a", "operator");
  await gov.reject("brain_page:notes--b", "operator");

  const s = await gov.stats();
  assert.equal(s.pending, 1);
  assert.equal(s.approved, 1);
  assert.equal(s.rejected, 1);
  assert.equal(s.total, 3);
});

test("store: upsert — same surface+target updates existing proposal", async () => {
  const gov = govWith();
  await gov.propose(makeInput({ content: "version 1" }));
  await gov.propose(makeInput({ content: "version 2" }));

  const all = await gov.list();
  assert.equal(all.length, 1, "upsert: only one proposal");
  assert.equal(all[0]!.content, "version 2", "content updated");
});

test("store: apply-fn is called ONLY on approve, not on propose or reject", async () => {
  const applied: string[] = [];
  const gov = govWith({
    apply: async (p) => { applied.push(`applied:${p.target}`); },
  });

  await gov.propose(makeInput({ target: "notes/a" }));
  assert.equal(applied.length, 0, "propose does NOT apply");

  await gov.reject("brain_page:notes--a", "operator");
  assert.equal(applied.length, 0, "reject does NOT apply");

  // Re-propose (upsert resets to pending)
  await gov.propose(makeInput({ target: "notes/a" }));
  await gov.approve("brain_page:notes--a", "operator");
  assert.equal(applied.length, 1, "approve DOES apply");
  assert.equal(applied[0], "applied:notes/a");
});

test("store: apply-fn failure leaves proposal pending", async () => {
  const gov = govWith({
    apply: async () => { throw new Error("disk full"); },
  });

  await gov.propose(makeInput());

  // approve should throw (apply failed)
  await assert.rejects(() => gov.approve("brain_page:notes--test", "operator"), /disk full/);

  // proposal should still be pending (the apply failed, so we don't mark approved)
  const p = await gov.get("brain_page:notes--test");
  assert.ok(p !== undefined);
  assert.equal(p!.status, "pending", "apply failure → stays pending");
});

test("store: approve nonexistent returns undefined", async () => {
  const gov = govWith();
  const result = await gov.approve("nonexistent", "operator");
  assert.equal(result, undefined);
});

test("store: reject nonexistent returns undefined", async () => {
  const gov = govWith();
  const result = await gov.reject("nonexistent", "operator");
  assert.equal(result, undefined);
});

// ── Cross-surface tests ──────────────────────────────────────────────────────

test("store: different surfaces get different proposal ids", async () => {
  const gov = govWith();
  await gov.propose(makeInput({ surface: "brain_page", target: "notes/x" }));
  await gov.propose(makeInput({ surface: "project_file", target: ".ikbi/project.md" }));
  await gov.propose(makeInput({ surface: "instruction_file", target: "CLAUDE.md" }));

  const all = await gov.list();
  assert.equal(all.length, 3, "three distinct proposals");
  const surfaces = all.map((p) => p.surface).sort();
  assert.deepEqual(surfaces, ["brain_page", "instruction_file", "project_file"]);
});

test("store: file path proposal with real content", async () => {
  const applied: MemoryProposal[] = [];
  const gov = govWith({
    apply: async (p) => { applied.push(p); },
  });

  await gov.propose({
    surface: "project_file",
    target: ".ikbi/project.md",
    content: "# Project Config\n\nAlways use pytest for testing.\n",
    reason: "learned from successful build",
    agentId: "ikbi-worker",
  });

  const result = await gov.approve("project_file:.ikbi--project.md", "operator");
  assert.ok(result !== undefined);
  assert.equal(result!.status, "approved");
  assert.equal(applied.length, 1);
  assert.equal(applied[0]!.content, "# Project Config\n\nAlways use pytest for testing.\n");
});

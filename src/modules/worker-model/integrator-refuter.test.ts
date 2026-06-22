/**
 * Codex HIGH-1: the integrator must DISCARD a build the refuter refuted, even when the
 * builder/critic/verifier all passed. A refuter result is present in priorResults only when the
 * adversarial gate ran; with no refuter result the integrator's behavior is unchanged.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentIdentity } from "../../core/identity/contract.js";
import { autonomyForTier } from "../../core/trust/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import { integrator } from "./integrator.js";
import type { RoleContext, RoleResult } from "./contract.js";

const IDENTITY: AgentIdentity = { agentId: "worker-1", functionalRole: "integrator", trustTier: "trusted", spawnedFrom: "parent-1" };

function ctxWith(priorResults: RoleResult[]): RoleContext {
  const ws: WorkspaceHandle = {
    id: "ws1", targetRepo: "/repo", baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1",
    path: "/repo", identity: IDENTITY, state: "allocated", createdAt: 0,
  };
  return {
    task: { taskId: "t-1", targetRepo: "/repo", goal: "g" },
    role: "integrator",
    identity: IDENTITY,
    autonomy: autonomyForTier("trusted"),
    workspace: ws,
    priorResults,
    engine: {
      invokeModel: async () => { throw new Error("integrator is deterministic — must not call invokeModel"); },
      neutralizeUntrusted: () => { throw new Error("integrator must not neutralize"); },
    },
  };
}

const builderOk: RoleResult = { role: "builder", outcome: "success", summary: "b", detail: { filesWritten: ["a.ts"], rejectedToolCalls: [] } };
const criticPass: RoleResult = { role: "critic", outcome: "success", summary: "c", detail: { pass: true, feedback: "ok" } };
const verifierPass: RoleResult = { role: "verifier", outcome: "success", summary: "v", detail: { verdict: "pass", checks: [], testEvidence: "executed" } };

const decisionOf = (r: RoleResult): string => (r.detail as { decision: string }).decision;
const rationaleOf = (r: RoleResult): string => (r.detail as { rationale: string }).rationale;

test("HIGH-1: builder/critic/verifier all pass but the refuter REFUTED → integrator DISCARDS", async () => {
  const refuterRefuted: RoleResult = {
    role: "refuter", outcome: "success", summary: "refutation verdict: REFUTED",
    detail: { refuted: true, feedback: "REFUTED — 1 critical finding(s): tests_actually_run", findings: [] },
  };
  const r = await integrator(ctxWith([builderOk, criticPass, verifierPass, refuterRefuted]));
  assert.equal(r.outcome, "success", "the integrator still reached a decision");
  assert.equal(decisionOf(r), "discard", "a refuted build must never promote");
  assert.match(rationaleOf(r), /refuter refuted the build/);
  assert.equal((r.detail as { evaluation: { approved: boolean } }).evaluation.approved, false);
});

test("HIGH-1: refuter present but SURVIVED (refuted=false) → integrator PROMOTES (gate is not tripped)", async () => {
  const refuterSurvived: RoleResult = {
    role: "refuter", outcome: "success", summary: "refutation verdict: SURVIVED",
    detail: { refuted: false, feedback: "not refuted", findings: [] },
  };
  const r = await integrator(ctxWith([builderOk, criticPass, verifierPass, refuterSurvived]));
  assert.equal(decisionOf(r), "promote");
});

test("HIGH-1: NO refuter result (gate disabled) → behavior unchanged (promote on green gates)", async () => {
  const r = await integrator(ctxWith([builderOk, criticPass, verifierPass]));
  assert.equal(decisionOf(r), "promote", "absent refuter result leaves the default pipeline unchanged");
});

test("HIGH-1: a refuted build is discarded even alongside other failing gates (rationale names the refutation)", async () => {
  const criticFail: RoleResult = { role: "critic", outcome: "success", summary: "c", detail: { pass: false } };
  const refuterRefuted: RoleResult = { role: "refuter", outcome: "success", summary: "REFUTED", detail: { refuted: true, feedback: "REFUTED", findings: [] } };
  const r = await integrator(ctxWith([builderOk, criticFail, verifierPass, refuterRefuted]));
  assert.equal(decisionOf(r), "discard");
  assert.match(rationaleOf(r), /critic pass=false/);
  assert.match(rationaleOf(r), /refuter refuted the build/);
});
